from datetime import datetime, time, timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Client, DailyOperation, Employee, Notification, ShiftAttendanceEvent, ShiftType, Site, UserProfile
from .notification_alerts import refresh_operational_alerts
from .notification_rules import GUARD_CATEGORIES
from .notifications import publish_notification


class GuardNotificationInboxTests(APITestCase):
    def setUp(self):
        cache.clear()
        User = get_user_model()
        self.guard = User.objects.create_user(username="guard-inbox-one")
        self.other = User.objects.create_user(username="guard-inbox-two")
        self.admin = User.objects.create_user(username="guard-inbox-office")
        for user, role in ((self.guard, "EMPLOYEE"), (self.other, "EMPLOYEE"), (self.admin, "ADMIN")):
            UserProfile.objects.update_or_create(user=user, defaults={"role": role})
        self.employee = Employee.objects.create(employee_id="GIN-1", name="Inbox First Guard", user=self.guard)
        self.other_employee = Employee.objects.create(employee_id="GIN-2", name="Inbox Second Guard", user=self.other)
        self.client.force_authenticate(self.guard)

    def inbox(self, query=""):
        response = self.client.get("/api/notifications/guard-inbox/" + query)
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_seven_categories_and_counts_only_include_this_guards_non_system_alerts(self):
        for key, _ in GUARD_CATEGORIES:
            publish_notification(user=self.guard, title=f"My {key} update", message="Own information", category=key)
        Notification.objects.create(title="Office attendance reason", category="ATTENDANCE", message="Office-only notes")
        Notification.objects.create(user=self.other, title="Other guard documents", category="DOCUMENT_REVIEW")
        Notification.objects.create(user=self.admin, title="Admin screening", category="REGISTRATION_SCREENING")
        Notification.objects.create(user=self.guard, title="Legacy provider error", category="SYSTEM")
        data = self.inbox()
        self.assertEqual(data["summary"]["total"], 7)
        self.assertEqual(data["summary"]["unread"], 7)
        self.assertEqual(len(data["summary"]["categories"]), 7)
        self.assertNotIn("SYSTEM", {item["key"] for item in data["summary"]["categories"]})
        self.assertEqual(self.inbox("?category=DOCUMENT_REVIEW")["results"][0]["category_label"], "Documents Updates")
        self.assertEqual(len(self.client.get("/api/notifications/").data), 7)
        self.assertEqual(self.client.get("/api/notifications/guard-inbox/?category=SYSTEM").status_code, 400)

    def test_mark_all_read_applies_across_pages_and_never_changes_other_audiences(self):
        for index in range(28):
            Notification.objects.create(user=self.guard, category="ROTA_STAFFING", title=f"Rota update {index}")
        protected = [Notification.objects.create(user=self.other, category="ATTENDANCE", title="Other guard"), Notification.objects.create(category="ATTENDANCE", title="Office only"), Notification.objects.create(user=self.guard, category="SYSTEM", title="Hidden system update")]
        self.assertEqual(self.inbox()["pagination"]["total_pages"], 2)
        response = self.client.post("/api/notifications/mark-all-read/", {"user": self.other.pk, "ids": [item.pk for item in protected]}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["updated"], 28)
        self.assertEqual(self.inbox()["summary"]["unread"], 0)
        self.assertEqual(self.client.post("/api/notifications/mark-all-read/").data["updated"], 0)
        self.assertFalse(Notification.objects.filter(pk__in=[item.pk for item in protected], is_read=True).exists())

    def test_unread_urgent_search_and_individual_mark_read_work_together(self):
        urgent, _ = publish_notification(user=self.guard, title="Missed Book Off", message="My shift at Test Site", link="attendance", context={"operation_id": 31, "event_date": "2026-11-03"})
        publish_notification(user=self.guard, title="Leave approved", message="Own leave decision", link="leave")
        results = self.inbox("?view=URGENT&q=Test%20Site")["results"]
        self.assertEqual([item["id"] for item in results], [urgent.pk])
        self.assertEqual(results[0]["context"]["operation_id"], 31)
        self.assertEqual(self.client.post(f"/api/notifications/{urgent.pk}/mark_read/").status_code, 200)
        self.assertEqual(self.inbox("?view=URGENT")["pagination"]["total"], 0)
        self.assertEqual(self.inbox("?view=UNREAD")["pagination"]["total"], 1)

    def test_guard_cannot_access_other_alerts_or_admin_inbox_and_admin_cannot_use_guard_bulk_action(self):
        for user in (None, self.other, self.admin):
            item = Notification.objects.create(user=user, category="ATTENDANCE", title="Restricted")
            self.assertEqual(self.client.get(f"/api/notifications/{item.pk}/").status_code, 404)
            self.assertEqual(self.client.post(f"/api/notifications/{item.pk}/mark_read/").status_code, 404)
        self.assertEqual(self.client.get("/api/notifications/inbox/").status_code, 403)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get("/api/notifications/guard-inbox/").status_code, 403)
        self.assertEqual(self.client.post("/api/notifications/mark-all-read/").status_code, 403)

    def operation(self, employee, hourly=False):
        client, _ = Client.objects.get_or_create(client_id="GIN-C", defaults={"name": "Guard inbox client"})
        site, _ = Site.objects.get_or_create(site_id="GIN-S", defaults={"name": "Guard inbox site", "client": client, "attendance_mode": "WITH_HOURLY" if hourly else "BOOK_ON_OFF"})
        shift, _ = ShiftType.objects.get_or_create(name="Guard inbox day", defaults={"start_time": time(7), "end_time": time(19)})
        return DailyOperation.objects.create(operation_date=timezone.localdate(), employee=employee, site=site, shift_type=shift, created_by=self.admin)

    def test_guard_refresh_only_generates_own_attendance_alerts_and_deduplicates_with_office_scan(self):
        operation = self.operation(self.employee)
        self.operation(self.other_employee)
        now = timezone.make_aware(datetime.combine(operation.operation_date, time(10)))
        self.assertEqual(refresh_operational_alerts(now, employee_user=self.guard), 1)
        self.assertEqual(refresh_operational_alerts(now, employee_user=self.guard), 0)
        self.assertEqual(Notification.objects.count(), 1)
        self.assertEqual(Notification.objects.get().user_id, self.guard.pk)
        refresh_operational_alerts(now)
        self.assertEqual(Notification.objects.filter(user=self.guard, title="Missed Book On").count(), 1)
        self.assertEqual(Notification.objects.filter(user=self.other, title="Missed Book On").count(), 1)
        self.assertEqual(Notification.objects.filter(user__isnull=True, title="Missed Book On").count(), 2)

    def test_reminders_and_hourly_misses_follow_site_policy_and_stay_personal(self):
        operation = self.operation(self.employee, hourly=True)
        self.assertEqual(refresh_operational_alerts(operation.scheduled_start_at - timedelta(minutes=10), employee_user=self.guard), 1)
        self.assertEqual(Notification.objects.get().title, "Book On reminder")
        event = ShiftAttendanceEvent.objects.create(operation=operation, event_type="BOOK_ON", photo="tests/on.jpg", location_status="VERIFIED", created_by=self.guard)
        ShiftAttendanceEvent.objects.filter(pk=event.pk).update(captured_at=operation.scheduled_start_at)
        refresh_operational_alerts(operation.scheduled_start_at + timedelta(hours=1, minutes=10), employee_user=self.guard)
        self.assertTrue(Notification.objects.filter(user=self.guard, title="Hourly picture reminder").exists())
        refresh_operational_alerts(operation.scheduled_start_at + timedelta(hours=1, minutes=40), employee_user=self.guard)
        self.assertTrue(Notification.objects.filter(user=self.guard, title="Missed hourly picture", priority="URGENT").exists())
        self.assertFalse(Notification.objects.filter(user__isnull=True).exists())
