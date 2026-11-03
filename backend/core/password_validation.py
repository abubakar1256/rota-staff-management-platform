class AdminPasswordValidator:
    def validate(self, password, user=None):
        from .admin_auth import is_admin_account, validate_admin_password
        if user and is_admin_account(user):
            validate_admin_password(password, user)

    def get_help_text(self):
        return "Admin passwords need at least 12 characters and must not be common, entirely numeric or similar to account details."
