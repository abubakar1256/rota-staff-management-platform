import base64
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient, APITestCase

from .admin_auth import decrypt_secret, digest, encrypt_secret, fingerprint, recovery_digest, totp
from .models import AdminLoginChallenge, AdminLoginEvent, AdminMFAProfile, AdminSession, PasswordResetOTP, UserProfile
from .serializers import UserSerializer

User = get_user_model()
PASSWORD = "Clear-water-stones!58"
SECRET = base64.b32encode(b"12345678901234567890").decode()


class TOTPTests(TestCase):
    def test_rfc6238_reference_vectors(self):
        for timestamp, expected in [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"), (1234567890, "89005924"), (2000000000, "69279037"), (20000000000, "65353130")]:
            self.assertEqual(totp(SECRET, timestamp // 30, digits=8), expected)


class AdminSecurityTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="secure-office", password=PASSWORD, is_staff=True)
        UserProfile.objects.update_or_create(user=self.admin, defaults={"role": "ADMIN"})
        self.now = timezone.now()
        self.clock = patch("django.utils.timezone.now", return_value=self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def login(self, user=None, password=PASSWORD):
        self.client.credentials()
        return self.client.post("/api/auth/login/", {"username": (user or self.admin).username, "password": password}, format="json")

    def enroll(self, user=None, password=PASSWORD, new_password=None):
        user = user or self.admin
        response = self.login(user, password)
        self.assertEqual(response.status_code, 200, response.data)
        code = totp(response.data["secret"], int(self.now.timestamp()) // 30)
        body = {"challenge": response.data["challenge"], "code": code}
        if new_password:
            body.update(new_password=new_password, confirm_password=new_password)
        verified = self.client.post("/api/auth/admin-verify/", body, format="json")
        self.assertEqual(verified.status_code, 200, verified.data)
        self.client.credentials(HTTP_AUTHORIZATION="Token " + verified.data["token"])
        return verified.data

    def test_password_only_cannot_access_portal_or_issue_token(self):
        response = self.login()
        self.assertTrue(response.data["setup_required"])
        self.assertNotIn("token", response.data)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertTrue(response.data["qr_image"].startswith("data:image/svg+xml;base64,"))
        self.assertNotIn("<script", base64.b64decode(response.data["qr_image"].split(",")[1]).decode())
        self.assertFalse(Token.objects.filter(user=self.admin).exists())
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)

    def test_enrollment_encrypts_secret_hashes_session_and_recovery_codes(self):
        result = self.enroll()
        profile = AdminMFAProfile.objects.get(user=self.admin)
        self.assertTrue(profile.enabled_at)
        self.assertNotEqual(profile.encrypted_secret, decrypt_secret(profile.encrypted_secret))
        self.assertEqual(len(result["recovery_codes"]), 8)
        self.assertEqual(profile.recovery_hashes, [recovery_digest(item) for item in result["recovery_codes"]])
        session = AdminSession.objects.get(user=self.admin)
        self.assertEqual(session.key_hash, digest(result["token"]))
        self.assertNotEqual(session.key_hash, result["token"])
        response = self.client.get("/api/auth/me/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["admin_session"]["id"], str(session.pk))
        self.assertNotIn("secret", str(self.client.get("/api/auth/admin-security/").data))
        self.assertNotIn(result["token"], str(self.client.get("/api/auth/login-history/").data))

    def test_existing_admin_token_and_password_only_django_session_are_rejected(self):
        token = Token.objects.create(user=self.admin)
        self.client.credentials(HTTP_AUTHORIZATION="Token " + token.key)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.client.credentials()
        self.client.force_login(self.admin)
        self.assertIn(self.client.get("/api/auth/me/").status_code, [401, 403])
        self.assertEqual(self.client.get("/admin/").status_code, 302)

    def test_weak_existing_password_must_be_replaced_before_session(self):
        self.admin.set_password("Admin123!"); self.admin.save()
        response = self.login(password="Admin123!")
        self.assertTrue(response.data["password_change_required"])
        body = {"challenge": response.data["challenge"], "code": totp(response.data["secret"], int(self.now.timestamp()) // 30)}
        self.assertEqual(self.client.post("/api/auth/admin-verify/", body, format="json").status_code, 400)
        self.assertFalse(AdminSession.objects.exists())
        body.update(new_password=PASSWORD, confirm_password=PASSWORD)
        self.assertEqual(self.client.post("/api/auth/admin-verify/", body, format="json").status_code, 200)
        self.admin.refresh_from_db(); self.assertTrue(self.admin.check_password(PASSWORD))

    def test_new_admin_password_validation_and_guard_policy(self):
        for weak in ["Short12!", "12345678901234", "password1234"]:
            serializer = UserSerializer(data={"username": "new-admin", "role": "ADMIN", "password": weak})
            self.assertFalse(serializer.is_valid(), f"{weak}: {serializer.errors}")
            with self.assertRaises(ValidationError):
                validate_password(weak, self.admin)
        guard = User.objects.create_user(username="guard")
        UserProfile.objects.update_or_create(user=guard, defaults={"role": "EMPLOYEE"})
        validate_password("Lamp42!x", guard)

    def test_expired_consumed_and_changed_account_challenges_fail(self):
        response = self.login(); raw = response.data["challenge"]
        challenge = AdminLoginChallenge.objects.get(key_hash=digest(raw))
        challenge.expires_at = self.now - timedelta(seconds=1); challenge.save()
        self.assertEqual(self.client.post("/api/auth/admin-verify/", {"challenge": raw, "code": "000000"}, format="json").status_code, 400)
        response = self.login()
        self.admin.set_password("Different-strong-phrase!42"); self.admin.save()
        self.assertEqual(self.client.post("/api/auth/admin-verify/", {"challenge": response.data["challenge"], "code": totp(response.data["secret"], int(self.now.timestamp()) // 30)}, format="json").status_code, 400)

    def test_replayed_authenticator_code_and_used_challenge_fail(self):
        data = self.enroll()
        response = self.login()
        self.assertFalse(response.data["setup_required"])
        self.assertNotIn("secret", response.data)
        secret = decrypt_secret(AdminMFAProfile.objects.get(user=self.admin).encrypted_secret)
        code = totp(secret, int(self.now.timestamp()) // 30)
        self.assertEqual(self.client.post("/api/auth/admin-verify/", {"challenge": response.data["challenge"], "code": code}, format="json").status_code, 400)
        body = {"challenge": response.data["challenge"], "use_recovery": True, "code": data["recovery_codes"][0]}
        self.assertEqual(self.client.post("/api/auth/admin-verify/", body, format="json").status_code, 200)
        self.assertEqual(self.client.post("/api/auth/admin-verify/", body, format="json").status_code, 400)

    def test_recovery_code_is_single_use_and_remaining_count_updates(self):
        data = self.enroll(); response = self.login()
        body = {"challenge": response.data["challenge"], "use_recovery": True, "code": data["recovery_codes"][0]}
        self.assertEqual(self.client.post("/api/auth/admin-verify/", body, format="json").status_code, 200)
        response = self.login(); body["challenge"] = response.data["challenge"]
        self.assertEqual(self.client.post("/api/auth/admin-verify/", body, format="json").status_code, 400)
        self.assertEqual(len(AdminMFAProfile.objects.get(user=self.admin).recovery_hashes), 7)

    def test_mfa_lockout_cannot_be_bypassed_with_new_challenges(self):
        self.enroll()
        for _ in range(5):
            response = self.login()
            self.assertEqual(self.client.post("/api/auth/admin-verify/", {"challenge": response.data["challenge"], "code": "bad"}, format="json").status_code, 400)
        profile = AdminMFAProfile.objects.get(user=self.admin)
        self.assertGreater(profile.locked_until, self.now)
        response = self.login()
        valid_code = totp(decrypt_secret(profile.encrypted_secret), int(self.now.timestamp()) // 30 + 1)
        self.assertEqual(self.client.post("/api/auth/admin-verify/", {"challenge": response.data["challenge"], "code": valid_code}, format="json").status_code, 400)

    def test_polling_does_not_extend_idle_but_user_activity_does(self):
        self.enroll()
        session = AdminSession.objects.get(user=self.admin)
        AdminSession.objects.filter(pk=session.pk).update(last_activity_at=self.now - timedelta(minutes=29))
        for _ in range(3):
            self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)
        session.refresh_from_db(); self.assertEqual(session.last_activity_at, self.now - timedelta(minutes=29))
        self.assertEqual(self.client.post("/api/auth/admin-activity/").status_code, 200)
        session.refresh_from_db(); self.assertEqual(session.last_activity_at, self.now)

    def test_idle_and_absolute_expiry_are_enforced_server_side(self):
        data = self.enroll(); session = AdminSession.objects.get(user=self.admin)
        AdminSession.objects.filter(pk=session.pk).update(last_activity_at=self.now - timedelta(minutes=30))
        self.assertEqual(self.client.post("/api/auth/admin-activity/").status_code, 401)
        session.refresh_from_db(); self.assertIsNotNone(session.revoked_at)
        AdminSession.objects.filter(pk=session.pk).update(revoked_at=None, last_activity_at=self.now, expires_at=self.now)
        self.client.credentials(HTTP_AUTHORIZATION="Token " + data["token"])
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)

    def test_logout_revokes_server_session_and_other_sessions_can_be_revoked(self):
        data = self.enroll()
        session = AdminSession.objects.get(user=self.admin)
        other = AdminSession.objects.create(user=self.admin, key_hash=digest("other"), credential_fingerprint=fingerprint(self.admin, True), expires_at=self.now + timedelta(hours=1))
        self.assertEqual(self.client.post("/api/auth/revoke-other-sessions/").data["revoked"], 1)
        other.refresh_from_db(); self.assertIsNotNone(other.revoked_at)
        session.refresh_from_db(); self.assertIsNone(session.revoked_at)
        self.assertEqual(self.client.post("/api/auth/logout/").status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION="Token " + data["token"])
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.assertTrue(AdminLoginEvent.objects.filter(user=self.admin, event="LOGOUT").exists())

    def test_password_role_and_active_changes_invalidate_sessions(self):
        for field, value in [("password", "A-new-strong-phrase!66"), ("role", "MANAGER"), ("is_active", False)]:
            with self.subTest(field=field):
                self.admin.is_active = True; self.admin.set_password(PASSWORD); self.admin.save()
                UserProfile.objects.filter(user=self.admin).update(role="ADMIN")
                self.admin.refresh_from_db()
                AdminMFAProfile.objects.filter(user=self.admin).delete()
                data = self.enroll()
                if field == "role": UserProfile.objects.filter(user=self.admin).update(role=value)
                elif field == "password": self.admin.set_password(value); self.admin.save()
                else: User.objects.filter(pk=self.admin.pk).update(is_active=value)
                self.client.credentials(HTTP_AUTHORIZATION="Token " + data["token"])
                self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)

    def test_login_history_is_personal_except_for_super_admin(self):
        self.enroll()
        other = User.objects.create_user(username="second-admin", password=PASSWORD)
        UserProfile.objects.update_or_create(user=other, defaults={"role": "ADMIN"})
        AdminLoginEvent.objects.create(user=other, username=other.username, event="LOGIN")
        records = self.client.get("/api/auth/login-history/").data["results"]
        self.assertTrue(records); self.assertTrue(all(item["username"] == self.admin.username for item in records))
        self.admin.is_superuser = True; self.admin.save()
        # A role change invalidates the existing session, requiring MFA again.
        self.client.credentials(); response = self.login()
        profile = AdminMFAProfile.objects.get(user=self.admin)
        code = totp(decrypt_secret(profile.encrypted_secret), int(self.now.timestamp()) // 30 + 1)
        result = self.client.post("/api/auth/admin-verify/", {"challenge": response.data["challenge"], "code": code}, format="json")
        self.assertEqual(result.status_code, 200, result.data)
        self.client.credentials(HTTP_AUTHORIZATION="Token " + result.data["token"])
        self.assertIn(other.username, [item["username"] for item in self.client.get("/api/auth/login-history/").data["results"]])

    def test_guard_login_unchanged_and_cannot_access_admin_security(self):
        guard = User.objects.create_user(username="worker", password="Guard123!")
        UserProfile.objects.update_or_create(user=guard, defaults={"role": "EMPLOYEE"})
        result = self.client.post("/api/auth/guard-login/", {"username": "worker", "password": "Guard123!"}, format="json")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertNotIn("challenge", result.data)
        self.client.credentials(HTTP_AUTHORIZATION="Token " + result.data["token"])
        self.assertEqual(self.client.get("/api/auth/guard-me/").status_code, 200)
        self.assertEqual(self.client.get("/api/auth/login-history/").status_code, 403)
        self.assertEqual(self.client.post("/api/auth/logout/").status_code, 200)
        self.assertFalse(Token.objects.filter(user=guard).exists())

    def test_email_password_reset_requires_strong_password_and_revokes_session(self):
        self.enroll()
        reset = PasswordResetOTP.objects.create(user=self.admin, code_hash="unused", expires_at=self.now + timedelta(minutes=10), verified_at=self.now, reset_token_hash=digest("reset-test-token"))
        body = {"reset_token": "reset-test-token", "password": "Short123!", "password_confirmation": "Short123!"}
        self.assertEqual(self.client.post("/api/auth/password-reset-confirm/", body, format="json").status_code, 400)
        body.update(password="A-new-strong-phrase!66", password_confirmation="A-new-strong-phrase!66")
        self.assertEqual(self.client.post("/api/auth/password-reset-confirm/", body, format="json").status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.assertTrue(AdminMFAProfile.objects.get(user=self.admin).enabled_at)

    def test_django_admin_requires_factor_and_revokes_on_logout(self):
        self.enroll(); self.client.credentials()
        data = {"username": self.admin.username, "password": PASSWORD, "next": "/admin/"}
        response = self.client.post("/admin/login/", data)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("_auth_user_id", self.client.session)
        profile = AdminMFAProfile.objects.get(user=self.admin)
        data["verification_code"] = totp(decrypt_secret(profile.encrypted_secret), int(self.now.timestamp()) // 30 + 1)
        response = self.client.post("/admin/login/", data)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.get("/admin/").status_code, 200)
        key = self.client.session["admin_mfa_session_id"]
        self.client.post("/admin/logout/")
        self.assertIsNotNone(AdminSession.objects.get(pk=key).revoked_at)
