import hashlib
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Employee, EmployeePortalInvite, UserProfile


class ActivationIdentityTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user(username="invite-admin")
        self.guard = User.objects.create_user(username="invite.guard@example.com", email="invite.guard@example.com")
        UserProfile.objects.update_or_create(user=self.guard, defaults={"role": "EMPLOYEE"})
        self.employee = Employee.objects.create(employee_id="ACTIVATE-1", name="Invited Guard", email=self.guard.email, user=self.guard)
        self.raw_token = "synthetic-activation-identity-token"
        self.invite = EmployeePortalInvite.objects.create(
            employee=self.employee, token=self.raw_token,
            token_hash=hashlib.sha256(self.raw_token.encode()).hexdigest(),
            expires_at=timezone.now() + timedelta(hours=48), created_by=self.admin,
        )

    def details(self, token=None, **extras):
        return self.client.post("/api/auth/activation-details/", {"token": self.raw_token if token is None else token, **extras}, format="json")

    def test_preview_only_shows_invited_name_and_email_without_consuming_invite(self):
        for _ in range(2):
            response = self.details()
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data, {"name": "Invited Guard", "email": self.guard.email})
            self.assertEqual(response["Cache-Control"], "no-store")
        self.invite.refresh_from_db()
        self.guard.refresh_from_db()
        self.assertIsNone(self.invite.used_at)
        self.assertFalse(self.guard.has_usable_password())

    def test_invalid_missing_and_malformed_tokens_do_not_reveal_guard_details(self):
        for token in ("", "unknown-token", "x" * 129, [], {"id": self.employee.pk}):
            with self.subTest(token=token):
                response = self.details(token)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(set(response.data), {"detail"})
        self.assertEqual(self.client.post("/api/auth/activation-details/", {}, format="json").status_code, 400)

    def test_used_and_expired_invites_cannot_preview_identity(self):
        self.invite.expires_at = timezone.now() - timedelta(seconds=1)
        self.invite.save()
        self.assertEqual(self.details().status_code, 400)
        self.invite.expires_at = timezone.now() + timedelta(hours=1)
        self.invite.used_at = timezone.now()
        self.invite.save()
        self.assertEqual(self.details().status_code, 400)

    def test_preview_uses_current_office_details_and_ignores_identity_edits(self):
        self.employee.name = "Office Updated Name"
        self.employee.email = "updated.guard@example.com"
        self.employee.save()
        response = self.details(name="Replaced name", email="wrong@example.com")
        self.assertEqual(response.data, {"name": "Office Updated Name", "email": "updated.guard@example.com"})
        self.employee.refresh_from_db()
        self.assertEqual(self.employee.name, "Office Updated Name")
        self.assertEqual(self.employee.email, "updated.guard@example.com")

    def test_activation_still_sets_password_only_and_makes_preview_unavailable(self):
        response = self.client.post("/api/auth/activate/", {
            "token": self.raw_token, "password": "GuardPassword123!", "password_confirmation": "GuardPassword123!",
            "name": "Replaced name", "email": "wrong@example.com",
        }, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.guard.refresh_from_db()
        self.employee.refresh_from_db()
        self.assertTrue(self.guard.check_password("GuardPassword123!"))
        self.assertEqual(self.employee.name, "Invited Guard")
        self.assertEqual(self.guard.email, "invite.guard@example.com")
        self.assertEqual(self.details().status_code, 400)
