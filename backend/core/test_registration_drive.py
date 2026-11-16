from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .google_drive import DRIVE_FOLDER_MIME, encrypt_refresh_token
from .models import Employee, EmployeeDocument, GoogleDriveConnection, GuardComplianceRegistration, Site, SiteInduction, UserProfile


@override_settings(GOOGLE_DRIVE_CLIENT_ID="test-client", GOOGLE_DRIVE_CLIENT_SECRET="test-secret")
class GuardExportDriveUploadTests(APITestCase):
    def setUp(self):
        users = get_user_model().objects
        self.admin = users.create_user("registration-office", is_superuser=True)
        self.guard = users.create_user("registration-guard")
        UserProfile.objects.create(user=self.guard, role=UserProfile.Role.EMPLOYEE)
        self.employee = Employee.objects.create(employee_id="REG-1", name="Renamed Guard", user=self.guard)
        self.registration = GuardComplianceRegistration.objects.create(
            employee=self.employee, status=GuardComplianceRegistration.Status.APPROVED, approved_at=timezone.now(),
        )
        self.connection = GoogleDriveConnection.objects.create(
            root_folder_id="guard-documents-root", encrypted_refresh_token=encrypt_refresh_token("test-refresh"),
        )
        self.url = f"/api/compliance-approvals/{self.registration.pk}/sync-drive/"
        self.client.force_authenticate(self.admin)

    def existing_folder_service(self):
        EmployeeDocument.objects.create(
            employee=self.employee, document_type="Passport", created_by=self.admin,
            drive_folder_id="existing-guard-folder", drive_root_folder_id=self.connection.root_folder_id,
        )
        service = MagicMock()
        service.files().get().execute.return_value = {
            "mimeType": DRIVE_FOLDER_MIME, "parents": [self.connection.root_folder_id],
            "trashed": False, "capabilities": {"canAddChildren": True},
        }
        return service

    def test_upload_uses_existing_document_folder_and_updates_same_pdf(self):
        service = self.existing_folder_service()
        service.files().list().execute.side_effect = [{"files": []}, {"files": [{"id": "registration-pdf"}]}]
        service.files().create().execute.return_value = {"id": "registration-pdf"}
        service.files().update().execute.return_value = {"id": "registration-pdf"}
        service.files().reset_mock()
        with patch("core.google_drive.build_drive_service", return_value=service):
            first = self.client.post(self.url)
            repeated = self.client.post(self.url)
        for response in (first, repeated):
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data["drive_file_id"], "registration-pdf")
            self.assertEqual(response.data["status"], "APPROVED")

        service.files().create.assert_called_once()
        create = service.files().create.call_args.kwargs
        self.assertEqual(create["body"]["parents"], ["existing-guard-folder"])
        self.assertEqual(create["body"]["appProperties"], {"rotaopsRegistration": self.registration.form_id})
        self.assertEqual(create["media_body"].mimetype(), "application/pdf")
        self.assertEqual(create["media_body"].getbytes(0, 5), b"%PDF-")
        service.files().update.assert_called_once()
        self.assertEqual(service.files().update.call_args.kwargs["fileId"], "registration-pdf")

        rows = self.client.get("/api/compliance-approvals/?status=APPROVED").data
        self.assertEqual(rows[0]["drive_file_id"], "registration-pdf")
        self.connection.root_folder_id = "different-root"
        self.connection.save(update_fields=["root_folder_id"])
        rows = self.client.get("/api/compliance-approvals/?status=APPROVED").data
        self.assertNotIn("drive_file_id", rows[0])

    def test_unapproved_forms_and_guard_accounts_cannot_upload(self):
        self.client.force_authenticate(self.guard)
        with patch("core.views.sync_registration_pdf") as upload:
            self.assertEqual(self.client.post(self.url).status_code, 403)
            self.client.force_authenticate(self.admin)
            self.registration.status = GuardComplianceRegistration.Status.PENDING_APPROVAL
            self.registration.save(update_fields=["status"])
            self.assertEqual(self.client.post(self.url).status_code, 400)
        upload.assert_not_called()

    def test_drive_failure_leaves_approval_and_allows_retry(self):
        self.connection.delete()
        self.assertEqual(self.client.post(self.url).status_code, 409)
        with patch("core.views.sync_registration_pdf", side_effect=RuntimeError("Drive unavailable")):
            with self.assertLogs("core.views", level="ERROR"):
                response = self.client.post(self.url)
        self.assertEqual(response.status_code, 502)
        self.registration.refresh_from_db()
        self.assertEqual(self.registration.status, GuardComplianceRegistration.Status.APPROVED)
        self.assertEqual(self.registration.drive_file_id, "")

    def test_induction_upload_matches_text_download_and_updates_the_same_file(self):
        site = Site.objects.create(name="Office Site", site_id="REG-SITE")
        induction = SiteInduction.objects.create(
            employee=self.employee, site=site, induction_date=timezone.localdate(), created_by=self.admin,
        )
        url = f"/api/site-inductions/{induction.pk}/"
        service = self.existing_folder_service()
        service.files().list().execute.side_effect = [{"files": []}, {"files": [{"id": "induction-txt"}]}]
        service.files().create().execute.return_value = {"id": "induction-txt"}
        service.files().update().execute.return_value = {"id": "induction-txt"}
        service.files().reset_mock()
        with patch("core.google_drive.build_drive_service", return_value=service):
            first = self.client.post(f"{url}sync-drive/")
            self.assertEqual(first.status_code, 200, first.data)
            self.assertEqual(first.data["drive_file_id"], "induction-txt")
            original = self.client.get(f"{url}download-txt/").content
            self.client.force_authenticate(self.guard)
            update = self.client.patch("/api/employees/me/", {"phone": "+923001234567"}, format="json")
            self.assertEqual(update.status_code, 200, update.data)
            self.client.force_authenticate(self.admin)
            repeated = self.client.post(f"{url}sync-drive/")
            self.assertEqual(repeated.status_code, 200, repeated.data)
            current = self.client.get(f"{url}download-txt/").content

        service.files().create.assert_called_once()
        create = service.files().create.call_args.kwargs
        self.assertEqual(create["body"]["name"], "Induction - Office Site - Renamed Guard.txt")
        self.assertEqual(create["body"]["parents"], ["existing-guard-folder"])
        self.assertEqual(create["body"]["appProperties"], {"rotaopsInduction": str(induction.pk)})
        self.assertEqual(create["media_body"].mimetype(), "text/plain")
        self.assertEqual(create["media_body"].getbytes(0, len(original)), original)
        service.files().update.assert_called_once()
        upload = service.files().update.call_args.kwargs
        self.assertEqual(upload["fileId"], "induction-txt")
        self.assertEqual(upload["media_body"].getbytes(0, len(current)), current)
        self.assertIn("• Contact Number: +923001234567".encode(), current)
        self.assertEqual(self.client.get(url).data["drive_file_id"], "induction-txt")
        changed = self.client.patch(url, {"notes": "Changed after export"}, format="json")
        self.assertEqual(changed.status_code, 200, changed.data)
        self.assertEqual(changed.data["drive_file_id"], "")
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.post(f"{url}sync-drive/").status_code, 403)
