from datetime import date

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import AuditLog, Employee, EmployeeDocument, UserProfile
from .serializers import EmployeeSerializer


class GuardProfileWizardTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.guard = User.objects.create_user(username="wizard@example.com", email="wizard@example.com")
        self.other = User.objects.create_user(username="other-wizard@example.com")
        self.admin = User.objects.create_superuser(username="wizard-admin", email="admin@example.com", password="test-only")
        for user in (self.guard, self.other):
            UserProfile.objects.update_or_create(user=user, defaults={"role": "EMPLOYEE"})
        self.employee = Employee.objects.create(employee_id="WIZ-1", name="Profile Wizard Guard", email=self.guard.email, user=self.guard)
        self.other_employee = Employee.objects.create(employee_id="WIZ-2", name="Other Wizard Guard", email="other-wizard@example.com", user=self.other)
        self.details = {"name": self.employee.name, "date_of_birth": "1990-02-03", "nationality": "United Kingdom", "phone": "+447700900123", "email": self.guard.email, "address": "Test address", "emergency_contact_name": "Emergency Contact", "emergency_contact_phone": "+447700900456", "emergency_contact_relationship": "Sibling"}
        self.client.force_authenticate(self.guard)

    def photo(self):
        return EmployeeDocument.objects.create(employee=self.employee, document_type="Personal Photograph", file="profile/portrait.jpg", created_by=self.guard)

    def submit(self, **overrides):
        return self.client.post("/api/employees/submit-profile/", {**self.details, "declaration_accepted": True, **overrides}, format="json")

    def test_drafts_save_without_declaration_and_percentage_includes_picture(self):
        response = self.client.patch("/api/employees/me/", self.details, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["profile_completion"], 82)
        self.assertIsNone(response.data["profile_declaration_accepted_at"])
        self.photo()
        response = self.client.get("/api/employees/me/")
        self.assertEqual(response.data["profile_completion"], 91)
        self.assertIsNone(response.data["joining_date"])

    def test_final_submit_requires_explicit_confirmation_and_actual_picture_record(self):
        for accepted in (False, "true", None):
            response = self.submit(declaration_accepted=accepted)
            self.assertEqual(response.status_code, 400)
        EmployeeDocument.objects.create(employee=self.employee, document_type="Personal Photograph", file_url="https://example.com/photo.jpg", created_by=self.guard)
        response = self.submit()
        self.assertEqual(response.status_code, 400)
        self.assertIn("profile picture", response.data["detail"])
        self.employee.refresh_from_db()
        self.assertEqual(self.employee.phone, "")

    def test_incomplete_submission_never_partially_saves_profile(self):
        self.photo()
        for field in self.details:
            for value in ("", " \t "):
                with self.subTest(field=field, value=value):
                    response = self.submit(**{field: value})
                    self.assertEqual(response.status_code, 400, response.data)
                    self.employee.refresh_from_db()
                    self.assertIsNone(self.employee.date_of_birth)
                    self.assertIsNone(self.employee.profile_declaration_accepted_at)
        self.assertFalse(AuditLog.objects.filter(action="PROFILE_SUBMIT").exists())

    def test_submission_records_confirmation_time_and_profile_snapshot(self):
        photo = self.photo()
        response = self.submit()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["profile_completion"], 100)
        self.assertEqual(response.data["profile_declaration_version"], "v1")
        self.assertIsNotNone(response.data["profile_declaration_accepted_at"])
        self.assertIn("true and correct", response.data["profile_declaration_text"])
        audit = AuditLog.objects.get(action="PROFILE_SUBMIT", object_id=str(self.employee.pk))
        self.assertEqual(audit.user, self.guard)
        self.assertEqual(audit.after_data["photo_document_id"], photo.pk)
        self.assertEqual(audit.after_data["profile"]["nationality"], "United Kingdom")

    def test_guard_cannot_submit_another_guard_or_change_office_fields(self):
        self.photo()
        for extra in ({"employee": self.other_employee.pk}, {"joining_date": "2026-11-03"}, {"profile_declaration_accepted_at": timezone.now().isoformat()}):
            self.assertEqual(self.submit(**extra).status_code, 400)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.submit().status_code, 400)
        self.employee.refresh_from_db()
        self.assertIsNone(self.employee.profile_declaration_accepted_at)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.submit().status_code, 403)

    def test_changes_to_personal_details_require_new_confirmation(self):
        self.photo()
        self.assertEqual(self.submit().status_code, 200)
        unchanged = self.client.patch("/api/employees/me/", {"phone": self.details["phone"]}, format="json")
        self.assertEqual(unchanged.data["profile_completion"], 100)
        changed = self.client.patch("/api/employees/me/", {"phone": "+447700900789"}, format="json")
        self.assertEqual(changed.data["profile_completion"], 91)
        self.assertIsNone(changed.data["profile_declaration_accepted_at"])
        self.assertEqual(changed.data["profile_declaration_version"], "")

    def test_photo_review_preserves_declaration_but_replacement_and_deletion_reset_it(self):
        photo = self.photo()
        self.assertEqual(self.submit().status_code, 200)
        photo.verification_status = "VERIFIED"
        photo.save(update_fields=["verification_status"])
        self.employee.refresh_from_db()
        self.assertIsNotNone(self.employee.profile_declaration_accepted_at)
        photo.file = "profile/replacement.jpg"
        photo.save()
        self.employee.refresh_from_db()
        self.assertIsNone(self.employee.profile_declaration_accepted_at)
        self.assertEqual(self.submit().status_code, 200)
        photo.delete()
        self.employee.refresh_from_db()
        self.assertIsNone(self.employee.profile_declaration_accepted_at)
        self.assertEqual(EmployeeSerializer(self.employee).data["profile_completion"], 82)

    def test_unrelated_document_uploads_do_not_reset_profile_confirmation(self):
        self.photo()
        self.assertEqual(self.submit().status_code, 200)
        document = EmployeeDocument.objects.create(employee=self.employee, document_type="Passport", file="documents/passport.pdf", created_by=self.guard)
        document.notes = "Office review"
        document.save()
        document.delete()
        self.employee.refresh_from_db()
        self.assertIsNotNone(self.employee.profile_declaration_accepted_at)
