from rest_framework.permissions import BasePermission


def role_of(user):
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return "SUPER_ADMIN"
    return getattr(getattr(user, "profile", None), "role", None)


def is_super_admin(user):
    return role_of(user) == "SUPER_ADMIN"


def is_admin(user):
    return role_of(user) in {"SUPER_ADMIN", "ADMIN"}


def is_manager(user):
    return role_of(user) == "MANAGER"


def is_operator(user):
    return role_of(user) in {"OPERATOR", "RECEPTIONIST"}


def is_guard(user):
    return role_of(user) == "EMPLOYEE"


def is_client_admin(user):
    return role_of(user) == "CLIENT_ADMIN"


def read_only_action(view):
    return getattr(view, "action", None) in {"list", "retrieve", "summary", "coverage", "export"}


class IsAdminOrManager(BasePermission):
    message = "Only Super Admin, Admin or Manager users can modify operational records."

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        if is_admin(request.user) or is_manager(request.user):
            return True
        return is_operator(request.user) and request.method in ("GET", "HEAD", "OPTIONS") and read_only_action(view)


class IsAdminManagerOrEmployeeRota(BasePermission):
    message = "Guards can only access their own published rota."

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        if is_admin(request.user) or is_manager(request.user):
            return True
        if is_operator(request.user):
            return request.method in ("GET", "HEAD", "OPTIONS") and read_only_action(view)
        return is_guard(request.user) and getattr(view, "action", None) in {"my_schedule", "confirm"}


class IsAdminOnly(BasePermission):
    message = "Only Super Admin users can manage users and security settings."

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        return is_super_admin(request.user)


class IsAdminOrSuperAdmin(BasePermission):
    message = "Only Admin or Super Admin users can manage clients."

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and role_of(request.user) in {"SUPER_ADMIN", "ADMIN"})


class IsClientAdmin(BasePermission):
    message = "Only Client Admin users can access the client portal."

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and is_client_admin(request.user))


class IsInternalUser(BasePermission):
    message = "Client Admin users must use the client portal."

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and not is_client_admin(request.user))


class IsAdminManagerOrEmployee(BasePermission):
    message = "Employees can only access their own profile."

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        role = role_of(request.user)
        if role in {"SUPER_ADMIN", "ADMIN", "MANAGER"}:
            return True
        return is_guard(request.user) and getattr(view, "action", None) in {"me", "change_password"}


class IsAdminManagerOrEmployeeDocument(BasePermission):
    message = "Employees can only manage their own documents."

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        role = role_of(request.user)
        if role in {"SUPER_ADMIN", "ADMIN", "MANAGER"}:
            return True
        if is_operator(request.user):
            return request.method in ("GET", "HEAD", "OPTIONS") and read_only_action(view)
        return is_guard(request.user) and getattr(view, "action", None) in {"list", "retrieve", "create", "update", "partial_update"}


class IsAdminManagerOrEmployeeOperation(BasePermission):
    message = "Employees can only access their own assigned shifts."

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        role = role_of(request.user)
        if role in {"SUPER_ADMIN", "ADMIN", "MANAGER"}:
            return True
        if is_operator(request.user):
            return getattr(view, "action", None) in {"list", "retrieve", "mark_reached"}
        return is_guard(request.user) and getattr(view, "action", None) in {"list", "retrieve", "attendance"}
