from io import BytesIO
from pathlib import PurePosixPath
from tempfile import TemporaryDirectory
from unittest.mock import patch
from zipfile import ZipFile

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from rest_framework.test import APITestCase

from .models import Employee, EmployeeDocument, UserProfile


class DocumentArchiveTests(APITestCase):
    path = "/api/documents/download-zip/"

    def setUp(self):
        media = self.enterContext(TemporaryDirectory())
        self.enterContext(self.settings(MEDIA_ROOT=media))
        self.admin = get_user_model().objects.create_user("document-office")
        UserProfile.objects.create(user=self.admin, role=UserProfile.Role.ADMIN)
        self.employee = Employee.objects.create(employee_id="GUARD-1", name="First Guard")
        self.client.force_authenticate(self.admin)

    def upload(self, employee, label="Passport", contents=b"%PDF-test"):
        return EmployeeDocument.objects.create(
            employee=employee, created_by=self.admin, document_type=label,
            file=ContentFile(contents, name="evidence.pdf"),
        )

    def download(self, ids):
        return self.client.post(self.path, {"document_ids": ids}, format="json")

    def test_download_includes_only_selected_files_and_keeps_guard_folders(self):
        second_guard = Employee.objects.create(employee_id="GUARD/2", name="../Second Guard")
        first = self.upload(self.employee, contents=b"first PDF")
        second = self.upload(second_guard, "../Passport", contents=b"second PDF")
        duplicate_type = self.upload(second_guard, "../Passport", contents=b"third PDF")
        self.upload(self.employee, "Unselected document")

        response = self.download([first.pk, second.pk, duplicate_type.pk, first.pk])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/zip")
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertIn("attachment", response["Content-Disposition"])
        with ZipFile(BytesIO(b"".join(response.streaming_content))) as archive:
            names = archive.namelist()
            self.assertEqual(len(set(names)), 3)
            self.assertEqual([archive.read(name) for name in names], [b"first PDF", b"second PDF", b"third PDF"])
            paths = [PurePosixPath(name) for name in names]
            self.assertNotEqual(paths[0].parent, paths[1].parent)
            self.assertEqual(paths[1].parent, paths[2].parent)
            for path in paths:
                self.assertFalse(path.is_absolute())
                self.assertNotIn("..", path.parts)
                self.assertEqual(len(path.parts), 2)

    def test_only_admin_roles_can_export(self):
        document = self.upload(self.employee)
        self.client.force_authenticate(None)
        self.assertEqual(self.download([document.pk]).status_code, 401)
        for role in [UserProfile.Role.EMPLOYEE, UserProfile.Role.MANAGER, UserProfile.Role.OPERATOR, UserProfile.Role.CLIENT_ADMIN]:
            with self.subTest(role=role):
                user = get_user_model().objects.create_user(role.value)
                UserProfile.objects.create(user=user, role=role)
                if role == UserProfile.Role.EMPLOYEE:
                    self.employee.user = user
                    self.employee.save(update_fields=["user"])
                self.client.force_authenticate(user)
                self.assertEqual(self.download([document.pk]).status_code, 403)

    def test_missing_or_unavailable_file_fails_without_returning_partial_zip(self):
        first = self.upload(self.employee)
        missing = self.upload(self.employee, "Missing licence")
        missing.file.storage.delete(missing.file.name)
        linked = EmployeeDocument.objects.create(
            employee=self.employee, created_by=self.admin, document_type="External file",
            file_url="https://example.test/file.pdf",
        )
        for pk, expected in [(missing.pk, "Missing licence"), (linked.pk, "External file"), (linked.pk + 1, "no longer exist")]:
            with self.subTest(pk=pk):
                response = self.download([first.pk, pk])
                self.assertEqual(response.status_code, 400)
                self.assertIn(expected, response.data["detail"])
                self.assertFalse(response.streaming)

    def test_export_limits_invalid_and_oversized_selections(self):
        document = self.upload(self.employee)
        for selection in [[], [0], [2**63], [document.pk] * 101]:
            self.assertEqual(self.download(selection).status_code, 400)
        with patch("core.document_archive.MAX_ARCHIVE_BYTES", 1):
            response = self.download([document.pk])
        self.assertEqual(response.status_code, 400)
        self.assertIn("Select fewer files", response.data["detail"])
