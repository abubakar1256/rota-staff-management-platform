"""The Django maintenance portal must enforce the same MFA as the operations UI."""
from django import forms
from django.contrib.admin import AdminSite
from django.contrib.admin.forms import AdminAuthenticationForm
from django.contrib.auth.signals import user_logged_in
from django.core.exceptions import ValidationError
from django.db import transaction
from django.dispatch import receiver
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed

from .admin_auth import is_admin_account, issue_session, record_event, validate_admin_password, validate_session, verify_factor
from .models import AdminMFAProfile, AdminSession


class MFAAdminForm(AdminAuthenticationForm):
    verification_code = forms.CharField(label="Authenticator or recovery code", max_length=40,
                                         widget=forms.TextInput(attrs={"autocomplete": "one-time-code"}))

    def clean(self):
        data = super().clean()
        user = self.get_user()
        if not is_admin_account(user):
            raise ValidationError("An Admin or Super Admin account is required.")
        validate_admin_password(data["password"], user)
        with transaction.atomic():
            profile = AdminMFAProfile.objects.select_for_update().filter(user=user).first()
            if not profile or not profile.enabled_at:
                raise ValidationError("Set up two-step verification through the operations portal first.")
            code = data.get("verification_code", "").strip()
            valid, message = verify_factor(profile, code, recovery=len(code) != 6)
        # Raise outside the transaction so failed attempts are persisted.
        if not valid:
            record_event(self.request, "MFA_FAILED", user)
            raise ValidationError(message)
        self.request._admin_mfa_verified_user = user.pk
        return data


@receiver(user_logged_in, dispatch_uid="rota-native-admin-mfa")
def native_login(sender, request, user, **kwargs):
    if getattr(request, "_admin_mfa_verified_user", None) == user.pk:
        _, session = issue_session(user, request)
        request.session["admin_mfa_session_id"] = str(session.pk)
        request.session.set_expiry(0)


class SecureAdminSite(AdminSite):
    login_form = MFAAdminForm
    login_template = "admin/mfa_login.html"

    def has_permission(self, request):
        if not super().has_permission(request) or not is_admin_account(request.user):
            return False
        key = request.session.get("admin_mfa_session_id")
        session = AdminSession.objects.select_related("user__profile").filter(pk=key, user=request.user).first() if key else None
        if not session:
            return False
        try:
            validate_session(session, request, touch=True)
            return True
        except AuthenticationFailed:
            return False

    def logout(self, request, extra_context=None):
        key = request.session.get("admin_mfa_session_id")
        if request.method == "POST" and key and request.user.is_authenticated:
            AdminSession.objects.filter(pk=key, user=request.user).update(revoked_at=timezone.now())
            record_event(request, "LOGOUT", request.user)
        return super().logout(request, extra_context)
