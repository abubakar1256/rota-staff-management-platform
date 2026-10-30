from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Employee, EmployeeDocument, LeaveRecord, Notification, UserProfile
from .views import create_expiry_notifications


class NotificationAudienceTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user(username="notice-admin")
        self.super_admin = User.objects.create_superuser(username="notice-root", email="root@example.com", password="test-password")
        self.guard = User.objects.create_user(username="notice-guard")
        self.other_guard = User.objects.create_user(username="notice-other")
        self.manager = User.objects.create_user(username="notice-manager")
        self.operator = User.objects.create_user(username="notice-operator")
        self.client_admin = User.objects.create_user(username="notice-client")
        for user, role in ((self.admin, "ADMIN"), (self.guard, "EMPLOYEE"), (self.other_guard, "EMPLOYEE"),
                           (self.manager, "MANAGER"), (self.operator, "OPERATOR"), (self.client_admin, "CLIENT_ADMIN")):
            UserProfile.objects.update_or_create(user=user, defaults={"role": role})
        self.employee = Employee.objects.create(employee_id="NOTICE-1", name="First notification guard", user=self.guard)
        self.other_employee = Employee.objects.create(employee_id="NOTICE-2", name="Second notification guard", user=self.other_guard)
        self.shared = Notification.objects.create(title="Admin leave queue", message="Office-only information")
        self.admin_alert = Notification.objects.create(user=self.admin, title="Admin approval", message="Admin-only information")
        self.guard_alert = Notification.objects.create(user=self.guard, title="Your screening", message="First guard information")
        self.other_alert = Notification.objects.create(user=self.other_guard, title="Your document", message="Second guard information")

    def inbox_ids(self, user):
        self.client.force_authenticate(user)
        response = self.client.get("/api/notifications/")
        self.assertEqual(response.status_code, 200)
        return {item["id"] for item in response.data}

    def document(self, employee):
        return EmployeeDocument.objects.create(employee=employee, document_type="Passport", expiry_date=timezone.localdate() + timedelta(days=10), created_by=self.admin)

    def test_each_guard_sees_only_their_own_notifications(self):
        self.assertEqual(self.inbox_ids(self.guard), {self.guard_alert.pk})
        self.assertEqual(self.inbox_ids(self.other_guard), {self.other_alert.pk})

    def test_admin_broadcasts_are_only_for_admin_and_super_admin(self):
        self.assertEqual(self.inbox_ids(self.admin), {self.admin_alert.pk, self.shared.pk})
        self.assertEqual(self.inbox_ids(self.super_admin), {self.shared.pk})
        for user in (self.manager, self.operator):
            personal = Notification.objects.create(user=user, title="Personal update", message="Only this user")
            self.assertEqual(self.inbox_ids(user), {personal.pk})

    def test_guard_cannot_retrieve_or_mark_another_audiences_alert(self):
        self.client.force_authenticate(self.guard)
        for alert in (self.shared, self.admin_alert, self.other_alert):
            self.assertEqual(self.client.get(f"/api/notifications/{alert.pk}/").status_code, 404)
            self.assertEqual(self.client.post(f"/api/notifications/{alert.pk}/mark_read/").status_code, 404)
            alert.refresh_from_db()
            self.assertFalse(alert.is_read)
        self.assertEqual(self.client.post(f"/api/notifications/{self.guard_alert.pk}/mark_read/").status_code, 200)
        self.guard_alert.refresh_from_db()
        self.assertTrue(self.guard_alert.is_read)
        self.other_alert.refresh_from_db()
        self.assertFalse(self.other_alert.is_read)

    def test_admin_cannot_read_guard_personal_alerts_by_id(self):
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get(f"/api/notifications/{self.guard_alert.pk}/").status_code, 404)
        self.assertEqual(self.client.post(f"/api/notifications/{self.guard_alert.pk}/mark_read/").status_code, 404)

    def test_guard_expiry_check_only_generates_their_own_reminders(self):
        self.document(self.employee)
        self.document(self.other_employee)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.post("/api/notifications/check_expiry/").data["created"], 1)
        self.assertEqual(self.client.post("/api/notifications/check_expiry/").data["created"], 0)
        reminders = Notification.objects.filter(title="Document expires soon")
        self.assertEqual(list(reminders.values_list("user_id", flat=True)), [self.guard.pk])
        self.assertIn(self.employee.name, reminders.get().message)
        self.assertNotIn(self.other_employee.name, reminders.get().message)

    def test_scheduled_expiry_alerts_have_separate_office_and_guard_copies(self):
        self.document(self.employee)
        self.document(self.other_employee)
        self.assertEqual(create_expiry_notifications(None), 4)
        self.assertEqual(create_expiry_notifications(self.admin), 0)
        guard_messages = Notification.objects.filter(pk__in=self.inbox_ids(self.guard), title="Document expires soon")
        self.assertEqual(guard_messages.count(), 1)
        self.assertIn(self.employee.name, guard_messages.get().message)
        admin_messages = Notification.objects.filter(pk__in=self.inbox_ids(self.admin), title="Document expires soon")
        self.assertEqual(admin_messages.count(), 2)
        personal = guard_messages.get()
        self.client.force_authenticate(self.guard)
        self.client.post(f"/api/notifications/{personal.pk}/mark_read/")
        self.assertFalse(Notification.objects.filter(user__isnull=True, title="Document expires soon", is_read=True).exists())

    def test_leave_decision_goes_to_the_applicant_guard(self):
        self.client.force_authenticate(self.admin)
        today = timezone.localdate()
        for action in ("approve", "reject"):
            leave = LeaveRecord.objects.create(employee=self.employee, start_date=today, end_date=today, created_by=self.guard)
            response = self.client.post(f"/api/leave/{leave.pk}/{action}/")
            self.assertEqual(response.status_code, 200)
            title = "Leave approved" if action == "approve" else "Leave rejected"
            notice = Notification.objects.get(title=title)
            self.assertEqual(notice.user_id, self.guard.pk)
            self.assertNotIn(notice.pk, self.inbox_ids(self.other_guard))
            self.assertNotIn(notice.pk, self.inbox_ids(self.admin))

    def test_guard_leave_request_alert_is_only_in_admin_inboxes(self):
        self.client.force_authenticate(self.guard)
        today = timezone.localdate().isoformat()
        response = self.client.post("/api/leave/", {"start_date": today, "end_date": today, "reason": "Time off"}, format="json")
        self.assertEqual(response.status_code, 201)
        alert = Notification.objects.get(title="New guard leave request")
        self.assertIn(alert.pk, self.inbox_ids(self.admin))
        self.assertIn(alert.pk, self.inbox_ids(self.super_admin))
        for user in (self.guard, self.other_guard, self.manager, self.operator):
            self.assertNotIn(alert.pk, self.inbox_ids(user))

    def test_screening_submission_notifies_active_admins_including_superusers(self):
        inactive = get_user_model().objects.create_user(username="notice-inactive", is_active=False)
        UserProfile.objects.update_or_create(user=inactive, defaults={"role": "ADMIN"})
        self.client.force_authenticate(self.guard)
        case = self.client.get("/api/security-screenings/my/").data
        response = self.client.post(f"/api/security-screenings/{case['id']}/submit/", {"form_data": {
            "full_name": self.employee.name, "signature_name": self.employee.name, "declaration_accepted": True,
        }}, format="json")
        self.assertEqual(response.status_code, 200)
        recipients = set(Notification.objects.filter(title="Security screening submitted").values_list("user_id", flat=True))
        self.assertEqual(recipients, {self.admin.pk, self.super_admin.pk})

    def test_unauthenticated_and_client_users_cannot_access_internal_notifications(self):
        self.assertIn(self.client.get("/api/notifications/").status_code, (401, 403))
        self.client.force_authenticate(self.client_admin)
        self.assertEqual(self.client.get("/api/notifications/").status_code, 403)
