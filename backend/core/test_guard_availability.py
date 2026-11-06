from datetime import date, time, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import Employee, GuardUnavailability, RotaAssignment, RotaWeek, ShiftType, Site, SiteInduction, UserProfile


class GuardAvailabilityTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user(username="availability-admin", is_superuser=True)
        self.guard_user = get_user_model().objects.create_user(username="availability-guard")
        UserProfile.objects.update_or_create(user=self.guard_user, defaults={"role": UserProfile.Role.EMPLOYEE})
        self.guard = Employee.objects.create(employee_id="AV-1", name="Riley Guard", user=self.guard_user)
        self.other = Employee.objects.create(employee_id="AV-2", name="Other Guard")
        self.monday = date(2026, 11, 9)
        self.week = RotaWeek.objects.create(week_start=self.monday, created_by=self.admin)
        self.site = Site.objects.create(site_id="AV-SITE", name="Availability site")
        self.shift = ShiftType.objects.create(name="Availability night", start_time=time(20), end_time=time(8))
        for employee in (self.guard, self.other):
            SiteInduction.objects.create(
                site=self.site, employee=employee, induction_date=self.monday,
                created_by=self.admin, status=SiteInduction.Status.COMPLETED,
            )
        self.client.force_authenticate(self.admin)

    def mark_day(self, work_date, unavailable=True):
        return self.client.put("/api/guard-availability/", {
            "employee": self.guard.pk, "work_date": work_date.isoformat(), "unavailable": unavailable,
        }, format="json")

    def assignment_payload(self, work_date):
        return {
            "employee": self.guard.pk, "rota_week": self.week.pk, "work_date": work_date.isoformat(),
            "site": self.site.pk, "shift_type": self.shift.pk,
        }

    def test_calendar_records_are_idempotent_and_admin_managed(self):
        self.assertEqual(self.mark_day(self.monday).status_code, 200)
        self.assertEqual(self.mark_day(self.monday).status_code, 200)
        self.assertEqual(GuardUnavailability.objects.count(), 1)
        self.mark_day(self.monday + timedelta(days=8))
        response = self.client.get(f"/api/guard-availability/?week_start={self.monday}")
        self.assertEqual(response.data, [{"employee": self.guard.pk, "work_date": self.monday}])
        self.client.force_authenticate(self.guard_user)
        self.assertEqual(self.client.get(f"/api/guard-availability/?week_start={self.monday}").status_code, 403)
        self.assertEqual(self.mark_day(self.monday, False).status_code, 403)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.mark_day(self.monday, False).status_code, 200)
        self.assertFalse(GuardUnavailability.objects.filter(work_date=self.monday).exists())

    def test_overnight_shifts_cannot_enter_an_unavailable_day_but_can_end_at_midnight(self):
        sunday = self.monday + timedelta(days=6)
        following_monday = sunday + timedelta(days=1)
        self.mark_day(following_monday)
        with (
            patch("core.serializers.employee_compliance_issues", return_value=[]),
            patch("core.views.generate_daily_arrival_reports", return_value=[]),
        ):
            response = self.client.post("/api/assignments/", self.assignment_payload(sunday), format="json")
            self.assertEqual(response.status_code, 400)
            self.assertIn("Riley Guard is unavailable on 16 Nov 2026.", str(response.data))
            allowed = self.client.post("/api/assignments/", {
                **self.assignment_payload(sunday), "scheduled_end": "00:00",
            }, format="json")
            self.assertEqual(allowed.status_code, 201, allowed.data)
            rejected_edit = self.client.patch(
                f"/api/assignments/{allowed.data['id']}/", {"scheduled_end": "08:00"}, format="json",
            )
            self.assertEqual(rejected_edit.status_code, 400)
        self.assertEqual(RotaAssignment.objects.get().scheduled_end, time.min)

    def test_bulk_assignment_reports_the_guard_and_saves_no_partial_batch(self):
        self.mark_day(self.monday)
        payload = self.assignment_payload(self.monday)
        payload["employee_ids"] = [self.other.pk, self.guard.pk]
        with patch("core.serializers.employee_compliance_issues", return_value=[]):
            response = self.client.post(f"/api/rota-weeks/{self.week.pk}/bulk_assign/", payload, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Riley Guard is unavailable", response.data["detail"])
        self.assertFalse(RotaAssignment.objects.exists())

    def test_availability_blocks_publication_and_copy_preserves_existing_target(self):
        RotaAssignment.objects.create(
            rota_week=self.week, employee=self.guard, site=self.site,
            shift_type=self.shift, work_date=self.monday, created_by=self.admin,
        )
        next_monday = self.monday + timedelta(days=7)
        target = RotaWeek.objects.create(week_start=next_monday, created_by=self.admin)
        preserved = RotaAssignment.objects.create(
            rota_week=target, employee=self.other, site=self.site,
            shift_type=self.shift, work_date=next_monday, created_by=self.admin,
        )
        self.mark_day(self.monday)
        self.mark_day(next_monday)
        publish = self.client.post(f"/api/rota-weeks/{self.week.pk}/publish/", {}, format="json")
        copy = self.client.post(f"/api/rota-weeks/{self.week.pk}/copy_to/", {"week_start": next_monday.isoformat()}, format="json")
        self.assertEqual(publish.status_code, 400)
        self.assertEqual(copy.status_code, 400)
        self.assertIn("Riley Guard is unavailable on 09 Nov 2026.", str(publish.data))
        self.assertIn("Riley Guard is unavailable on 16 Nov 2026.", str(copy.data))
        self.week.refresh_from_db()
        self.assertEqual(self.week.status, RotaWeek.Status.DRAFT)
        self.assertEqual(list(target.assignments.values_list("id", flat=True)), [preserved.pk])
