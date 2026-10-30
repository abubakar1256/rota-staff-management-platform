from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import AuditLog, Employee, EmployeeDocument, SecurityScreening, UserProfile
from .screening import CHECKS, SecurityScreeningViewSet


class ScreeningWorkflowTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.guard = User.objects.create_user(username="screen-guard")
        self.admin = User.objects.create_user(username="screen-admin", is_superuser=True)
        self.other = User.objects.create_user(username="screen-other")
        self.manager = User.objects.create_user(username="screen-manager")
        for user, role in [(self.guard, "EMPLOYEE"), (self.other, "EMPLOYEE"), (self.manager, "MANAGER")]:
            UserProfile.objects.update_or_create(user=user, defaults={"role": role})
        self.employee = Employee.objects.create(employee_id="SCR-TEST", name="Screen Guard", user=self.guard)
        self.other_employee = Employee.objects.create(employee_id="SCR-OTHER", name="Other Guard", user=self.other)
        self.client.force_authenticate(self.guard)
        self.case_id = self.client.get("/api/security-screenings/my/").data["id"]
        today = timezone.localdate()
        self.data = {
            "full_name": "Screen Guard", "date_of_birth": "1990-01-01", "phone": "0123456789", "email": "guard@example.com",
            "job_title": "Security Guard", "current_address": "Test address", "moved_in": "2020-01", "sia_held": "N/A",
            "signature_name": "Screen Guard", "declaration_accepted": True,
            "activities": [{"from_month": today.strftime("%Y-%m"), "to_month": "", "organisation": "Test employer"}],
        }

    def submit(self, data=None):
        return self.client.post(f"/api/security-screenings/{self.case_id}/submit/", {"form_data": self.data if data is None else data}, format="json")

    def review(self, status="COMPLETED", **extras):
        return self.client.post(f"/api/security-screenings/{self.case_id}/review/", {"status": status, "office_data": {**{key: "VERIFIED" for key in CHECKS}, "internal_notes": "PRIVATE-OFFICE-ONLY"}, **extras}, format="json")

    def test_guard_and_office_permissions(self):
        self.assertEqual(self.client.get("/api/security-screenings/").status_code, 403)
        self.assertEqual(self.review().status_code, 403)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(f"/api/security-screenings/{self.case_id}/").status_code, 404)
        self.client.force_authenticate(self.manager)
        self.assertEqual(self.client.get("/api/security-screenings/").status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get("/api/security-screenings/my/").status_code, (401, 403))

    def test_postgresql_locks_screening_without_locking_nullable_approver(self):
        """Compile real PostgreSQL SQL: SQLite doesn't enforce outer-join locks."""
        from django.db.backends.postgresql.base import DatabaseWrapper
        pg = DatabaseWrapper({"NAME": "screening_sql_test"}, alias="screening_sql_test")
        for user in (self.guard, self.admin):
            view = SecurityScreeningViewSet()
            view.request = SimpleNamespace(user=user)
            query = view.get_locked_queryset().filter(pk=self.case_id)
            with patch.object(pg, "get_autocommit", return_value=False):
                sql, _ = query.query.get_compiler(connection=pg).as_sql()
            self.assertIn('LEFT OUTER JOIN "auth_user"', sql)
            self.assertTrue(sql.endswith('FOR UPDATE OF "core_securityscreening"'), sql)

    def test_submission_review_resubmission_and_private_pdf(self):
        self.assertEqual(self.submit().status_code, 200)
        self.assertEqual(self.submit().status_code, 400)
        self.client.force_authenticate(self.admin)
        completed = self.review()
        self.assertEqual(completed.status_code, 200, completed.data)
        self.client.force_authenticate(self.guard)
        guard_view = self.client.get(f"/api/security-screenings/{self.case_id}/").data
        self.assertNotIn("office_data", guard_view)
        self.assertNotIn("submissions", guard_view)
        with patch("reportlab.rl_config.pageCompression", 0):
            pdf = self.client.get(f"/api/security-screenings/{self.case_id}/pdf/")
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        from pypdf import PdfReader
        guard_pages = PdfReader(BytesIO(pdf.content)).pages
        self.assertEqual(len(guard_pages), 3)
        self.assertIn("EMPLOYEE SECURITY SCREENING FORM", guard_pages[0].extract_text())
        self.assertIn("Your information", guard_pages[0].extract_text())
        self.assertIn("FOR OFFICE USE ONLY", guard_pages[-1].extract_text())
        self.assertNotIn("VERIFIED", guard_pages[-1].extract_text())
        self.assertNotIn("PRIVATE-OFFICE-ONLY", "\n".join(page.extract_text() for page in guard_pages))
        self.client.force_authenticate(self.admin)
        with patch("reportlab.rl_config.pageCompression", 0):
            office_pdf = self.client.get(f"/api/security-screenings/{self.case_id}/pdf/")
        self.assertIn("PRIVATE-OFFICE-ONLY", "\n".join(page.extract_text() for page in PdfReader(BytesIO(office_pdf.content)).pages))
        self.assertEqual(self.review("CHANGES_REQUIRED", guard_message="Correct the employer dates").status_code, 200)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get(f"/api/security-screenings/{self.case_id}/pdf/").status_code, 400)
        self.assertEqual(self.submit().status_code, 200)
        case = SecurityScreening.objects.get(pk=self.case_id)
        self.assertEqual(case.submissions.count(), 2)
        self.assertEqual(case.office_data, {})
        self.assertIsNone(case.completed_at)
        self.assertTrue(AuditLog.objects.filter(model_name="SecurityScreening", action="REVIEW").exists())

    def test_bad_dates_and_foreign_documents_rejected(self):
        invalid = deepcopy(self.data)
        invalid["activities"][0]["from_month"] = "2026-99"
        self.assertEqual(self.submit(invalid).status_code, 400)
        foreign = EmployeeDocument.objects.create(employee=self.other_employee, document_type="Passport", created_by=self.admin)
        invalid = {**self.data, "document_ids": [foreign.pk]}
        self.assertEqual(self.submit(invalid).status_code, 400)

    def test_rejected_guard_can_resubmit(self):
        self.assertEqual(self.submit().status_code, 200)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.review("IN_REVIEW", office_data={}).status_code, 200)
        self.assertEqual(self.review("REJECTED", guard_message="Update your evidence").status_code, 200)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.submit().status_code, 200)

    def test_legacy_period_does_not_impose_five_year_submission_rule(self):
        SecurityScreening.objects.filter(pk=self.case_id).update(screening_months=60)
        response = self.client.get("/api/security-screenings/my/")
        self.assertNotIn("screening_months", response.data)
        self.assertNotIn("gaps", response.data)
        self.assertEqual(self.submit().status_code, 200)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.review(office_data={}).status_code, 200)

    def test_source_form_allows_na_and_no_mandatory_employment_record(self):
        data = {**self.data, "date_of_birth": "N/A", "email": "N/A", "moved_in": "N/A", "activities": [],
                "addresses": [{"address": "N/A", "from_month": "N/A", "to_month": "N/A"}],
                "gaps": [{"from_month": "N/A", "to_month": "N/A", "reason": "N/A"}],
                "sia_held": "Yes", "sia_number": ""}
        response = self.submit(data)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["form_data"]["print_name"], data["full_name"])
        self.assertEqual(response.data["form_data"]["signed_date"], timezone.localdate().isoformat())

    def test_new_forms_have_no_fixed_screening_period(self):
        self.assertIsNone(SecurityScreening.objects.get(pk=self.case_id).screening_months)

    def test_office_pdf_compacts_blank_space_and_preserves_template_sections(self):
        from pypdf import PdfReader
        self.assertEqual(self.submit().status_code, 200)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.review().status_code, 200)
        result = self.client.get(f"/api/security-screenings/{self.case_id}/pdf/")
        self.assertEqual(result.status_code, 200)
        pages = PdfReader(BytesIO(result.content)).pages
        self.assertEqual(len(pages), 3)
        self.assertIn("EMPLOYEE SECURITY SCREENING FORM", pages[0].extract_text())
        self.assertIn("Your information", pages[0].extract_text())
        self.assertIn("01/01/1990", pages[0].extract_text())
        self.assertIn("FOR OFFICE USE ONLY", pages[-1].extract_text())
        text = "\n".join(page.extract_text() for page in pages)
        for heading in ("Personal details", "Current address", "Employment and activity history",
                        "Employer / referee contact details", "Gaps or periods not covered above",
                        "Education, training and qualifications", "Right to work and role-specific checks",
                        "Declaration and permission to verify details", "Privacy notice"):
            self.assertIn(heading, text)
        for index, page in enumerate(pages, 1):
            self.assertIn(f"Page {index} of 3", page.extract_text())
        self.assertAlmostEqual(float(pages[0].mediabox.width), 595.32, places=2)

    def test_pdf_retains_extra_rows_and_long_answers_in_continuations(self):
        from .screening_pdf import build_screening_pdf
        from pypdf import PdfReader
        case = SecurityScreening.objects.get(pk=self.case_id)
        case.form_data = deepcopy(self.data)
        baseline_pages = len(PdfReader(BytesIO(build_screening_pdf(case, include_office=True))).pages)
        case.form_data["full_name"] = "Long answer " * 100 + "ANSWERENDMARKER"
        case.form_data["activities"] = [{"organisation": f"EMPLOYER{i}", "from_month": "2025-01", "to_month": "2025-02"} for i in range(8)]
        result = build_screening_pdf(case, include_office=True)
        pages = PdfReader(BytesIO(result)).pages
        self.assertGreater(len(pages), baseline_pages)
        text = "\n".join(page.extract_text() for page in pages)
        self.assertIn("ANSWERENDMARKER", text)
        for i in range(8):
            self.assertIn(f"EMPLOYER{i}", text)

    def test_office_data_cannot_be_injected_in_guard_draft(self):
        result = self.client.patch("/api/security-screenings/my/", {"form_data": {**self.data, "office_data": {"identity": "VERIFIED"}}, "status": "COMPLETED", "office_data": {"identity": "VERIFIED"}}, format="json")
        self.assertEqual(result.status_code, 200)
        case = SecurityScreening.objects.get(pk=self.case_id)
        self.assertEqual(case.status, "DRAFT")
        self.assertEqual(case.office_data, {})
        self.assertNotIn("office_data", case.form_data)
