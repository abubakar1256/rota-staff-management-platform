from django.contrib.admin.apps import AdminConfig


class MFAAdminConfig(AdminConfig):
    default_site = "core.native_admin.SecureAdminSite"
