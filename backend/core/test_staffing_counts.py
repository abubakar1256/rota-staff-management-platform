from datetime import date, datetime, time
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import DailyOperation, Employee, RotaAssignment, RotaWeek, ShiftAttendanceEvent, ShiftType, Site, SiteShiftRequirement, UserProfile


@override_settings(TIME_ZONE="Europe/London")
class StaffingCountTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user(username="staffing-admin", is_superuser=True)
        self.guard = User.objects.create_user(username="staffing-guard")
        UserProfile.objects.update_or_create(user=self.guard, defaults={"role": "EMPLOYEE"})
        self.employee = Employee.objects.create(employee_id="STAFF-1", name="Staffing guard", user=self.guard)
        self.today = date(2026, 11, 4)
        self.mock_time = patch("django.utils.timezone.now", return_value=timezone.make_aware(datetime(2026, 11, 4, 10)))
        self.mock_time.start(); self.addCleanup(self.mock_time.stop)
        ShiftType.objects.all().update(is_active=False)
        self.day = ShiftType.objects.create(name="Staffing day", start_time=time(7), end_time=time(19))
        self.night = ShiftType.objects.create(name="Staffing night", start_time=time(19), end_time=time(7))
        self.site = Site.objects.create(site_id="STAFF", name="Staffing site", required_guards=4)
        self.week = RotaWeek.objects.create(week_start=date(2026, 11, 2), created_by=self.admin)
        self.assignment = RotaAssignment.objects.create(rota_week=self.week, work_date=self.today, site=self.site,
            shift_type=self.day, employee=self.employee, created_by=self.admin)
        self.operation = self.operation_for(self.site, self.day, self.employee)
        for shift in (self.day, self.night):
            SiteShiftRequirement.objects.create(site=self.site, shift_type=shift, weekday=2, required_guards=1)
            for _ in range(4):
                self.operation_for(self.site, shift)
        self.client.force_authenticate(self.admin)

    def operation_for(self, site, shift, employee=None):
        return DailyOperation.objects.create(operation_date=self.today, site=site, shift_type=shift,
            employee=employee, created_by=self.admin)

    def summary(self):
        response = self.client.get(f"/api/operations/?operation_date={self.today}&view=attendance")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_old_empty_rows_do_not_inflate_the_current_daily_gap_or_destroy_records(self):
        event = ShiftAttendanceEvent.objects.create(operation=self.operation, event_type="BOOK_ON", photo="fixture/on.jpg", created_by=self.guard)
        rows = self.summary()
        self.assertEqual(len(rows), 2)
        self.assertEqual(sum(row["employee"] is None for row in rows), 1)
        self.assertEqual(rows[0]["attendance_events"][0]["id"], event.pk)
        self.assertEqual(DailyOperation.objects.count(), 9)
        self.assertEqual(len(self.client.get(f"/api/operations/?operation_date={self.today}").data), 9)

    def test_zero_requirement_removes_empty_positions_but_retains_booked_guard_evidence(self):
        SiteShiftRequirement.objects.filter(site=self.site).update(required_guards=0)
        rows = self.summary()
        self.assertEqual([row["id"] for row in rows], [self.operation.pk])
        self.assertEqual(DailyOperation.objects.count(), 9)

    def test_missing_empty_records_are_projected_without_writing_on_a_get(self):
        DailyOperation.objects.filter(employee__isnull=True).delete()
        SiteShiftRequirement.objects.filter(site=self.site).update(required_guards=3)
        rows = self.summary()
        self.assertEqual(sum(row["employee"] is None for row in rows), 5)
        self.assertEqual(len({row["id"] for row in rows}), 6)
        self.assertEqual(DailyOperation.objects.count(), 1)

    def test_dashboard_rota_and_attendance_use_weekday_requirements_per_shift(self):
        dashboard = self.client.get("/api/dashboard/").data
        coverage = self.client.get(f"/api/rota-weeks/{self.week.pk}/coverage/?date={self.today}").data
        self.assertEqual(dashboard["unfilled_shifts"], 1)
        self.assertEqual(coverage["sites"][0]["unfilled"], 1)
        self.assertEqual(sum(row["employee"] is None for row in self.summary()), 1)

    def test_extra_day_guards_do_not_cover_a_missing_night_guard(self):
        for index in range(2):
            employee = Employee.objects.create(employee_id=f"STAFF-extra-{index}", name=f"Extra guard {index}")
            RotaAssignment.objects.create(rota_week=self.week, work_date=self.today, site=self.site,
                shift_type=self.day, employee=employee, created_by=self.admin)
            self.operation_for(self.site, self.day, employee)
        self.assertEqual(self.client.get("/api/dashboard/").data["unfilled_shifts"], 1)
        self.assertEqual(sum(row["employee"] is None for row in self.summary()), 1)

    def test_inactive_sites_and_shift_types_do_not_add_new_staffing_gaps(self):
        inactive = Site.objects.create(site_id="STAFF-OFF", name="Inactive site", required_guards=10, is_active=False)
        self.operation_for(inactive, self.day)
        self.assertEqual(sum(row["employee"] is None for row in self.summary()), 1)
        self.night.is_active = False; self.night.save()
        self.assertEqual(sum(row["employee"] is None for row in self.summary()), 0)

    def test_office_scope_is_preserved_and_guards_cannot_request_staffing_overview(self):
        User = get_user_model()
        manager = User.objects.create_user(username="staffing-manager")
        UserProfile.objects.update_or_create(user=manager, defaults={"role": "MANAGER"})
        self.client.force_authenticate(manager)
        self.assertEqual(self.summary(), [])
        manager.profile.managed_sites.add(self.site)
        self.assertEqual(len(self.summary()), 2)
        operator = User.objects.create_user(username="staffing-operator")
        UserProfile.objects.update_or_create(user=operator, defaults={"role": "OPERATOR"})
        self.client.force_authenticate(operator)
        self.assertEqual(len(self.summary()), 2)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get(f"/api/operations/?operation_date={self.today}&view=attendance").status_code, 403)
        self.assertEqual(len(self.client.get(f"/api/operations/?operation_date={self.today}").data), 1)

    def test_invalid_overview_date_is_a_validation_error(self):
        response = self.client.get("/api/operations/?operation_date=wrong&view=attendance")
        self.assertEqual(response.status_code, 400)
