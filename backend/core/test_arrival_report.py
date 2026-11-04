from datetime import date, datetime, time
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import DailyOperation, Employee, ShiftAttendanceEvent, ShiftType, Site, SiteShiftRequirement, UserProfile


@override_settings(TIME_ZONE="Europe/London")
class ArrivalReportTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user(username="arrival-admin", is_superuser=True)
        self.guard = User.objects.create_user(username="arrival-guard")
        UserProfile.objects.update_or_create(user=self.guard, defaults={"role": "EMPLOYEE"})
        self.employees = [Employee.objects.create(employee_id=f"ARR-{index}", name=f"Arrival guard {index}",
            user=self.guard if index == 0 else None) for index in range(5)]
        self.now = timezone.make_aware(datetime(2026, 11, 4, 10))
        self.mock_time = patch("django.utils.timezone.now", side_effect=lambda: self.now)
        self.mock_time.start(); self.addCleanup(self.mock_time.stop)
        ShiftType.objects.all().update(is_active=False)
        self.day = ShiftType.objects.create(name="Arrival day", start_time=time(7), end_time=time(19))
        self.night = ShiftType.objects.create(name="Arrival night", start_time=time(19), end_time=time(7))
        self.site = Site.objects.create(site_id="ARR", name="Arrival site", required_guards=4)
        for weekday in range(7):
            for shift in (self.day, self.night):
                SiteShiftRequirement.objects.create(site=self.site, shift_type=shift, weekday=weekday,
                    required_guards=2 if weekday == 2 else 0)
        self.late = self.operation(0, date(2026, 11, 4), self.day, self.stamp(4, 9, 48))
        self.pending = self.operation(1, date(2026, 11, 4), self.day)
        self.tonight = self.operation(2, date(2026, 11, 4), self.night)
        self.tomorrow = self.operation(3, date(2026, 11, 5), self.day)
        self.on_time = self.operation(4, date(2026, 11, 2), self.day, self.stamp(2, 7))
        for _ in range(36):
            DailyOperation.objects.create(operation_date=date(2026, 11, 4), site=self.site,
                shift_type=self.day, created_by=self.admin)
        self.client.force_authenticate(self.admin)

    def stamp(self, day, hour, minute=0):
        return timezone.make_aware(datetime(2026, 11, day, hour, minute))

    def operation(self, index, day, shift, reached=None):
        return DailyOperation.objects.create(operation_date=day, site=self.site, shift_type=shift,
            employee=self.employees[index], reached_at=reached, reached_by=self.admin if reached else None, created_by=self.admin)

    def report(self, start="2026-11-02", end="2026-11-08"):
        response = self.client.get(f"/api/reports/summary/?start_date={start}&end_date={end}")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_only_assigned_guards_are_scheduled_and_future_shifts_are_not_missing(self):
        data = self.report()
        self.assertEqual(data["arrival_summary"], {"scheduled": 5, "reached": 1, "late": 1,
            "not_reached": 1, "upcoming": 2, "not_assigned": 1})
        self.assertEqual(len(data["arrival_rows"]), 5)
        self.assertTrue(all(row["employee"] for row in data["arrival_rows"]))
        self.assertEqual(len(data["arrival_unfilled"]), 1)
        self.assertEqual(data["arrival_unfilled"][0]["shift_name"], self.night.name)
        self.assertEqual(data["arrival_unfilled"][0]["unfilled"], 1)

    def test_arrival_time_and_delay_retain_the_recorded_instant(self):
        row = next(row for row in self.report()["arrival_rows"] if row["id"] == self.late.pk)
        self.assertEqual(row["arrival_status"], "LATE")
        self.assertEqual(row["delay_minutes"], 168)
        self.assertEqual(row["scheduled_start"], time(7))
        self.assertEqual(row["scheduled_end"], time(19))
        self.assertEqual(row["reached_at"], self.stamp(4, 9, 48))
        self.assertEqual(self.report()["time_zone"], "Europe/London")

    def test_selected_range_excludes_other_dates_and_changes_upcoming_when_due(self):
        data = self.report("2026-11-04", "2026-11-04")
        self.assertEqual(data["arrival_summary"]["scheduled"], 3)
        self.assertEqual(data["arrival_summary"]["upcoming"], 1)
        self.now = self.stamp(4, 20)
        data = self.report("2026-11-04", "2026-11-04")
        self.assertEqual(data["arrival_summary"]["upcoming"], 0)
        self.assertEqual(data["arrival_summary"]["not_reached"], 2)

    def test_requirement_changes_update_unfilled_groups_without_erasing_evidence(self):
        event = ShiftAttendanceEvent.objects.create(operation=self.late, event_type="BOOK_ON", photo="fixture/on.jpg",
            late_reason="Traffic", created_by=self.guard)
        SiteShiftRequirement.objects.filter(site=self.site).update(required_guards=0)
        data = self.report()
        self.assertEqual(data["arrival_summary"]["not_assigned"], 0)
        self.assertEqual(data["arrival_unfilled"], [])
        self.assertEqual(DailyOperation.objects.count(), 41)
        event.refresh_from_db(); self.assertEqual(event.late_reason, "Traffic")

    def test_inactive_sites_add_no_unfilled_positions_but_keep_actual_guard_history(self):
        self.site.is_active = False; self.site.save()
        data = self.report()
        self.assertEqual(data["arrival_summary"]["scheduled"], 5)
        self.assertEqual(data["arrival_summary"]["not_assigned"], 0)

    def test_manager_scope_and_guard_access_are_enforced(self):
        manager = get_user_model().objects.create_user(username="arrival-manager")
        UserProfile.objects.update_or_create(user=manager, defaults={"role": "MANAGER"})
        self.client.force_authenticate(manager)
        data = self.report()
        self.assertEqual(data["arrival_rows"], [])
        self.assertEqual(data["arrival_unfilled"], [])
        manager.profile.managed_sites.add(self.site)
        self.assertEqual(len(self.report()["arrival_rows"]), 5)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get("/api/reports/summary/").status_code, 403)

    def test_invalid_and_reversed_ranges_return_validation_errors(self):
        for query in ("start_date=wrong", "end_date=wrong", "start_date=2026-11-08&end_date=2026-11-02"):
            with self.subTest(query=query):
                self.assertEqual(self.client.get(f"/api/reports/summary/?{query}").status_code, 400)

    def test_delay_labels_cover_hour_boundaries_without_changing_minutes(self):
        from .arrival_reporting import format_arrival_delay
        for minutes, expected in [(None, "-"), (0, "On time"), (59, "59 min"),
                (60, "1hr"), (62, "1hr 2min"), (120, "2hr"), (168, "2hr 48min")]:
            with self.subTest(minutes=minutes):
                self.assertEqual(format_arrival_delay(minutes), expected)
        row = next(row for row in self.report()["arrival_rows"] if row["id"] == self.late.pk)
        self.assertEqual(row["delay_minutes"], 168)
        night = next(row for row in self.report()["arrival_rows"] if row["id"] == self.tonight.pk)
        self.assertEqual(night["scheduled_start"], time(19))
        self.assertEqual(night["scheduled_end"], time(7))
