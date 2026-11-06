from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Employee, EmployeeDocument, Notification, RotaAssignment, RotaWeek, ShiftType, Site, SiteInduction, UserProfile


class RotaDocumentExpiryTests(APITestCase):
    def setUp(self):
        users = get_user_model().objects
        self.admin = users.create_user(username="expiry-admin", is_superuser=True)
        self.guard_user = users.create_user(username="expiry-guard")
        UserProfile.objects.update_or_create(user=self.guard_user, defaults={"role": UserProfile.Role.EMPLOYEE})
        self.guard = Employee.objects.create(
            employee_id="EXP-1", name="Riley Guard", nationality="Pakistani", user=self.guard_user,
        )
        self.today = date(2026, 11, 6)
        clock = patch("django.utils.timezone.now", return_value=timezone.make_aware(datetime.combine(self.today, time(12))))
        clock.start()
        self.addCleanup(clock.stop)
        self.monday = date(2026, 11, 9)
        self.week = RotaWeek.objects.create(week_start=self.monday, created_by=self.admin)
        self.site = Site.objects.create(site_id="EXP-SITE", name="Expiry test site")
        self.shift = ShiftType.objects.create(name="Expiry day", start_time=time(8), end_time=time(20))
        self.complete_induction(self.site)
        self.valid_until = self.monday + timedelta(days=30)
        self.documents = {
            label: EmployeeDocument.objects.create(
                employee=self.guard, document_type=label, expiry_date=self.valid_until,
                verification_status=EmployeeDocument.VerificationStatus.VERIFIED,
                file="fixtures/synthetic.pdf", created_by=self.admin,
            )
            for label in ("Passport (First 2 pages)", "SIA Card (Front)", "SIA Card (Back)", "Share Code", "Right to Work")
        }
        self.client.force_authenticate(self.admin)

    def complete_induction(self, site):
        SiteInduction.objects.create(
            site=site, employee=self.guard, induction_date=self.today,
            created_by=self.admin, status=SiteInduction.Status.COMPLETED,
        )

    def expiry(self, label, value):
        document = self.documents[label]
        document.expiry_date = value
        document.save(update_fields=["expiry_date"])

    def assignment_payload(self):
        return {
            "employee": self.guard.pk, "rota_week": self.week.pk, "work_date": self.monday.isoformat(),
            "site": self.site.pk, "shift_type": self.shift.pk,
        }

    def existing_assignment(self):
        return RotaAssignment.objects.create(
            rota_week=self.week, work_date=self.monday, site=self.site, shift_type=self.shift,
            employee=self.guard, created_by=self.admin,
        )

    def test_each_expired_document_blocks_new_assignment_with_a_named_warning(self):
        for label in self.documents:
            with self.subTest(label=label):
                self.expiry(label, self.today - timedelta(days=1))
                response = self.client.post("/api/assignments/", self.assignment_payload(), format="json")
                self.assertEqual(response.status_code, 400, response.data)
                self.assertIn(f"Riley Guard: {label} expired on 05 Nov 2026.", response.data["employee"][0])
                self.expiry(label, self.valid_until)
        self.assertFalse(RotaAssignment.objects.exists())

    def test_bulk_assignment_uses_the_last_working_day_of_an_overnight_shift(self):
        self.shift.start_time, self.shift.end_time = time(20), time(8)
        self.shift.save(update_fields=["start_time", "end_time"])
        self.expiry("Passport (First 2 pages)", self.monday)
        payload = {**self.assignment_payload(), "employee_ids": [self.guard.pk]}
        response = self.client.post(f"/api/rota-weeks/{self.week.pk}/bulk_assign/", payload, format="json")
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn("Riley Guard: Passport (First 2 pages) expires on 09 Nov 2026", response.data["detail"])
        self.assertIn("10 Nov 2026", response.data["detail"])
        self.assertFalse(RotaAssignment.objects.exists())

    def test_publishing_rechecks_saved_assignments_and_allows_renewed_documents(self):
        self.existing_assignment()
        self.expiry("Right to Work", self.today - timedelta(days=1))
        publish_path = f"/api/rota-weeks/{self.week.pk}/publish/"
        blocked = self.client.post(publish_path, {}, format="json")
        self.assertEqual(blocked.status_code, 400, blocked.data)
        self.assertIn("Riley Guard: Right to Work expired", blocked.data["detail"])
        self.assertFalse(Notification.objects.filter(link="rota").exists())
        bypass = self.client.patch(f"/api/rota-weeks/{self.week.pk}/", {"status": "PUBLISHED"}, format="json")
        self.assertEqual(bypass.status_code, 400)
        self.week.refresh_from_db()
        self.assertEqual(self.week.status, RotaWeek.Status.DRAFT)

        self.expiry("Right to Work", self.monday)
        self.assertEqual(self.client.post(publish_path, {}, format="json").status_code, 200)
        self.assertTrue(Notification.objects.filter(user=self.guard_user, title="Your rota is published").exists())

    def test_copy_and_site_move_cannot_bypass_expiry(self):
        assignment = self.existing_assignment()
        next_week = self.monday + timedelta(days=7)
        self.expiry("SIA Card (Front)", self.monday)
        blocked_copy = self.client.post(f"/api/rota-weeks/{self.week.pk}/copy_to/", {
            "week_start": next_week.isoformat(),
        }, format="json")
        self.assertEqual(blocked_copy.status_code, 400)
        self.assertIn("SIA Card (Front) expires", blocked_copy.data["detail"])
        self.assertFalse(RotaWeek.objects.filter(week_start=next_week).exists())

        target_site = Site.objects.create(site_id="EXP-TARGET", name="Expiry target site")
        self.complete_induction(target_site)
        self.expiry("Right to Work", self.today - timedelta(days=1))
        blocked_move = self.client.post(f"/api/assignments/{assignment.pk}/move_to_site/", {"site": target_site.pk}, format="json")
        self.assertEqual(blocked_move.status_code, 400)
        self.assertIn("Right to Work expired", blocked_move.data["detail"])
        assignment.refresh_from_db()
        self.assertEqual(assignment.site_id, self.site.pk)

    def test_optional_right_to_work_without_expiry_and_unrelated_expiry_are_allowed(self):
        self.existing_assignment()
        self.expiry("Right to Work", None)
        EmployeeDocument.objects.create(
            employee=self.guard, document_type="CSCS Card (Front)",
            expiry_date=self.today - timedelta(days=1), created_by=self.admin,
        )
        response = self.client.post(f"/api/rota-weeks/{self.week.pk}/publish/", {}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
