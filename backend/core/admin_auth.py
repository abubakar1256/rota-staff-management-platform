"""Administrative MFA and expiring, revocable sessions. Secrets never enter logs."""
import base64
import hashlib
import hmac
import ipaddress
import secrets
import struct
from datetime import timedelta
from urllib.parse import quote, urlencode

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.contrib.auth.password_validation import CommonPasswordValidator, MinimumLengthValidator, NumericPasswordValidator, UserAttributeSimilarityValidator, validate_password
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed

from .models import AdminLoginEvent, AdminMFAProfile, AdminSession
from .permissions import role_of


def is_admin_account(user):
    return role_of(user) in {"ADMIN", "SUPER_ADMIN"}


def validate_admin_password(password, user):
    validate_password(password, user, password_validators=[MinimumLengthValidator(12), CommonPasswordValidator(), NumericPasswordValidator(), UserAttributeSimilarityValidator()])


def fingerprint(user, include_mfa=False):
    parts = [user.password, str(role_of(user)), str(user.is_active)]
    if include_mfa:
        profile = AdminMFAProfile.objects.filter(user=user).first()
        parts.append(profile.encrypted_secret if profile and profile.enabled_at else "disabled")
    return hmac.new(settings.SECRET_KEY.encode(), "|".join(parts).encode(), hashlib.sha256).hexdigest()


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def cipher():
    key = hashlib.sha256(("rota-admin-mfa-v1:" + settings.SECRET_KEY).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(value):
    return cipher().encrypt(value.encode()).decode()


def decrypt_secret(value):
    return cipher().decrypt(value.encode()).decode()


def totp(secret, counter, digits=6):
    """RFC 6238 / RFC 4226 SHA-1; verified against RFC test vectors."""
    raw = base64.b32decode(secret, casefold=True)
    mac = hmac.new(raw, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 15
    value = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7fffffff
    return str(value % (10 ** digits)).zfill(digits)


def recovery_codes():
    codes = []
    for _ in range(8):
        raw = secrets.token_hex(12).upper()
        codes.append("-".join(raw[index:index + 4] for index in range(0, len(raw), 4)))
    return codes


def recovery_digest(value):
    return digest(str(value).replace("-", "").replace(" ", "").upper())


def verify_factor(profile, code, *, encrypted_secret=None, recovery=False):
    """Call while holding the profile's database row lock; consumes successful factors."""
    now = timezone.now()
    if profile.locked_until and profile.locked_until > now:
        return False, "Too many incorrect codes. Try again after 15 minutes."
    if profile.locked_until:
        profile.failed_attempts = 0
        profile.locked_until = None
    valid = False
    if recovery and profile.enabled_at:
        candidate = recovery_digest(code)
        for index, stored in enumerate(profile.recovery_hashes):
            if hmac.compare_digest(candidate, stored):
                profile.recovery_hashes = profile.recovery_hashes[:index] + profile.recovery_hashes[index + 1:]
                valid = True
                break
    elif isinstance(code, str) and len(code) == 6 and code.isascii() and code.isdigit():
        try:
            secret = decrypt_secret(encrypted_secret or profile.encrypted_secret)
            current = int(now.timestamp()) // 30
            for counter in (current - 1, current, current + 1):
                if counter > profile.last_counter and hmac.compare_digest(totp(secret, counter), code):
                    profile.last_counter = counter
                    valid = True
                    break
        except (InvalidToken, ValueError):
            pass
    if valid:
        profile.failed_attempts = 0
        profile.locked_until = None
    else:
        profile.failed_attempts += 1
        if profile.failed_attempts >= 5:
            profile.locked_until = now + timedelta(minutes=15)
    profile.save()
    return valid, "" if valid else "The code is incorrect, expired or already used. Enter a fresh code."


def request_details(request):
    address = request.META.get("REMOTE_ADDR", "")
    if getattr(settings, "ADMIN_TRUST_PROXY_HEADERS", False):
        address = request.META.get("HTTP_X_FORWARDED_FOR", address).split(",")[0].strip()
    try:
        address = str(ipaddress.ip_address(address))
    except ValueError:
        address = None
    return {"ip_address": address, "user_agent": request.META.get("HTTP_USER_AGENT", "")[:350]}


def record_event(request, event, user=None, username=""):
    return AdminLoginEvent.objects.create(user=user, username=(user.get_username() if user else username)[:150], event=event, **request_details(request))


def idle_deadline(session):
    return min(session.expires_at, session.last_activity_at + timedelta(seconds=settings.ADMIN_SESSION_IDLE_SECONDS))


def session_data(session):
    return {"id": str(session.pk), "idle_expires_at": idle_deadline(session).isoformat(), "expires_at": session.expires_at.isoformat()}


def issue_session(user, request):
    raw = secrets.token_hex(32)
    session = AdminSession.objects.create(user=user, key_hash=digest(raw), credential_fingerprint=fingerprint(user, True),
                                         expires_at=timezone.now() + timedelta(seconds=settings.ADMIN_SESSION_MAX_SECONDS), **request_details(request))
    record_event(request, "LOGIN", user)
    return raw, session


def revoke_sessions(user):
    return AdminSession.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())


def validate_session(session, request, touch=False):
    now = timezone.now()
    expired = now >= idle_deadline(session)
    invalid = not session.user.is_active or not is_admin_account(session.user) or not hmac.compare_digest(session.credential_fingerprint, fingerprint(session.user, True))
    if session.revoked_at or expired or invalid:
        if AdminSession.objects.filter(pk=session.pk, revoked_at__isnull=True).update(revoked_at=now):
            record_event(request, "SESSION_EXPIRED" if expired else "SESSION_REVOKED", session.user)
        raise AuthenticationFailed("Your admin session has expired or ended. Please sign in again.", code="admin_session_expired")
    if touch:
        session.last_activity_at = now
        session.last_seen_at = now
        session.save(update_fields=["last_activity_at", "last_seen_at"])
    elif (now - session.last_seen_at).total_seconds() >= 60:
        AdminSession.objects.filter(pk=session.pk).update(last_seen_at=now)
    return session


def provisioning(secret, username):
    uri = "otpauth://totp/" + quote(f"RotaOps:{username}", safe="") + "?" + urlencode({"secret": secret, "issuer": "RotaOps", "algorithm": "SHA1", "digits": 6, "period": 30})
    from reportlab.graphics import renderSVG
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    widget = QrCodeWidget(uri)
    bounds = widget.getBounds()
    width = bounds[2] - bounds[0]
    drawing = Drawing(200, 200, transform=[200 / width, 0, 0, 200 / width, 0, 0])
    drawing.add(widget)
    svg = renderSVG.drawToString(drawing)
    return {"secret": secret, "qr_image": "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()}
