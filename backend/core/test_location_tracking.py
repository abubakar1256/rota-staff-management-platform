from datetime import date, datetime, time, timedelta, timezone as datetime_timezone
from io import StringIO
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .location_tracking import next_due, refresh_location_alerts, snapshot
from .models import DailyOperation, DutyLocationState, DutyLocationUpdate, Employee, Notification, ShiftAttendanceEvent, ShiftType, Site, UserProfile
from .test_site_attendance import AttendanceFixture


@override_settings(TIME_ZONE="Europe/London")
class LocationTrackingTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user(username="location-office", is_superuser=True)
        self.guard = User.objects.create_user(username="location-guard")
        self.other = User.objects.create_user(username="location-other")
        self.manager = User.objects.create_user(username="location-manager")
        for user, role in [(self.guard, "EMPLOYEE"), (self.other, "EMPLOYEE"), (self.manager, "MANAGER")]:
            UserProfile.objects.update_or_create(user=user, defaults={"role": role})
        self.employee = Employee.objects.create(employee_id="LOC-1", name="Location Guard", user=self.guard)
        self.other_employee = Employee.objects.create(employee_id="LOC-2", name="Other Guard", user=self.other)
        self.current = timezone.make_aware(datetime(2026, 11, 4, 8))
        self.mock_time = patch("django.utils.timezone.now", side_effect=lambda: self.current)
        self.mock_time.start(); self.addCleanup(self.mock_time.stop)
        self.site = Site.objects.create(site_id="LOC", name="Tracked Site", location_tracking_enabled=True,
                                        location_tracking_enabled_at=self.current, latitude=51.5, longitude=-.12)
        self.shift = ShiftType.objects.create(name="Location day", start_time=time(8), end_time=time(20))
        self.operation = DailyOperation.objects.create(operation_date=self.current.date(), employee=self.employee, site=self.site, shift_type=self.shift, created_by=self.admin)
        self.book_on(self.operation, self.guard)
        self.client.force_authenticate(self.guard)

    def book_on(self, operation, user):
        return ShiftAttendanceEvent.objects.create(operation=operation, event_type="BOOK_ON", photo="fixture/on.jpg", created_by=user,
            latitude=51.5, longitude=-.12, accuracy_m=8)

    def active(self):
        return self.client.get("/api/location-tracking/active/")

    def report(self, status="UPDATED", operation=None, **extra):
        body = {"status": status}
        if status == "UPDATED":
            body.update(latitude=51.51, longitude=-.13, accuracy_m=12, captured_at=self.current.isoformat())
        body.update(extra)
        return self.client.post(f"/api/location-tracking/{(operation or self.operation).pk}/report/", body, format="json")

    def test_default_site_setting_is_opt_in_and_office_can_enable_it(self):
        site = Site.objects.create(site_id="DEFAULT-LOC", name="Tracking off by default")
        self.assertFalse(site.location_tracking_enabled)
        self.client.force_authenticate(self.admin)
        response = self.client.patch(f"/api/sites/{site.pk}/", {"location_tracking_enabled": True}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["location_tracking_enabled_at"], self.current.isoformat().replace("+00:00", "Z"))

    def test_active_guard_sessions_seed_book_on_evidence_and_never_include_other_guards(self):
        other = DailyOperation.objects.create(operation_date=self.current.date(), employee=self.other_employee, site=self.site, shift_type=self.shift, created_by=self.admin)
        self.book_on(other, self.other)
        response = self.active()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual([item["operation_id"] for item in response.data["results"]], [self.operation.pk])
        self.assertEqual(response.data["results"][0]["status"], "UPDATED")
        self.assertEqual(response.data["time_zone"], "Europe/London")
        self.assertEqual(DutyLocationUpdate.objects.get(operation=self.operation).source, "BOOK_ON")
        self.active(); self.assertEqual(DutyLocationUpdate.objects.filter(operation=self.operation).count(), 1)

    def test_fresh_location_updates_history_and_deduplicates_retry(self):
        self.active(); self.current += timedelta(minutes=30)
        response = self.report()
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["tracking"]["point"]["latitude"], 51.51)
        self.assertEqual(self.report().status_code, 200)
        self.assertEqual(DutyLocationUpdate.objects.filter(operation=self.operation).count(), 2)
        self.assertEqual(self.client.get(f"/api/location-tracking/{self.operation.pk}/history/").data["results"][0]["status"], "UPDATED")

    def test_heartbeat_does_not_hide_a_missing_location_and_alert_is_deduplicated(self):
        self.active(); self.current += timedelta(minutes=34)
        self.assertEqual(self.report("HEARTBEAT").status_code, 200)
        state = DutyLocationState.objects.get(operation=self.operation)
        self.assertEqual(state.last_contact_at, self.current)
        self.assertEqual(state.last_location_at, self.current - timedelta(minutes=34))
        self.current += timedelta(minutes=1)
        self.assertEqual(refresh_location_alerts(), 1)
        self.assertEqual(refresh_location_alerts(), 0)
        state.refresh_from_db(); self.assertTrue(snapshot(self.operation, state)["overdue"])
        notice = Notification.objects.get(context__location_tracking=True)
        self.assertEqual(notice.category, "ATTENDANCE"); self.assertIsNone(notice.user_id)
        self.assertEqual(notice.context["operation_id"], self.operation.pk)

    def test_permission_failure_preserves_the_old_point_and_only_one_alert_until_recovery(self):
        self.active(); self.current += timedelta(minutes=5)
        response = self.report("PERMISSION_DENIED")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["tracking"]["point"]["latitude"], 51.5)
        self.assertEqual(response.data["tracking"]["status"], "PERMISSION_DENIED")
        self.current += timedelta(minutes=5)
        self.report("UNAVAILABLE"); self.assertEqual(Notification.objects.filter(context__location_tracking=True).count(), 1)
        self.current += timedelta(minutes=1)
        restored = self.report()
        self.assertEqual(restored.data["tracking"]["status"], "UPDATED")
        self.assertEqual(Notification.objects.filter(title="Location restored").count(), 1)
        self.assertTrue(Notification.objects.get(title="Permission denied").is_read)
        self.current += timedelta(minutes=1); self.report("TIMEOUT")
        self.assertEqual(Notification.objects.filter(context__location_tracking=True, is_read=False).count(), 2)  # one restoration + one new incident

    def test_coordinate_and_timestamp_validation_rejects_malformed_and_stale_evidence(self):
        self.active(); self.current += timedelta(minutes=30)
        for key, value in [("latitude", "nan"), ("latitude", "inf"), ("latitude", 91), ("longitude", -181), ("accuracy_m", -1), ("accuracy_m", None), ("latitude", True), ("captured_at", "not-a-date"), ("captured_at", (self.current - timedelta(minutes=5)).isoformat())]:
            with self.subTest(key=key, value=value):
                self.assertEqual(self.report(**{key: value}).status_code, 400)
        self.assertEqual(self.report("UNAVAILABLE", latitude=51).status_code, 400)
        self.assertEqual(self.client.post(f"/api/location-tracking/{self.operation.pk}/report/", {"status": []}, format="json").status_code, 400)
        self.assertEqual(DutyLocationUpdate.objects.filter(operation=self.operation).count(), 1)

    def test_other_guard_clients_and_unauthenticated_users_cannot_read_or_submit_evidence(self):
        self.active()
        self.client.force_authenticate(self.other)
        self.assertEqual(self.report().status_code, 404)
        self.assertEqual(self.client.get(f"/api/location-tracking/{self.operation.pk}/history/").status_code, 404)
        self.assertEqual(self.client.get("/api/location-tracking/tracker/").status_code, 403)
        self.client.force_authenticate(self.admin); self.assertEqual(self.report().status_code, 403)
        self.client.force_authenticate(None); self.assertEqual(self.active().status_code, 401)

    def test_manager_only_sees_assigned_sites_and_can_never_submit_guard_positions(self):
        self.active(); self.client.force_authenticate(self.manager)
        self.assertEqual(self.client.get("/api/location-tracking/tracker/").data["results"], [])
        self.manager.profile.managed_sites.add(self.site)
        self.assertEqual(len(self.client.get("/api/location-tracking/tracker/").data["results"]), 1)
        self.assertEqual(self.report().status_code, 403)

    def test_book_off_and_scheduled_end_stop_tracking_even_if_browser_remains_open(self):
        self.active(); self.report("PERMISSION_DENIED")
        ShiftAttendanceEvent.objects.create(operation=self.operation, event_type="BOOK_OFF", photo="fixture/off.jpg", created_by=self.guard)
        self.assertEqual(self.active().data["results"], [])
        self.assertEqual(self.report().status_code, 409)
        refresh_location_alerts(); self.assertTrue(Notification.objects.get(title="Permission denied").is_read)
        self.operation.attendance_events.filter(event_type="BOOK_OFF").delete()
        self.current = self.current.replace(hour=20)
        self.assertEqual(self.active().data["results"], [])
        self.assertEqual(self.report().status_code, 409)

    def test_site_disable_and_account_deactivation_reject_background_reports(self):
        self.active(); self.site.location_tracking_enabled = False; self.site.save()
        self.assertEqual(self.report().status_code, 409)
        self.site.location_tracking_enabled = True; self.site.save()
        self.guard.is_active = False; self.guard.save()
        self.assertEqual(self.report().status_code, 409)

    def test_reenabling_tracking_gets_a_new_grace_period(self):
        self.active(); self.current += timedelta(hours=2)
        self.client.force_authenticate(self.admin)
        self.client.patch(f"/api/sites/{self.site.pk}/", {"location_tracking_enabled": False}, format="json")
        self.client.patch(f"/api/sites/{self.site.pk}/", {"location_tracking_enabled": True}, format="json")
        self.client.force_authenticate(self.guard)
        result = self.active().data["results"][0]
        self.assertFalse(result["overdue"])
        self.assertEqual(datetime.fromisoformat(result["next_due_at"]), self.current + timedelta(minutes=30))

    def test_overnight_shift_is_in_today_tracker_and_stops_the_next_morning(self):
        self.shift.start_time, self.shift.end_time = time(20), time(8); self.shift.save()
        self.current = self.current.replace(hour=23)
        self.active(); self.current += timedelta(hours=2)
        self.assertEqual(len(self.active().data["results"]), 1)
        self.client.force_authenticate(self.admin)
        self.assertEqual(len(self.client.get(f"/api/location-tracking/tracker/?date={self.current.date()}").data["results"]), 1)
        self.client.force_authenticate(self.guard); self.current = self.current.replace(hour=8)
        self.assertEqual(self.active().data["results"], [])

    def test_location_evidence_cannot_be_reassigned_or_deleted(self):
        self.active(); self.client.force_authenticate(self.admin)
        response = self.client.patch(f"/api/operations/{self.operation.pk}/", {"employee": self.other_employee.pk}, format="json")
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(self.client.delete(f"/api/operations/{self.operation.pk}/").status_code, 400)

    def test_cron_command_is_safe_to_repeat_without_duplicate_alerts(self):
        self.active(); self.current += timedelta(minutes=36)
        call_command("check_location_tracking", stdout=StringIO())
        call_command("check_location_tracking", stdout=StringIO())
        self.assertEqual(Notification.objects.filter(context__location_tracking=True).count(), 1)

    def test_elapsed_location_interval_stays_30_minutes_through_bst_change(self):
        for instant in [datetime(2026, 3, 29, 0, 50, tzinfo=datetime_timezone.utc), datetime(2026, 10, 25, 0, 50, tzinfo=datetime_timezone.utc)]:
            with self.subTest(instant=instant):
                state = DutyLocationState(operation=self.operation, tracking_started_at=instant, last_location_at=instant)
                self.assertEqual((next_due(state) - instant).total_seconds(), 1800)


class AttendanceTrackingIntegrationTests(AttendanceFixture, APITestCase):
    def test_real_book_on_seeds_location_and_book_off_resolves_tracking_incident(self):
        self.basic_site.location_tracking_enabled = True
        self.basic_site.save()
        response = self.submit(self.basic, "BOOK_ON", self.now(8))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(DutyLocationState.objects.filter(operation=self.basic).exists())
        self.assertEqual(DutyLocationUpdate.objects.get(operation=self.basic).source, "BOOK_ON")
        with patch("django.utils.timezone.now", return_value=self.now(8, 10)):
            denied = self.client.post(f"/api/location-tracking/{self.basic.pk}/report/", {"status": "PERMISSION_DENIED"}, format="json")
        self.assertEqual(denied.status_code, 201, denied.data)
        response = self.submit(self.basic, "BOOK_OFF", self.now(20, 10))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(Notification.objects.get(title="Permission denied").is_read)
        self.assertFalse(DutyLocationState.objects.get(operation=self.basic).incident_open)
