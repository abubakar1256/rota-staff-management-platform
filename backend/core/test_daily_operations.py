from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import AuditLog, DailyOperation, Employee, ShiftAttendanceEvent, ShiftType, Site, SiteShiftRequirement, Timesheet, UserProfile
from .views import build_arrival_pdf


@override_settings(TIME_ZONE="Europe/London")
class DailyOperationsTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user(username="ops-admin", is_superuser=True)
        self.guard = User.objects.create_user(username="ops-guard")
        UserProfile.objects.update_or_create(user=self.guard, defaults={"role": "EMPLOYEE"})
        self.employee = Employee.objects.create(employee_id="OPS-1", name="Guard <one> & Company", user=self.guard)
        self.now = timezone.make_aware(datetime(2026, 11, 4, 10))
        clock = patch("django.utils.timezone.now", side_effect=lambda: self.now)
        clock.start(); self.addCleanup(clock.stop)
        ShiftType.objects.all().update(is_active=False)
        self.day = ShiftType.objects.create(name="Day", start_time=time(7), end_time=time(19))
        self.night = ShiftType.objects.create(name="Night", start_time=time(19), end_time=time(7))
        self.site = Site.objects.create(site_id="OPS", name="London <HQ> & North", required_guards=2)
        self.operation = self.make_operation(employee=self.employee)
        for _ in range(8):
            self.make_operation()
        SiteShiftRequirement.objects.create(site=self.site, shift_type=self.day, weekday=2, required_guards=1)
        SiteShiftRequirement.objects.create(site=self.site, shift_type=self.night, weekday=2, required_guards=0)
        self.client.force_authenticate(self.admin)

    def make_operation(self, **kwargs):
        return DailyOperation.objects.create(operation_date=kwargs.pop("operation_date", date(2026, 11, 4)),
            shift_type=kwargs.pop("shift_type", self.day), site=self.site, created_by=self.admin, **kwargs)

    def overview(self):
        response = self.client.get("/api/operations/?operation_date=2026-11-04&view=operations")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_overview_preserves_office_notes_without_counting_old_placeholders(self):
        note = DailyOperation.objects.filter(employee=None).first()
        note.notes = "Call replacement"; note.follow_up = "Office follow-up"; note.save()
        data = self.overview()
        self.assertEqual([row["id"] for row in data["operations"]], [self.operation.pk])
        self.assertEqual([row["id"] for row in data["unassigned_notes"]], [note.pk])
        self.assertEqual(DailyOperation.objects.count(), 9)
        SiteShiftRequirement.objects.filter(site=self.site, shift_type=self.night).update(required_guards=3)
        self.assertEqual(sum(row["employee"] is None for row in self.overview()["operations"]), 3)
        self.assertEqual(DailyOperation.objects.count(), 9)

    def test_overview_scope_and_date_validation(self):
        manager = get_user_model().objects.create_user(username="ops-manager")
        UserProfile.objects.update_or_create(user=manager, defaults={"role": "MANAGER"})
        self.client.force_authenticate(manager)
        self.assertEqual(self.overview(), {"operations": [], "unassigned_notes": []})
        manager.profile.managed_sites.add(self.site)
        self.assertEqual(len(self.overview()["operations"]), 1)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get("/api/operations/?view=operations").status_code, 403)
        self.assertEqual(self.client.post(f"/api/operations/{self.operation.pk}/mark-reached/").status_code, 403)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get("/api/operations/?view=operations&operation_date=wrong").status_code, 400)

    def test_upcoming_status_uses_shift_start(self):
        self.operation.shift_type = self.night; self.operation.save()
        row = self.overview()["operations"][0]
        self.assertEqual(row["arrival_status"], "UPCOMING")
        self.now += timedelta(hours=10)
        self.assertEqual(self.overview()["operations"][0]["arrival_status"], "NOT_REACHED")

    @patch("core.views.generate_daily_arrival_reports")
    def test_repeated_mark_reached_retains_first_timestamp_and_records_once(self, generate):
        url = f"/api/operations/{self.operation.pk}/mark-reached/"
        first = self.client.post(url, {}, format="json")
        self.assertEqual(first.status_code, 200, first.data)
        audit_count = AuditLog.objects.filter(model_name="DailyOperation", object_id=self.operation.pk).count()
        self.now += timedelta(minutes=20)
        second = self.client.post(url, {}, format="json")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.data["reached_at"], second.data["reached_at"])
        self.assertEqual(generate.call_count, 1)
        self.assertEqual(AuditLog.objects.filter(model_name="DailyOperation", object_id=self.operation.pk).count(), audit_count)

    @patch("core.views.generate_daily_arrival_reports")
    def test_future_unassigned_and_completed_arrivals_cannot_be_marked(self, generate):
        tomorrow = self.make_operation(operation_date=date(2026, 11, 5), employee=self.employee)
        empty = DailyOperation.objects.filter(employee=None).first()
        for item in (tomorrow, empty):
            self.assertEqual(self.client.post(f"/api/operations/{item.pk}/mark-reached/").status_code, 400)
        ShiftAttendanceEvent.objects.create(operation=self.operation, event_type="BOOK_OFF", photo="fixture/off.jpg", created_by=self.guard)
        self.assertEqual(self.client.post(f"/api/operations/{self.operation.pk}/mark-reached/").status_code, 400)
        generate.assert_not_called()

    def test_pdf_counts_assigned_arrivals_and_scoped_current_requirements(self):
        self.operation.reached_at = self.now - timedelta(minutes=12); self.operation.save()
        self.make_operation(shift_type=self.night, employee=self.employee)
        pdf, counts = build_arrival_pdf(date(2026, 11, 4), self.day,
            list(DailyOperation.objects.filter(shift_type=self.day)), sites=[self.site])
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertEqual(counts, {"scheduled": 1, "reached": 1, "on_time": 0, "late": 1, "not_reached": 0, "upcoming": 0, "unassigned": 0})
        _, upcoming = build_arrival_pdf(date(2026, 11, 4), self.night,
            list(DailyOperation.objects.filter(shift_type=self.night)), sites=[self.site])
        self.assertEqual(upcoming["upcoming"], 1)
        self.assertEqual(upcoming["not_reached"], 0)

    def test_working_hours_print_rejects_guards_and_bad_dates(self):
        self.assertEqual(self.client.get("/api/exports/report-print/?start_date=wrong").status_code, 400)
        self.assertEqual(self.client.get("/api/exports/report-print/?start_date=2026-11-06&end_date=2026-11-04").status_code, 400)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get("/api/exports/report-print/").status_code, 403)

    def test_office_exports_are_scoped_and_escape_html_names(self):
        sheet = Timesheet.objects.create(employee=self.employee, site=self.site,
            work_date=date(2026, 11, 4), actual_start=time(7), actual_end=time(19), created_by=self.admin)
        response = self.client.get("/api/exports/report-print/?start_date=2026-11-04&end_date=2026-11-04")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Guard &lt;one&gt; &amp; Company")
        manager = get_user_model().objects.create_user(username="export-manager")
        UserProfile.objects.update_or_create(user=manager, defaults={"role": "MANAGER"})
        self.client.force_authenticate(manager)
        for endpoint in ("report-print/", "timesheets.csv"):
            response = self.client.get(f"/api/exports/{endpoint}?start_date=2026-11-04&end_date=2026-11-04")
            self.assertEqual(response.status_code, 200)
            self.assertNotContains(response, "Guard")
        manager.profile.managed_sites.add(self.site)
        self.assertContains(self.client.get("/api/exports/timesheets.csv"), "Guard <one> & Company")
        self.client.force_authenticate(self.guard)
        for endpoint in ("timesheets.csv", "rota.csv"):
            self.assertEqual(self.client.get(f"/api/exports/{endpoint}").status_code, 403)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get("/api/exports/timesheets.csv?start_date=wrong").status_code, 400)
        self.assertEqual(self.client.get("/api/exports/rota.csv?rota_week=wrong").status_code, 400)
