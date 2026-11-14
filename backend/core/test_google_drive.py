from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import override_settings
from rest_framework.test import APITestCase

from .google_drive import decrypt_refresh_token, encrypt_refresh_token, sync_verified_document
from .models import Employee, EmployeeDocument, GoogleDriveConnection, UserProfile


@override_settings(
    GOOGLE_DRIVE_CLIENT_ID="test.apps.googleusercontent.com",
    GOOGLE_DRIVE_CLIENT_SECRET="test-secret",
    GOOGLE_DRIVE_REDIRECT_URI="https://backend.example/api/integrations/google-drive/callback/",
    GOOGLE_DRIVE_ROOT_FOLDER_ID="old-folder",
    CORS_ALLOWED_ORIGINS=["https://rota.example"],
)
class GoogleDriveSwitchTests(APITestCase):
    connect_path = "/api/integrations/google-drive/connect/"
    callback_path = "/api/integrations/google-drive/callback/"

    def setUp(self):
        self.admin = get_user_model().objects.create_user("drive-admin", is_superuser=True)
        self.client.force_authenticate(self.admin)
        self.old = GoogleDriveConnection.objects.create(
            authorized_email="old@example.com", root_folder_id="old-folder",
            encrypted_refresh_token=encrypt_refresh_token("old-token"),
        )

    def start(self):
        response = self.client.get(self.connect_path, HTTP_ORIGIN="https://rota.example")
        self.assertEqual(response.status_code, 200)
        query = parse_qs(urlsplit(response.data["authorization_url"]).query)
        self.assertEqual(query["prompt"], ["select_account consent"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["state"], [response.data["state"]])
        return response.data["state"]

    def finish(self, state, credentials, service):
        with patch("core.google_drive.build_drive_service", return_value=service), patch("core.views.build_flow") as build_flow:
            build_flow.return_value.credentials = credentials
            return self.client.post(self.connect_path, {"state": state, "code": "google-code"}, format="json")

    def test_oauth_callback_returns_to_documents_and_only_the_starting_admin_can_finish(self):
        state = self.start()
        self.client.force_authenticate(None)
        callback = self.client.get(self.callback_path, {"state": state, "code": "google-code"})
        self.assertEqual(callback.status_code, 302)
        destination = urlsplit(callback["Location"])
        self.assertEqual(destination.netloc, "rota.example")
        self.assertEqual(destination.path, "/admin")
        self.assertEqual(destination.query, "google_drive=authorize")
        self.assertEqual(parse_qs(destination.fragment)["code"], ["google-code"])
        cancelled = self.client.get(self.callback_path, {"state": state, "error": "access_denied"})
        self.assertEqual(urlsplit(cancelled["Location"]).query, "google_drive=cancelled")

        manager = get_user_model().objects.create_user("manager")
        UserProfile.objects.create(user=manager, role=UserProfile.Role.MANAGER)
        self.client.force_authenticate(manager)
        self.assertEqual(self.client.get(self.connect_path).status_code, 403)
        other_admin = get_user_model().objects.create_user("other-admin", is_superuser=True)
        self.client.force_authenticate(other_admin)
        self.assertEqual(self.finish(state, None, None).status_code, 403)
        self.old.refresh_from_db()
        self.assertEqual(self.old.authorized_email, "old@example.com")

    def test_missing_refresh_token_and_drive_folder_failure_keep_old_connection(self):
        state = self.start()
        service = MagicMock()
        missing_token = self.finish(state, SimpleNamespace(refresh_token=None), service)
        self.assertEqual(missing_token.status_code, 400)
        service.about().get().execute.return_value = {"user": {"emailAddress": "new@example.com"}}
        service.files().list().execute.return_value = {"files": []}
        service.files().create().execute.side_effect = RuntimeError("Drive unavailable")
        failed_folder = self.finish(state, SimpleNamespace(refresh_token="new-token"), service)
        self.assertEqual(failed_folder.status_code, 502)
        self.old.refresh_from_db()
        self.assertEqual(self.old.root_folder_id, "old-folder")
        self.assertEqual(decrypt_refresh_token(self.old.encrypted_refresh_token), "old-token")

    def test_legacy_connection_does_not_reuse_old_folder_shared_with_new_account(self):
        self.old.authorized_email = ""
        self.old.save(update_fields=["authorized_email"])
        service = MagicMock()
        service.about().get().execute.return_value = {"user": {"emailAddress": "new@example.com"}}
        service.files().get().execute.return_value = {
            "mimeType": "application/vnd.google-apps.folder", "ownedByMe": False,
            "capabilities": {"canAddChildren": True},
        }
        service.files().list().execute.return_value = {"files": []}
        service.files().create().execute.return_value = {"id": "new-folder"}
        response = self.finish(self.start(), SimpleNamespace(refresh_token="new-token", scopes=[]), service)
        self.assertEqual(response.status_code, 200)
        self.old.refresh_from_db()
        self.assertEqual(self.old.root_folder_id, "new-folder")

    def test_new_account_switches_to_its_own_folder_and_uploads_without_using_old_file_id(self):
        state = self.start()
        service = MagicMock()
        service.about().get().execute.return_value = {"user": {"emailAddress": "new@example.com"}}
        service.files().list().execute.return_value = {"files": [{"id": "shared-folder", "ownedByMe": True, "shared": True}]}
        service.files().create().execute.return_value = {"id": "new-folder"}
        credentials = SimpleNamespace(refresh_token="new-token", scopes=[])
        previous_update = self.old.updated_at
        with patch("django.db.models.fields.timezone.now", return_value=previous_update):
            response = self.finish(state, credentials, service)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["authorized_email"], "new@example.com")
        self.assertEqual(response.data["root_folder_id"], "new-folder")
        service.files().get.assert_not_called()
        self.old.refresh_from_db()
        self.assertEqual(self.old.updated_at, previous_update)
        self.assertEqual(self.old.root_folder_id, "new-folder")
        self.assertEqual(decrypt_refresh_token(self.old.encrypted_refresh_token), "new-token")
        self.assertEqual(self.finish(state, credentials, service).status_code, 400)

        self.enterContext(override_settings(MEDIA_ROOT=self.enterContext(TemporaryDirectory())))
        employee = Employee.objects.create(employee_id="GUARD-1", name="Test Guard")
        document = EmployeeDocument.objects.create(
            employee=employee, created_by=self.admin, document_type="Passport",
            verification_status=EmployeeDocument.VerificationStatus.VERIFIED,
            file=ContentFile(b"%PDF-test", name="passport.pdf"),
            drive_folder_id="old-guard-folder", drive_file_id="old-file",
        )
        service.files().list().execute.return_value = {"files": [{"id": "new-guard-folder"}]}
        service.files().create().execute.return_value = {"id": "new-file"}
        with patch("core.google_drive.build_drive_service", return_value=service):
            self.assertEqual(sync_verified_document(document), "new-file")
        service.files().update.assert_not_called()
        document.refresh_from_db()
        self.assertEqual(document.drive_folder_id, "new-guard-folder")
        self.assertEqual(document.drive_file_id, "new-file")
        self.assertEqual(document.drive_root_folder_id, "new-folder")
        self.assertIsNotNone(document.drive_synced_at)

        attempted_edit = self.client.patch(f"/api/documents/{document.pk}/", {
            "drive_file_id": "forged-file", "drive_root_folder_id": "forged-folder",
        }, format="json")
        self.assertEqual(attempted_edit.status_code, 200)
        summary = self.client.get("/api/documents/employee-summary/")
        self.assertEqual(summary.status_code, 200)
        row = summary.data["results"][0]["documents"][0]
        self.assertEqual(row["drive_file_id"], "new-file")
        self.assertEqual(row["drive_root_folder_id"], "new-folder")

    def test_retry_recreates_a_missing_drive_copy_then_reuses_the_new_copy(self):
        from googleapiclient.errors import HttpError

        self.enterContext(override_settings(MEDIA_ROOT=self.enterContext(TemporaryDirectory())))
        employee = Employee.objects.create(employee_id="RETRY-1", name="Retry Guard")
        document = EmployeeDocument.objects.create(
            employee=employee, created_by=self.admin, document_type="Passport",
            verification_status=EmployeeDocument.VerificationStatus.VERIFIED,
            file=ContentFile(b"%PDF-test", name="passport.pdf"), drive_sync_error="Previous upload failed",
            drive_file_id="removed-file", drive_folder_id="guard-folder", drive_root_folder_id="old-folder",
        )
        service = MagicMock()
        service.files().list().execute.return_value = {"files": [{"id": "guard-folder"}]}
        service.files().update().execute.side_effect = [
            HttpError(SimpleNamespace(status=404, reason="Not Found"), b"{}"), {"id": "replacement-file"},
        ]
        service.files().create().execute.return_value = {"id": "replacement-file"}
        service.files().reset_mock()

        path = f"/api/documents/{document.pk}/sync-drive/"
        with patch("core.google_drive.build_drive_service", return_value=service):
            result = self.client.post(path)
            self.assertEqual(result.status_code, 200, result.data)
            self.assertEqual(result.data["verification_status"], "VERIFIED")
            self.assertEqual(result.data["drive_sync_error"], "")
            self.assertEqual(result.data["drive_file_id"], "replacement-file")
            self.assertIsNotNone(result.data["drive_synced_at"])
            self.assertEqual(self.client.post(path).status_code, 200)

        self.assertEqual(service.files().create.call_count, 1)
        self.assertEqual(service.files().update.call_args.kwargs["fileId"], "replacement-file")

    def test_retry_explains_missing_original_and_missing_connection(self):
        employee = Employee.objects.create(employee_id="RETRY-2", name="Second Retry Guard")
        document = EmployeeDocument.objects.create(
            employee=employee, created_by=self.admin, document_type="Passport",
            verification_status=EmployeeDocument.VerificationStatus.VERIFIED,
            file="missing/passport.pdf", drive_sync_error="Previous upload failed",
        )
        path = f"/api/documents/{document.pk}/sync-drive/"
        service = MagicMock()
        service.files().list().execute.return_value = {"files": [{"id": "guard-folder"}]}
        with patch("core.google_drive.build_drive_service", return_value=service):
            result = self.client.post(path)
        self.assertEqual(result.status_code, 409, result.data)
        self.assertIn("original file is missing", result.data["detail"])
        service.files().create.assert_not_called()
        document.refresh_from_db()
        self.assertEqual(document.verification_status, "VERIFIED")
        self.assertTrue(document.drive_sync_error)

        self.old.delete()
        result = self.client.post(path)
        self.assertEqual(result.status_code, 409, result.data)
        self.assertIn("Connect Google Drive", result.data["detail"])

        document.verification_status = "PENDING"
        document.save(update_fields=["verification_status"])
        self.assertEqual(self.client.post(path).status_code, 400)
