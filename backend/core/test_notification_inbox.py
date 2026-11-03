from datetime import datetime, time, timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Client, DailyOperation, Employee, EmployeeDocument, Notification, ShiftAttendanceEvent, ShiftType, Site, UserProfile
from .notification_alerts import refresh_operational_alerts
from .notification_rules import CATEGORIES, classify_notification
from .notifications import publish_notification
from .views import create_expiry_notifications


class NotificationInboxTests(APITestCase):
    def setUp(self):
        cache.clear()
        User = get_user_model()
        self.admin = User.objects.create_user(username="inbox-admin")
        self.guard = User.objects.create_user(username="inbox-guard")
        self.other_admin = User.objects.create_user(username="inbox-other-admin")
        for user, role in ((self.admin, "ADMIN"), (self.guard, "EMPLOYEE"), (self.other_admin, "ADMIN")):
            UserProfile.objects.update_or_create(user=user, defaults={"role": role})
        self.employee = Employee.objects.create(name="Inbox Guard", employee_id="INBOX-1", user=self.guard)
        self.client.force_authenticate(self.admin)

    def inbox(self, query=""):
        response = self.client.get("/api/notifications/inbox/" + query)
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_categories_priority_and_personal_audience_are_independent(self):
        for category, _ in CATEGORIES:
            publish_notification(title=f"Example {category}", message="Office update", category=category, event_key=category)
        urgent, _ = publish_notification(title="Document expired", message="Passport renewal required", link="documents")
        Notification.objects.create(user=self.guard, title="Private guard alert", message="Must never leak", category="ATTENDANCE", priority="URGENT")
        Notification.objects.create(user=self.other_admin, title="Other admin personal alert", message="Must never leak", category="SYSTEM")
        data = self.inbox()
        self.assertEqual(data["summary"]["total"], 9)
        self.assertEqual(data["summary"]["unread"], 9)
        self.assertEqual(data["summary"]["urgent"], 1)
        self.assertEqual(len(data["summary"]["categories"]), 8)
        self.assertEqual({item["id"] for item in self.inbox("?view=URGENT")["results"]}, {urgent.pk})
        self.assertEqual({item["category"] for item in self.inbox("?category=DOCUMENT_EXPIRY")["results"]}, {"DOCUMENT_EXPIRY"})
        self.assertEqual(self.inbox("?q=renewal")["pagination"]["total"], 1)
        self.assertEqual(self.client.post(f"/api/notifications/{urgent.pk}/mark_read/").status_code, 200)
        self.assertEqual(self.inbox("?view=URGENT")["pagination"]["total"], 0)
        self.assertEqual(self.inbox()["summary"]["unread"], 8)

    def test_invalid_filters_and_guard_inbox_are_rejected_without_leaking_counts(self):
        for query in ("?view=BAD", "?category=BAD"):
            self.assertEqual(self.client.get("/api/notifications/inbox/" + query).status_code, 400)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get("/api/notifications/inbox/").status_code, 403)

    def test_pagination_is_stable_and_summary_counts_cover_all_pages(self):
        Notification.objects.bulk_create([Notification(title=f"Notice {index}", category="SYSTEM") for index in range(28)])
        first, second = self.inbox(), self.inbox("?page=2")
        self.assertEqual(first["summary"]["total"], 28)
        self.assertEqual(len(first["results"]), 25)
        self.assertEqual(len(second["results"]), 3)
        self.assertFalse({item["id"] for item in first["results"]} & {item["id"] for item in second["results"]})

    def test_repeated_events_deduplicate_without_merging_different_guard_copies(self):
        kwargs = dict(title="Shift update", message="Same event", link="attendance", event_key="same-event", employee=self.employee, context={"operation_id": 42})
        first, created = publish_notification(**kwargs)
        self.assertTrue(created)
        same, created = publish_notification(**kwargs)
        self.assertFalse(created)
        self.assertEqual(first.pk, same.pk)
        personal, created = publish_notification(user=self.guard, **kwargs)
        self.assertTrue(created)
        self.assertNotEqual(first.pk, personal.pk)
        self.assertEqual(first.context["employee_name"], self.employee.name)
        self.client.force_authenticate(self.guard)
        self.assertEqual({item["id"] for item in self.client.get("/api/notifications/").data}, {personal.pk})

    def test_legacy_titles_are_categorised_and_expiry_reminders_do_not_repeat_daily(self):
        samples = [("Document expired", "", "DOCUMENT_EXPIRY"), ("New document uploaded", "documents", "DOCUMENT_REVIEW"), ("Security screening submitted", "", "REGISTRATION_SCREENING"), ("Missed Book Off", "", "ATTENDANCE"), ("Weekly rota published", "", "ROTA_STAFFING"), ("New guard leave request", "", "LEAVE_REPLACEMENT"), ("Shift completed", "timesheets", "TIMESHEETS"), ("Google Drive upload failed", "documents", "SYSTEM")]
        for title, link, category in samples:
            alert = Notification.objects.create(title=title, link=link)
            self.assertEqual(alert.category, category)
            self.assertEqual(classify_notification(title, link)[0], category)
        expiry = timezone.localdate() + timedelta(days=10)
        document = EmployeeDocument.objects.create(employee=self.employee, document_type="Passport", expiry_date=expiry, created_by=self.admin)
        self.assertEqual(create_expiry_notifications(None), 2)
        self.assertEqual(create_expiry_notifications(None), 0)
        document.expiry_date = timezone.localdate() - timedelta(days=1)
        document.save()
        self.assertEqual(create_expiry_notifications(None), 2)
        alerts = Notification.objects.filter(context__document_id=document.pk, title="Document expired")
        self.assertEqual(alerts.count(), 2)
        self.assertTrue(all(alert.priority == "URGENT" for alert in alerts))

    def test_document_review_metadata_and_review_decisions_do_not_generate_duplicate_upload_alerts(self):
        document = EmployeeDocument.objects.create(employee=self.employee, document_type="Certificates", certificate_type="NASDU", file="tests/certificate.pdf", created_by=self.admin)
        alert = Notification.objects.get(category="DOCUMENT_REVIEW")
        self.assertEqual(alert.context["document_id"], document.pk)
        self.assertEqual(alert.context["employee_record_id"], self.employee.pk)
        document.verification_status = "VERIFIED"
        document.save(update_fields=["verification_status"])
        self.assertEqual(Notification.objects.filter(category="DOCUMENT_REVIEW").count(), 1)

    def test_two_certificates_with_the_same_expiry_are_distinct_issues_without_daily_duplicates(self):
        for _ in range(2):
            EmployeeDocument.objects.create(employee=self.employee, document_type="Certificates", certificate_type="NASDU", expiry_date=timezone.localdate() + timedelta(days=10), created_by=self.admin)
        self.assertEqual(create_expiry_notifications(None), 4)
        self.assertEqual(create_expiry_notifications(None), 0)
        self.assertEqual(Notification.objects.filter(category="DOCUMENT_EXPIRY", user__isnull=True).count(), 2)

    def test_current_shift_alerts_follow_site_rules_and_ignore_previous_day_shifts(self):
        today = timezone.localdate()
        client = Client.objects.create(client_id="INBOX-C", name="Inbox client")
        site = Site.objects.create(site_id="INBOX-S", name="Inbox site", client=client, attendance_mode="BOOK_ON_OFF")
        shift = ShiftType.objects.create(name="Inbox day", start_time=time(7), end_time=time(19))
        operation = DailyOperation.objects.create(operation_date=today, site=site, shift_type=shift, employee=self.employee, created_by=self.admin)
        now = timezone.make_aware(datetime.combine(today, time(10)))
        self.assertEqual(refresh_operational_alerts(now), 2)
        self.assertEqual(refresh_operational_alerts(now), 0)
        self.assertTrue(Notification.objects.filter(title="Missed Book On", context__operation_id=operation.pk).exists())
        event = ShiftAttendanceEvent.objects.create(operation=operation, event_type="BOOK_ON", photo="tests/on.jpg", location_status="VERIFIED", created_by=self.guard)
        ShiftAttendanceEvent.objects.filter(pk=event.pk).update(captured_at=operation.scheduled_start_at)
        operation.operation_date = today - timedelta(days=1)
        operation.save()
        before = Notification.objects.count()
        self.assertEqual(refresh_operational_alerts(now), 0)
        self.assertEqual(Notification.objects.count(), before)
        self.assertFalse(Notification.objects.filter(title="Missed hourly picture").exists())
