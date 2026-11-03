import base64
import secrets
from datetime import timedelta

from django.contrib.auth import get_user_model, logout as django_logout
from django.core.exceptions import ValidationError as PasswordValidationError
from django.core.paginator import Paginator
from django.db import transaction
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .admin_auth import digest, encrypt_secret, fingerprint, idle_deadline, is_admin_account, issue_session, provisioning, record_event, recovery_codes, recovery_digest, revoke_sessions, session_data, validate_admin_password, validate_session, verify_factor
from .models import AdminLoginChallenge, AdminLoginEvent, AdminMFAProfile, AdminSession
from .permissions import role_of


def begin_admin_login(user, password, request):
    profile, _ = AdminMFAProfile.objects.get_or_create(user=user)
    raw = secrets.token_urlsafe(32)
    try:
        validate_admin_password(password, user)
        weak = False
    except PasswordValidationError:
        weak = True
    setup = not profile.enabled_at
    secret = base64.b32encode(secrets.token_bytes(20)).decode() if setup else ""
    challenge = AdminLoginChallenge.objects.create(user=user, key_hash=digest(raw), credential_fingerprint=fingerprint(user),
                                                   encrypted_secret=encrypt_secret(secret) if setup else "", password_change_required=weak,
                                                   expires_at=timezone.now() + timedelta(minutes=5))
    record_event(request, "MFA_CHALLENGE", user)
    result = {"challenge": raw, "setup_required": setup, "password_change_required": weak, "expires_at": challenge.expires_at.isoformat()}
    if setup:
        result.update(provisioning(secret, user.get_username()))
    return Response(result)


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@transaction.atomic
def verify_admin_login(request):
    raw = request.data.get("challenge", "")
    if not isinstance(raw, str) or len(raw) > 200:
        return Response({"detail": "Sign in again to start verification."}, status=400)
    challenge = AdminLoginChallenge.objects.select_for_update(of=("self",)).select_related("user__profile").filter(key_hash=digest(raw)).first()
    now = timezone.now()
    if not challenge or challenge.used_at or now >= challenge.expires_at or challenge.attempts >= 5:
        return Response({"detail": "This verification has expired or ended. Sign in again."}, status=400)
    # Serialize with password/account updates and read fresh credentials after
    # acquiring the lock; a previously started challenge must not undo a reset.
    user = get_user_model().objects.select_for_update().get(pk=challenge.user_id)
    if not is_admin_account(user) or not user.is_active or not secrets.compare_digest(challenge.credential_fingerprint, fingerprint(user)):
        return Response({"detail": "Your account changed. Sign in again."}, status=400)
    profile = AdminMFAProfile.objects.select_for_update().get(user=user)
    setup = bool(challenge.encrypted_secret)
    if setup == bool(profile.enabled_at):
        return Response({"detail": "Your two-step verification setup changed. Sign in again."}, status=400)
    password = request.data.get("new_password", "")
    if challenge.password_change_required:
        if not isinstance(password, str) or not password or password != request.data.get("confirm_password"):
            return Response({"detail": "Enter and confirm your new strong password."}, status=400)
        try:
            validate_admin_password(password, user)
        except PasswordValidationError as exc:
            return Response({"detail": " ".join(exc.messages)}, status=400)
    use_recovery = request.data.get("use_recovery") is True
    if setup and use_recovery:
        return Response({"detail": "Confirm setup with the code from your authenticator app."}, status=400)
    valid, message = verify_factor(profile, request.data.get("code", ""), encrypted_secret=challenge.encrypted_secret or None, recovery=use_recovery)
    if not valid:
        challenge.attempts += 1
        challenge.save(update_fields=["attempts"])
        record_event(request, "MFA_FAILED", user)
        return Response({"detail": message}, status=400)
    codes = []
    if setup:
        codes = recovery_codes()
        profile.encrypted_secret = challenge.encrypted_secret
        profile.enabled_at = now
        profile.recovery_hashes = [recovery_digest(code) for code in codes]
        profile.save()
        record_event(request, "MFA_ENROLLED", user)
    elif use_recovery:
        record_event(request, "RECOVERY_USED", user)
    if challenge.password_change_required:
        user.set_password(password)
        user.save(update_fields=["password"])
        revoke_sessions(user)
        record_event(request, "PASSWORD_CHANGED", user)
    challenge.used_at = now
    challenge.save(update_fields=["used_at"])
    Token.objects.filter(user=user).delete()
    raw_session, session = issue_session(user, request)
    from .serializers import UserSerializer
    return Response({"token": raw_session, "user": UserSerializer(user).data, "admin_session": session_data(session), "recovery_codes": codes})


def current_session(request):
    if not is_admin_account(request.user):
        raise PermissionDenied("This action is only available to Admin and Super Admin.")
    session = request.auth if isinstance(request.auth, AdminSession) else None
    if not session:
        session = AdminSession.objects.filter(pk=request.session.get("admin_mfa_session_id"), user=request.user).first() if request.session.get("admin_mfa_session_id") else None
    if not session:
        raise PermissionDenied("Sign in again using two-step verification.")
    return validate_session(session, request)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def activity(request):
    session = current_session(request)
    validate_session(session, request, touch=True)
    return Response(session_data(session))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout(request):
    if isinstance(request.auth, AdminSession):
        AdminSession.objects.filter(pk=request.auth.pk).update(revoked_at=timezone.now())
        record_event(request, "LOGOUT", request.user)
    else:
        Token.objects.filter(user=request.user).delete()
        if is_admin_account(request.user):
            session = current_session(request)
            AdminSession.objects.filter(pk=session.pk).update(revoked_at=timezone.now())
            record_event(request, "LOGOUT", request.user)
    django_logout(request)
    return Response({"message": "Signed out successfully."})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def security(request):
    current = current_session(request)
    profile = AdminMFAProfile.objects.get(user=request.user)
    sessions = AdminSession.objects.filter(user=request.user, revoked_at__isnull=True, expires_at__gt=timezone.now()).order_by("-created_at")
    rows = [{"id": str(item.pk), "current": item.pk == current.pk, "ip_address": item.ip_address, "user_agent": item.user_agent,
             "created_at": item.created_at.isoformat(), "last_seen_at": item.last_seen_at.isoformat(), **session_data(item)} for item in sessions if idle_deadline(item) > timezone.now()]
    return Response({"mfa_enabled": bool(profile.enabled_at), "recovery_codes_remaining": len(profile.recovery_hashes), "sessions": rows, "current_session": session_data(current)})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def login_history(request):
    current_session(request)
    records = AdminLoginEvent.objects.all() if role_of(request.user) == "SUPER_ADMIN" else AdminLoginEvent.objects.filter(user=request.user)
    page = Paginator(records, 25).get_page(request.query_params.get("page", 1))
    return Response({"results": [{"id": item.pk, "username": item.username, "event": item.event, "ip_address": item.ip_address,
                                  "user_agent": item.user_agent, "created_at": item.created_at.isoformat()} for item in page.object_list],
                     "pagination": {"page": page.number, "total_pages": page.paginator.num_pages, "has_next": page.has_next(), "has_previous": page.has_previous()}})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def revoke_others(request):
    current = current_session(request)
    count = AdminSession.objects.filter(user=request.user, revoked_at__isnull=True).exclude(pk=current.pk).update(revoked_at=timezone.now())
    record_event(request, "OTHER_SESSIONS_REVOKED", request.user)
    return Response({"revoked": count})
