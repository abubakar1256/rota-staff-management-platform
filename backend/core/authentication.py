from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .admin_auth import digest, is_admin_account, validate_session
from .models import AdminSession, UserProfile
from .permissions import role_of


def restrict_control_access(user, request):
    match = request.resolver_match
    if role_of(user) == UserProfile.Role.CONTROL_TEAM and (not match or match.namespace != "control"):
        raise AuthenticationFailed("Sign in to the Control Team portal to use this account.")


class AuthNoCacheMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith(("/api/auth/", "/api/control/")):
            response["Cache-Control"] = "no-store"
            response["Pragma"] = "no-cache"
        return response


class SecureTokenAuthentication(TokenAuthentication):
    def authenticate(self, request):
        self.request = request
        return super().authenticate(request)

    def authenticate_credentials(self, key):
        if len(key) == 64:
            session = AdminSession.objects.select_related("user__profile").filter(key_hash=digest(key)).first()
            if not session:
                raise AuthenticationFailed("Invalid or expired session. Please sign in again.")
            validate_session(session, self.request)
            return session.user, session
        user, token = super().authenticate_credentials(key)
        if is_admin_account(user):
            raise AuthenticationFailed("Admin sign in requires two-step verification. Please sign in again.")
        restrict_control_access(user, self.request)
        return user, token


class SecureSessionAuthentication(SessionAuthentication):
    def authenticate(self, request):
        result = super().authenticate(request)
        if result and is_admin_account(result[0]):
            key = request.session.get("admin_mfa_session_id")
            session = AdminSession.objects.filter(pk=key, user=result[0]).first() if key else None
            if not session:
                raise AuthenticationFailed("Admin sign in requires two-step verification.")
            validate_session(session, request)
        if result:
            restrict_control_access(result[0], request)
        return result
