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

    def test_admin_can_manage_custom_uploads_without_losing_guard_evidence(self):
        self.required_records()
        options = "/api/document-options/"
        new_option = {"name": "Signed handbook", "instructions": "Upload the signed copy.", "required": True}
        self.assertEqual(self.client.post(options, new_option, format="json").status_code, 403)
        admin = get_user_model().objects.create_superuser(username="option-admin")
        self.client.force_authenticate(admin)
        self.assertEqual(self.client.post(options, {**new_option, "name": "share code"}, format="json").status_code, 400)
        created = self.client.post(options, new_option, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        option_id = created.data["id"]
        option_url = f"{options}{option_id}/"
        self.assertEqual(self.client.post(options, {**new_option, "name": "signed handbook"}, format="json").status_code, 400)

        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get(options).data, [created.data])
        self.assertEqual(documents_completion(self.employee), {"completed": 7, "required": 8, "percentage": 88})
        evidence = {"employee": self.employee.pk, "document_option": option_id}
        self.assertEqual(self.client.post("/api/documents/", evidence, format="multipart").status_code, 400)
        self.assertEqual(self.client.post("/api/documents/", {**evidence, "file_url": "https://example.com/file.pdf"}, format="json").status_code, 400)
        uploaded = self.client.post("/api/documents/", {**evidence, "file": self.file()}, format="multipart")
        self.assertEqual(uploaded.status_code, 201, uploaded.data)
        document_url = f"/api/documents/{uploaded.data['id']}/"
        self.assertEqual(self.client.post("/api/documents/", {**evidence, "file": self.file()}, format="multipart").status_code, 400)
        self.assertEqual(self.client.patch(document_url, {"document_option": None}, format="json").status_code, 400)
        self.assertEqual(documents_completion(self.employee)["percentage"], 100)

        self.client.force_authenticate(admin)
        renamed = self.client.patch(option_url, {"name": "Staff handbook", "required": False}, format="json")
        self.assertEqual(renamed.status_code, 200, renamed.data)
        self.assertEqual(self.client.get(document_url).data["document_label"], "Staff handbook")
        self.assertEqual(documents_completion(self.employee)["required"], 7)
        self.assertEqual(self.client.delete(option_url).status_code, 204)
        self.assertFalse(self.client.get(options).data[0]["is_active"])

        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get(options).data, [])
        self.assertEqual(self.client.get(document_url).status_code, 200)
        self.assertEqual(self.client.patch(document_url, {"file": self.file()}, format="multipart").status_code, 400)
        self.client.force_authenticate(admin)
        self.assertEqual(self.client.patch(option_url, {"is_active": True, "required": True}, format="json").status_code, 200)
        self.assertEqual(documents_completion(self.employee), {"completed": 8, "required": 8, "percentage": 100})

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

    def test_office_edit_accepts_blank_and_legacy_null_dates_for_optional_fields(self):
        admin = get_user_model().objects.create_superuser(username="date-editor")
        self.client.force_authenticate(admin)
        code = self.record("National Insurance Number (NI)", document_number="OLD", verification_status="VERIFIED")
        path = f"/api/documents/{code.pk}/"

        response = self.client.patch(path, {"document_number": "NEW", "issue_date": "null", "expiry_date": "null"}, format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["verification_status"], "PENDING")
        code.refresh_from_db()
        self.assertEqual(code.document_number, "NEW")
        self.assertEqual(code.file.name, "tests/evidence.pdf")
        self.assertIsNone(code.issue_date)
        self.assertIsNone(code.expiry_date)

        code.issue_date, code.expiry_date = self.today, self.future
        code.save(update_fields=["issue_date", "expiry_date"])
        response = self.client.patch(path, {"issue_date": "", "expiry_date": ""}, format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        code.refresh_from_db()
        self.assertIsNone(code.issue_date)
        self.assertIsNone(code.expiry_date)

        response = self.client.patch(path, {"issue_date": "invalid-date"}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("issue_date", response.data)

    def test_required_expiry_cannot_be_cleared(self):
        passport = self.record("Passport (First 2 pages)", expiry_date=self.future)
        response = self.client.patch(f"/api/documents/{passport.pk}/", {"expiry_date": ""}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("requires an expiry date", response.data["expiry_date"][0])
        passport.refresh_from_db()
        self.assertEqual(passport.expiry_date, self.future)

    def test_document_types_apply_their_own_date_requirements(self):
        document_types = {
            "Passport (First 2 pages)": "expiry_date", "SIA Card (Front)": "expiry_date",
            "SIA Card (Front & Back)": "expiry_date", "SIA Card (Back)": None,
            "Share Code": "expiry_date", "National Insurance Number (NI)": None,
            "CSCS Card (Front)": "expiry_date", "CSCS Card (Back)": None,
            "Proof of Address (last 3 months)": "issue_date",
            "Proof of Address 1 (last 3 months)": "issue_date",
            "Proof of Address 2 (last 3 months)": "issue_date",
            "Driving License (Front)": None, "Driving License (Back)": None,
            "Personal Photograph": None, "Right to Work": None, "PPAC Code": None,
            "ACT certificate": "expiry_date",
        }
        for document_type, required_date in document_types.items():
            with self.subTest(document_type=document_type):
                file = SimpleUploadedFile("photo.jpg", b"\xff\xd8\xffimage", content_type="image/jpeg") if document_type == "Personal Photograph" else self.file()
                response = self.client.post("/api/documents/", {
                    "employee": self.employee.pk, "document_type": document_type, "file": file,
                    "document_number": "1234", "issue_date": "", "expiry_date": "",
                }, format="multipart")
                self.assertEqual(response.status_code, 400 if required_date else 201, response.data)
                if required_date:
                    self.assertIn(required_date, response.data)

    @override_settings(FILE_UPLOAD_MAX_MEMORY_SIZE=0)
    def test_office_can_edit_old_address_notes_but_replacement_needs_a_current_issue_date(self):
        admin = get_user_model().objects.create_superuser(username="address-editor")
        self.client.force_authenticate(admin)
        proof = self.record("Proof of Address 1 (last 3 months)", issue_date=self.today - timedelta(days=93))
        path = f"/api/documents/{proof.pk}/"
        saved = self.client.patch(path, {"notes": "Archived evidence"}, format="multipart")
        self.assertEqual(saved.status_code, 200, saved.data)
        failed = self.client.patch(path, {"file": self.file(), "expiry_date": ""}, format="multipart")
        self.assertEqual(failed.status_code, 400)
        self.assertIn("issue_date", failed.data)
        replaced = self.client.patch(path, {"file": self.file(), "issue_date": self.today.isoformat(), "expiry_date": ""}, format="multipart")
        self.assertEqual(replaced.status_code, 200, replaced.data)

    def test_changing_document_type_requires_its_dates_and_resets_review(self):
        admin = get_user_model().objects.create_superuser(username="type-editor")
        self.client.force_authenticate(admin)
        document = self.record("CSCS Card (Back)", verification_status="VERIFIED")
        path = f"/api/documents/{document.pk}/"
        failed = self.client.patch(path, {"document_type": "CSCS Card (Front)"}, format="multipart")
        self.assertEqual(failed.status_code, 400)
        self.assertIn("expiry_date", failed.data)
        saved = self.client.patch(path, {"document_type": "CSCS Card (Front)", "expiry_date": self.future.isoformat()}, format="multipart")
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data["verification_status"], "PENDING")
