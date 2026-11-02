from datetime import timedelta
from tempfile import TemporaryDirectory

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .document_requirements import document_requirements, documents_completion
from .models import Employee, EmployeeDocument, UserProfile
from .serializers import employee_compliance_issues


class GuardDocumentWizardTests(APITestCase):
    def setUp(self):
        self.media = TemporaryDirectory()
        self.settings = override_settings(MEDIA_ROOT=self.media.name)
        self.settings.enable()
        self.addCleanup(self.media.cleanup)
        self.addCleanup(self.settings.disable)
        self.guard = get_user_model().objects.create_user(username="documents@example.com")
        UserProfile.objects.update_or_create(user=self.guard, defaults={"role": "EMPLOYEE"})
        self.employee = Employee.objects.create(employee_id="DOC-1", name="Document Wizard Guard", nationality="Pakistani", user=self.guard)
        self.client.force_authenticate(self.guard)
        self.today = timezone.localdate()
        self.future = self.today + timedelta(days=365)

    def file(self):
        return SimpleUploadedFile("certificate.pdf", b"%PDF-1.4\nSynthetic test document", content_type="application/pdf")

    def record(self, document_type, **kwargs):
        return EmployeeDocument.objects.create(employee=self.employee, document_type=document_type, created_by=self.guard, file="tests/evidence.pdf", **kwargs)

    def required_records(self):
        for key, aliases, kind in document_requirements(self.employee.nationality):
            self.record(aliases[0], document_number="123456", issue_date=self.today, expiry_date=self.future)

    def certificate(self, **kwargs):
        return self.client.post("/api/documents/", {"employee": self.employee.pk, "document_type": "Certificates", "certificate_type": "NASDU", "file": self.file(), **kwargs}, format="multipart")

    def test_required_documents_reach_100_with_only_one_address_and_no_optional_uploads(self):
        self.assertEqual(documents_completion(self.employee)["percentage"], 0)
        self.required_records()
        expected = {"completed": 7, "required": 7, "percentage": 100}
        self.assertEqual(documents_completion(self.employee), expected)
        self.assertEqual(self.client.get("/api/employees/me/").data["documents_completion"], expected)
        proof = self.employee.documents.get(document_type="Proof of Address (last 3 months)")
        for previous_name in ("Proof of Address 1 (last 3 months)", "Proof of Address 2 (last 3 months)"):
            proof.document_type = previous_name
            proof.save()
            self.assertEqual(documents_completion(self.employee), expected)

    def test_british_share_code_exemption_applies_to_progress_and_rota_checks(self):
        for nationality in ("British", "United Kingdom", "UK", " british "):
            self.employee.nationality = nationality
            self.assertEqual(documents_completion(self.employee)["required"], 6)
            self.assertFalse(any("Share Code" in issue for issue in employee_compliance_issues(self.employee)))
        self.employee.nationality = "Pakistani"
        self.assertIn("Share Code is missing", employee_compliance_issues(self.employee))

    def test_empty_rejected_expired_and_incomplete_records_do_not_count(self):
        passport = self.record("Passport (First 2 pages)", expiry_date=self.future)
        self.assertEqual(documents_completion(self.employee)["completed"], 1)
        for changes in ({"file": ""}, {"file": "tests/evidence.pdf", "verification_status": "REJECTED"}, {"verification_status": "PENDING", "expiry_date": self.today - timedelta(days=1)}):
            for field, value in changes.items():
                setattr(passport, field, value)
            passport.save()
            self.assertEqual(documents_completion(self.employee)["completed"], 0)
        self.record("Proof of Address (last 3 months)", issue_date=self.today - timedelta(days=93))
        self.record("SIA Card (Front)", expiry_date=self.future)
        self.assertEqual(documents_completion(self.employee)["completed"], 0)

    def test_multiple_certificates_of_same_type_are_saved_and_visible_to_admin(self):
        for _ in range(2):
            response = self.certificate()
            self.assertEqual(response.status_code, 201, response.data)
            self.assertEqual(response.data["certificate_type"], "NASDU")
        self.assertEqual(self.employee.documents.filter(document_type="Certificates").count(), 2)
        admin = get_user_model().objects.create_superuser(username="document-admin", password="test-only")
        self.client.force_authenticate(admin)
        response = self.client.get("/api/documents/")
        self.assertEqual(len(response.data), 2)
        self.assertTrue(all(item["certificate_type"] == "NASDU" for item in response.data))

    def test_certificate_validation_and_other_name(self):
        for overrides in ({"certificate_type": ""}, {"certificate_type": "INVALID"}, {"certificate_type": "OTHER", "certificate_name": " "}, {"certificate_type": "ACT"}):
            response = self.certificate(**overrides)
            self.assertEqual(response.status_code, 400, response.data)
        response = self.certificate(certificate_type="OTHER", certificate_name="First aid")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["certificate_name"], "First aid")
        self.assertEqual(self.certificate(certificate_type="ACT", expiry_date=self.future.isoformat()).status_code, 201)
        no_file = self.client.post("/api/documents/", {"employee": self.employee.pk, "document_type": "Certificates", "certificate_type": "NASDU"}, format="json")
        self.assertEqual(no_file.status_code, 400)

    def test_one_new_address_proof_is_valid_and_old_sia_combined_file_still_counts(self):
        response = self.client.post("/api/documents/", {"employee": self.employee.pk, "document_type": "Proof of Address (last 3 months)", "issue_date": self.today.isoformat(), "file": self.file()}, format="multipart")
        self.assertEqual(response.status_code, 201, response.data)
        self.record("SIA Card (Front & Back)", document_number="1234", expiry_date=self.future)
        self.assertEqual(documents_completion(self.employee)["completed"], 3)

    def test_code_only_update_resets_verification_and_guard_cannot_access_another_guard(self):
        code = self.record("National Insurance Number (NI)", document_number="OLD", verification_status="VERIFIED")
        response = self.client.patch(f"/api/documents/{code.pk}/", {"document_number": "NEW"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["verification_status"], "PENDING")
        other = Employee.objects.create(employee_id="DOC-2", name="Other Document Guard")
        response = self.certificate(employee=other.pk)
        self.assertEqual(response.status_code, 403)
        self.assertFalse(other.documents.exists())
