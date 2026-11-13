from datetime import date, time, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import Employee, GuardUnavailability, LeaveRecord, RotaAssignment, RotaWeek, ShiftType, Site, SiteInduction, UserProfile


class RotaPlanningTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user(username="planner", is_superuser=True)
        self.client.force_authenticate(self.admin)
        self.monday = date(2026, 11, 16)
        self.week = RotaWeek.objects.create(week_start=self.monday, created_by=self.admin)
        self.site = Site.objects.create(site_id="PL-1", name="Century Court", required_guards=1)
        self.other_site = Site.objects.create(site_id="PL-2", name="West Gate", required_guards=1)
        self.day = ShiftType.objects.create(name="Planner Day", start_time=time(7), end_time=time(19))
        self.night = ShiftType.objects.create(name="Planner Night", start_time=time(19), end_time=time(8))
        self.guard = Employee.objects.create(employee_id="PL-G1", name="Riley Guard")
        self.cover = Employee.objects.create(employee_id="PL-G2", name="Casey Cover")
        for employee in (self.guard, self.cover):
            for site in (self.site, self.other_site):
                SiteInduction.objects.create(site=site, employee=employee, induction_date=self.monday,
                    status=SiteInduction.Status.COMPLETED, created_by=self.admin)
        for path in (
            "core.rota_planning.employee_compliance_issues", "core.views.employee_compliance_issues",
            "core.serializers.employee_compliance_issues", "core.views.generate_daily_arrival_reports",
        ):
            mock = patch(path, return_value=[])
            mock.start()
            self.addCleanup(mock.stop)

    def post(self, action, **payload):
        return self.client.post(f"/api/rota-weeks/{self.week.pk}/{action}/", payload, format="json")

    def add_shift(self, employee, day, *, week=None, site=None, shift=None):
        return RotaAssignment.objects.create(
            rota_week=week or self.week, site=site or self.site, shift_type=shift or self.day,
            employee=employee, work_date=day, created_by=self.admin,
        )

    def test_multi_day_preview_saves_only_eligible_dates_and_checks_overnight(self):
        tuesday = self.monday + timedelta(days=1)
        wednesday = tuesday + timedelta(days=1)
        self.add_shift(self.guard, self.monday, site=self.other_site, shift=self.night)
        GuardUnavailability.objects.create(employee=self.guard, work_date=wednesday)
        request = {"site": self.site.pk, "shift_type": self.day.pk, "employee": self.guard.pk,
                   "dates": [str(tuesday), str(wednesday), str(wednesday + timedelta(days=1))]}
        preview = self.post("assign_days", **request, preview=True)
        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data["ready"], 1)
        self.assertIn("West Gate", preview.data["rows"][0]["reason"])
        self.assertIn("unavailable", preview.data["rows"][1]["reason"])
        self.assertEqual(RotaAssignment.objects.count(), 1)
        saved = self.post("assign_days", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(saved.data["created"], 1)
        self.assertEqual(RotaAssignment.objects.get(site=self.site).work_date, wednesday + timedelta(days=1))

    def test_copy_selected_sites_preserves_target_and_skips_approved_leave(self):
        target_date = self.monday + timedelta(days=7)
        target = RotaWeek.objects.create(week_start=target_date, created_by=self.admin)
        existing = self.add_shift(self.cover, target_date, week=target)
        for offset in range(3):
            self.add_shift(self.guard, self.monday + timedelta(days=offset))
        self.add_shift(self.guard, self.monday, site=self.other_site, shift=self.night)
        LeaveRecord.objects.create(employee=self.guard, status=LeaveRecord.Status.APPROVED,
                                   start_date=target_date + timedelta(days=1),
                                   end_date=target_date + timedelta(days=1), created_by=self.admin)
        request = {"week_start": str(target_date), "site_ids": [self.site.pk]}
        preview = self.post("copy_to", **request, preview=True)
        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual([row["status"] for row in preview.data["rows"]], ["preserved", "skipped", "ready"])
        self.assertIn("approved leave", preview.data["rows"][1]["reason"])
        self.assertEqual(target.assignments.count(), 1)
        saved = self.post("copy_to", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(saved.data["created"], 1)
        self.assertTrue(target.assignments.filter(pk=existing.pk).exists())
        self.assertEqual(target.assignments.count(), 2)
        retry = self.post("copy_to", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(target.assignments.count(), 2)

    def test_copy_preview_does_not_create_a_week_and_commit_creates_draft(self):
        self.add_shift(self.guard, self.monday)
        next_week = str(self.monday + timedelta(days=7))
        preview = self.post("copy_to", week_start=next_week, preview=True)
        self.assertEqual(preview.data["ready"], 1)
        self.assertFalse(RotaWeek.objects.filter(week_start=next_week).exists())
        saved = self.post("copy_to", week_start=next_week, preview_key=preview.data["preview_key"])
        self.assertEqual(saved.data["created"], 1)
        self.assertEqual(RotaWeek.objects.get(week_start=next_week).status, RotaWeek.Status.DRAFT)

    def test_find_cover_filters_ineligible_guards_and_rechecks_open_position(self):
        GuardUnavailability.objects.create(employee=self.guard, work_date=self.monday)
        slot = {"site": self.site.pk, "shift_type": self.day.pk, "work_date": str(self.monday)}
        response = self.post("eligible_guards", **slot)
        self.assertEqual([row["id"] for row in response.data], [self.cover.pk])
        request = {"site": self.site.pk, "shift_type": self.day.pk, "dates": [str(self.monday)],
                   "employee": self.cover.pk, "cover_only": True}
        preview = self.post("assign_days", **request, preview=True)
        self.assertEqual(preview.data["ready"], 1)
        self.add_shift(self.guard, self.monday)
        changed = self.post("assign_days", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(changed.status_code, 409)
        self.assertIn("already covered", changed.data["rows"][0]["reason"])
        self.assertEqual(RotaAssignment.objects.count(), 1)

    def test_bulk_guard_list_shows_only_active_inducted_guards_with_blockers(self):
        leave = Employee.objects.create(employee_id="PL-G3", name="On Leave")
        overlap = Employee.objects.create(employee_id="PL-G4", name="Already Booked")
        other_site_only = Employee.objects.create(employee_id="PL-G5", name="Other Site Guard")
        inactive = Employee.objects.create(employee_id="PL-G6", name="Inactive Guard", status=Employee.Status.INACTIVE)
        for employee, site, induction_status in (
            (leave, self.site, SiteInduction.Status.COMPLETED),
            (overlap, self.site, SiteInduction.Status.COMPLETED),
            (other_site_only, self.other_site, SiteInduction.Status.COMPLETED),
            (other_site_only, self.site, SiteInduction.Status.PLANNED),
            (inactive, self.site, SiteInduction.Status.COMPLETED),
        ):
            SiteInduction.objects.create(site=site, employee=employee, induction_date=self.monday,
                status=induction_status, created_by=self.admin)
        GuardUnavailability.objects.create(employee=self.guard, work_date=self.monday)
        LeaveRecord.objects.create(employee=leave, status=LeaveRecord.Status.APPROVED,
                                   start_date=self.monday, end_date=self.monday, created_by=self.admin)
        self.add_shift(overlap, self.monday, site=self.other_site)

        inducted = self.post("inducted_guards", site=self.site.pk)
        self.assertEqual(inducted.status_code, 200, inducted.data)
        self.assertEqual({row["id"] for row in inducted.data}, {self.guard.pk, self.cover.pk, leave.pk, overlap.pk})
        result = self.post("eligible_guards", site=self.site.pk, shift_type=self.day.pk,
                           work_date=str(self.monday), include_blocked=True)
        self.assertEqual(result.status_code, 200, result.data)
        rows = {row["id"]: row["blocked_reason"] for row in result.data}
        self.assertEqual(rows.keys(), {row["id"] for row in inducted.data})
        self.assertIn("unavailable", rows[self.guard.pk])
        self.assertIn("approved leave", rows[leave.pk])
        self.assertIn(self.other_site.name, rows[overlap.pk])
        self.assertEqual(rows[self.cover.pk], "")
        self.assertEqual(RotaAssignment.objects.count(), 1)

    def test_manager_can_copy_only_managed_sites(self):
        manager = get_user_model().objects.create_user(username="planner-manager")
        profile, _ = UserProfile.objects.update_or_create(user=manager, defaults={"role": UserProfile.Role.MANAGER})
        profile.managed_sites.add(self.site)
        self.add_shift(self.guard, self.monday)
        self.add_shift(self.cover, self.monday, site=self.other_site)
        self.client.force_authenticate(manager)
        target = str(self.monday + timedelta(days=7))
        preview = self.post("copy_to", week_start=target, preview=True)
        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual([row["site_name"] for row in preview.data["rows"]], [self.site.name])
        restricted = self.post("copy_to", week_start=target, site_ids=[self.other_site.pk], preview=True)
        self.assertEqual(restricted.status_code, 403)

    def test_publish_review_reports_conflicts_without_publishing(self):
        self.add_shift(self.guard, self.monday)
        GuardUnavailability.objects.create(employee=self.guard, work_date=self.monday)
        review = self.post("publish", preview=True)
        self.assertEqual(review.status_code, 200)
        self.assertIn("unavailable", review.data["conflicts"][0])
        self.week.refresh_from_db()
        self.assertEqual(self.week.status, RotaWeek.Status.DRAFT)
