from copy import copy
from datetime import timedelta
from math import isfinite
import os
from secrets import token_urlsafe

from django.contrib.auth import authenticate, get_user_model
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from .cortex_itime import save_cortex_access
from .permissions import is_admin, is_guard
from .pin_encryption import pin_cipher
from .document_requirements import RESERVED_DOCUMENT_NAMES, document_checklist_options, documents_completion, is_british
from .rota_checks import RotaAssignmentChecks
from .whatsapp import normalise_whatsapp_number

from .models import AuditLog, BookOffNote, Client, ClientArrivalReport, DailyArrivalReport, DailyOperation, DocumentOption, Employee, EmployeeDocument, GuardComplianceRegistration, HourlyCheckinNote, LeaveRecord, Notification, RotaAssignment, RotaConfirmation, RotaWeek, ShiftAttendanceEvent, ShiftType, Site, SiteInduction, SiteShiftRequirement, TimeGateCredential, Timesheet, UserProfile


User = get_user_model()

EMPLOYEE_ROLES = ["Security Guard", "CCTV Operator", "Dog Handler", "Site Supervisor", "Other"]


def normalise_employee_roles(roles):
    if not isinstance(roles, list):
        raise serializers.ValidationError("Roles must be sent as a list.")
    cleaned = []
    for role in roles:
        value = str(role).strip()
        if value == "CCTV":
            value = "CCTV Operator"
        if value and value not in cleaned:
            cleaned.append(value)
    too_long = [role for role in cleaned if len(role) > 80]
    if too_long:
        raise serializers.ValidationError("Each employee role must be 80 characters or fewer.")
    if not cleaned:
        raise serializers.ValidationError("Select at least one employee role.")
    return cleaned


def _document_for_type(documents, *document_types):
    wanted = {value.casefold() for value in document_types}
    return next((document for document in documents if document.document_type.casefold() in wanted), None)


def employee_compliance_issues(employee, documents=None):
    """Return the critical compliance blockers for assigning a guard to a rota."""
    if documents is None:
        documents = list(employee.documents.all())
    issues = []
    critical_documents = [
        ("Passport", ("Passport (First 2 pages)",)),
    ]
    if not is_british(employee.nationality):
        critical_documents.append(("Share Code", ("Share Code",)))
    for label, aliases in critical_documents:
        document = _document_for_type(documents, *aliases)
        if not document:
            issues.append(f"{label} is missing")
            continue
        if document.verification_status != EmployeeDocument.VerificationStatus.VERIFIED:
            issues.append(f"{label} is awaiting verification")
        if document.expiry_date and document.expiry_date < timezone.localdate():
            issues.append(f"{label} has expired")

    combined_sia = _document_for_type(documents, "SIA Card (Front & Back)")
    sia_front = _document_for_type(documents, "SIA Card (Front)")
    sia_back = _document_for_type(documents, "SIA Card (Back)")
    sia_documents = [document for document in (combined_sia or sia_front, None if combined_sia else sia_back) if document]
    if not combined_sia and not (sia_front and sia_back):
        issues.append("SIA Card front and back are required")
    for document in sia_documents:
        if document.verification_status != EmployeeDocument.VerificationStatus.VERIFIED:
            issues.append("SIA Card is awaiting verification")
        if document.expiry_date and document.expiry_date < timezone.localdate():
            issues.append("SIA Card has expired")
    return list(dict.fromkeys(issues))


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        login_name = attrs["username"].strip()
        account = User.objects.filter(username__iexact=login_name).first()
        user = authenticate(username=account.username if account else login_name, password=attrs["password"])
        if not user:
            employee = Employee.objects.select_related("user").filter(email__iexact=login_name, user__isnull=False).first()
            linked_user = employee.user if employee else None
            if not linked_user:
                linked_user = User.objects.filter(
                    email__iexact=login_name,
                    profile__role=UserProfile.Role.EMPLOYEE,
                ).first()
            if linked_user and (not account or linked_user.pk != account.pk):
                user = authenticate(username=linked_user.username, password=attrs["password"])
        if not user:
            raise serializers.ValidationError("Invalid username or password.")
        if not user.is_active:
            raise serializers.ValidationError("This account is inactive.")
        attrs["user"] = user
        return attrs


class UserSerializer(serializers.ModelSerializer):
    role = serializers.CharField(write_only=True, required=False)
    role_display = serializers.SerializerMethodField(read_only=True)
    role_label = serializers.SerializerMethodField(read_only=True)
    managed_site_ids = serializers.ListField(child=serializers.IntegerField(min_value=1), required=False)
    client_id = serializers.IntegerField(required=False, allow_null=True)
    password = serializers.CharField(write_only=True, required=False, min_length=8)

    class Meta:
        model = User
        fields = ["id", "username", "first_name", "last_name", "email", "is_active", "role", "role_display", "role_label", "managed_site_ids", "client_id", "password"]
        read_only_fields = ["id", "role_display"]

    def get_role_display(self, obj):
        profile = getattr(obj, "profile", None)
        if obj.is_superuser:
            return UserProfile.Role.SUPER_ADMIN
        return profile.role if profile else None

    def get_role_label(self, obj):
        profile = getattr(obj, "profile", None)
        if obj.is_superuser:
            return UserProfile.Role.SUPER_ADMIN.label
        return profile.get_role_display() if profile else None

    def validate_role(self, value):
        if value == UserProfile.Role.CONTROL_TEAM:
            raise serializers.ValidationError("Add these accounts from the Control Team page.")
        valid_roles = {choice.value for choice in UserProfile.Role}
        if value not in valid_roles:
            raise serializers.ValidationError("Choose a valid role: Super Admin, Admin, Manager, Operator or Guard.")
        request = self.context.get("request")
        if value == UserProfile.Role.SUPER_ADMIN and (not request or not request.user.is_superuser and getattr(getattr(request.user, "profile", None), "role", None) != UserProfile.Role.SUPER_ADMIN):
            raise serializers.ValidationError("Only a Super Admin can create or assign the Super Admin role.")
        return value

    def validate(self, attrs):
        role = attrs.get("role")
        if role is None and self.instance:
            role = getattr(getattr(self.instance, "profile", None), "role", None)
        client_id = attrs.get("client_id", getattr(getattr(self.instance, "profile", None), "client_id", None))
        if role == UserProfile.Role.CLIENT_ADMIN and not client_id:
            raise serializers.ValidationError({"client_id": "Select a client for a Client Admin account."})
        if role != UserProfile.Role.CLIENT_ADMIN and "client_id" in attrs and client_id:
            raise serializers.ValidationError({"client_id": "Only Client Admin accounts can be linked to a client."})
        if client_id and not Client.objects.filter(pk=client_id, status=Client.Status.ACTIVE).exists():
            raise serializers.ValidationError({"client_id": "Select an active client."})
        email = attrs.get("email")
        if email and User.objects.filter(email__iexact=email, profile__role=UserProfile.Role.CONTROL_TEAM).exists():
            raise serializers.ValidationError({"email": "This email is already used by a Control Team account."})
        if attrs.get("password") and (role in {"ADMIN", "SUPER_ADMIN"} or (self.instance and self.instance.is_superuser)):
            from .admin_auth import validate_admin_password
            from django.core.exceptions import ValidationError
            candidate = self.instance or User(username=attrs.get("username", ""), email=attrs.get("email", ""), first_name=attrs.get("first_name", ""), last_name=attrs.get("last_name", ""))
            try:
                validate_admin_password(attrs["password"], candidate)
            except ValidationError as exc:
                raise serializers.ValidationError({"password": exc.messages})
        return attrs

    def to_representation(self, instance):
        data = super().to_representation(instance)
        profile = getattr(instance, "profile", None)
        data["managed_site_ids"] = list(profile.managed_sites.values_list("id", flat=True)) if profile else []
        data["client_id"] = profile.client_id if profile else None
        employee = getattr(instance, "employee_record", None)
        data["compliance_registration_enabled"] = bool(employee and employee.compliance_registration_enabled)
        return data

    def create(self, validated_data):
        role = validated_data.pop("role", UserProfile.Role.RECEPTIONIST)
        managed_site_ids = validated_data.pop("managed_site_ids", [])
        client_id = validated_data.pop("client_id", None)
        password = validated_data.pop("password", None)
        user = User(**validated_data)
        user.set_password(password or token_urlsafe(18))
        user.save()
        profile, _ = UserProfile.objects.update_or_create(user=user, defaults={"role": role, "client_id": client_id if role == UserProfile.Role.CLIENT_ADMIN else None})
        profile.managed_sites.set(Site.objects.filter(pk__in=managed_site_ids))
        return user

    def update(self, instance, validated_data):
        role = validated_data.pop("role", None)
        managed_site_ids = validated_data.pop("managed_site_ids", None)
        client_id = validated_data.pop("client_id", None)
        password = validated_data.pop("password", None)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if password:
            instance.set_password(password)
        instance.save()
        if role:
            UserProfile.objects.update_or_create(user=instance, defaults={"role": role, "client_id": client_id if role == UserProfile.Role.CLIENT_ADMIN else None})
        elif client_id is not None:
            UserProfile.objects.filter(user=instance).update(client_id=client_id)
        if managed_site_ids is not None:
            profile, _ = UserProfile.objects.get_or_create(user=instance)
            profile.managed_sites.set(Site.objects.filter(pk__in=managed_site_ids))
        if password or role or "is_active" in validated_data:
            from .admin_auth import revoke_sessions
            from rest_framework.authtoken.models import Token
            revoke_sessions(instance)
            Token.objects.filter(user=instance).delete()
        return instance


class EmployeeSerializer(serializers.ModelSerializer):
    profile_declaration_text = serializers.SerializerMethodField(read_only=True)
    profile_completion = serializers.SerializerMethodField(read_only=True)
    has_portal_account = serializers.SerializerMethodField(read_only=True)
    portal_status = serializers.SerializerMethodField(read_only=True)
    portal_invite_url = serializers.SerializerMethodField(read_only=True)
    portal_invite_token = serializers.SerializerMethodField(read_only=True)
    portal_invite_expires_at = serializers.SerializerMethodField(read_only=True)
    documents_completion = serializers.SerializerMethodField(read_only=True)
    profile_photo_url = serializers.SerializerMethodField(read_only=True)
    employee_id = serializers.CharField(required=False, allow_blank=True)
    whatsapp_number = serializers.CharField(required=False, allow_blank=True, max_length=40)
    cortex_itime_pin = serializers.RegexField(r"\A[0-9]{1,32}\Z", write_only=True, required=False,
        error_messages={"invalid": "Enter a PIN containing 1 to 32 digits."})
    cortex_itime_site = serializers.PrimaryKeyRelatedField(
        queryset=Site.objects.filter(is_active=True, cortex_itime_enabled=True), write_only=True, required=False,
        error_messages={"does_not_exist": "Select an active Cortex iTime site."},
    )
    cortex_itime_sites = serializers.SerializerMethodField()
    cortex_itime_pin_saved = serializers.SerializerMethodField()
    timegate_pin = serializers.RegexField(
        r"\A[0-9]{1,32}\Z", write_only=True, required=False,
        error_messages={"invalid": "Enter a TimeGate PIN containing 1 to 32 digits."},
    )
    timegate_pin_saved = serializers.SerializerMethodField()

    def to_representation(self, instance):
        result = super().to_representation(instance)
        request = self.context.get("request")
        if not request or not is_admin(request.user):
            result.pop("whatsapp_number", None)
        return result

    def validate_whatsapp_number(self, value):
        request = self.context.get("request")
        if not request or not is_admin(request.user):
            raise PermissionDenied("Only Admin or Super Admin can manage WhatsApp numbers.")
        if not value:
            return ""
        try:
            return normalise_whatsapp_number(value)
        except ValueError as error:
            raise serializers.ValidationError(str(error)) from error

    def get_timegate_pin_saved(self, employee):
        request = self.context.get("request")
        can_view = request and (is_admin(request.user) or (is_guard(request.user) and employee.user_id == request.user.pk))
        return bool(can_view and hasattr(employee, "timegate_credential"))

    def _save_timegate_pin(self, employee, pin):
        if pin:
            credential, _ = TimeGateCredential.objects.update_or_create(
                employee=employee,
                defaults={"encrypted_pin": pin_cipher("timegate").encrypt(pin.encode()).decode()},
            )
            employee.timegate_credential = credential

    def get_cortex_itime_pin_saved(self, employee):
        request = self.context.get("request")
        return bool(request and is_admin(request.user) and hasattr(employee, "cortex_itime_credential"))

    def get_cortex_itime_sites(self, employee):
        if not self.get_cortex_itime_pin_saved(employee):
            return []
        return [
            {"id": site.pk, "name": site.name, "active": site.is_active and site.cortex_itime_enabled}
            for site in employee.cortex_itime_credential.sites.all()
        ]

    def to_internal_value(self, data):
        data = data.copy()
        for field in ("date_of_birth", "joining_date"):
            if data.get(field) == "":
                data[field] = None
        if "roles" not in data and data.get("position"):
            data["roles"] = [part.strip() for part in str(data["position"]).replace("·", "+").replace(",", "+").split("+") if part.strip()]
        return super().to_internal_value(data)

    def validate_name(self, value):
        normalized = " ".join(value.split())
        duplicate = Employee.objects.filter(name__iexact=normalized)
        if self.instance:
            duplicate = duplicate.exclude(pk=self.instance.pk)
        if duplicate.exists():
            raise serializers.ValidationError("An employee with this name already exists. Use the existing employee record instead.")
        return normalized

    def validate_email(self, value):
        return value.strip().lower()

    def validate(self, attrs):
        if "roles" in attrs:
            attrs["roles"] = normalise_employee_roles(attrs["roles"])
            attrs["position"] = attrs["roles"][0]
        if not self.instance and not attrs.get("email"):
            raise serializers.ValidationError({"email": "Email is required because it will be used for guard portal login."})
        email = attrs.get("email")
        if email:
            duplicate = Employee.objects.filter(email__iexact=email)
            if self.instance:
                duplicate = duplicate.exclude(pk=self.instance.pk)
            if duplicate.exists():
                raise serializers.ValidationError({"email": "This email is already linked to another employee."})
            if User.objects.filter(email__iexact=email, profile__role=UserProfile.Role.CONTROL_TEAM).exists():
                raise serializers.ValidationError({"email": "This email is already used by a Control Team account."})
        if "timegate_pin" in attrs:
            request = self.context.get("request")
            if not request or not is_admin(request.user):
                raise PermissionDenied("Only Admin or Super Admin can manage TimeGate PINs.")
        cortex_fields = {"cortex_itime_enabled", "cortex_itime_pin", "cortex_itime_site"}
        if cortex_fields.intersection(attrs):
            request = self.context.get("request")
            if not request or not is_admin(request.user):
                raise PermissionDenied("Only Admin or Super Admin can manage Cortex iTime access.")
            enabled = attrs.get("cortex_itime_enabled", getattr(self.instance, "cortex_itime_enabled", False))
            pin, site = attrs.get("cortex_itime_pin"), attrs.get("cortex_itime_site")
            if (pin or site) and not enabled:
                raise serializers.ValidationError({"cortex_itime_enabled": "Enable Cortex iTime before editing its PIN or sites."})
            if enabled and not (self.instance and hasattr(self.instance, "cortex_itime_credential")) and not (pin and site):
                raise serializers.ValidationError({"cortex_itime_pin": "Enter the guard's PIN and select its first activation site."})
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        pin = validated_data.pop("cortex_itime_pin", None)
        site = validated_data.pop("cortex_itime_site", None)
        timegate_pin = validated_data.pop("timegate_pin", None)
        employee_id = (validated_data.get("employee_id") or "").strip()
        if not employee_id:
            existing_ids = set(Employee.objects.values_list("employee_id", flat=True))
            number = 1
            while f"EMP-{number:03d}" in existing_ids:
                number += 1
            validated_data["employee_id"] = f"EMP-{number:03d}"
        employee = super().create(validated_data)
        if site:
            save_cortex_access(employee, site, pin)
        self._save_timegate_pin(employee, timegate_pin)
        return employee

    @transaction.atomic
    def update(self, instance, validated_data):
        from .profile_completion import PROFILE_FIELDS
        pin = validated_data.pop("cortex_itime_pin", None)
        site = validated_data.pop("cortex_itime_site", None)
        timegate_pin = validated_data.pop("timegate_pin", None)
        if any(field in validated_data and validated_data[field] != getattr(instance, field) for field in PROFILE_FIELDS):
            validated_data["profile_declaration_accepted_at"] = None
            validated_data["profile_declaration_version"] = ""
        previous_email = (instance.email or "").strip().lower()
        email_changed = "email" in validated_data
        instance = super().update(instance, validated_data)
        if email_changed and instance.user_id:
            user = instance.user
            new_email = (instance.email or "").strip().lower()
            user_updates = []
            if user.email != new_email:
                user.email = new_email
                user_updates.append("email")
            # Keep email-based usernames aligned without overwriting a custom username.
            if previous_email and user.username.casefold() == previous_email.casefold() and len(new_email) <= 150 and user.username != new_email:
                user.username = new_email
                user_updates.append("username")
            if user_updates:
                user.save(update_fields=user_updates)
        if site or pin:
            save_cortex_access(instance, site, pin)
        self._save_timegate_pin(instance, timegate_pin)
        return instance

    class Meta:
        model = Employee
        fields = ["id", "employee_id", "user", "name", "date_of_birth", "nationality", "position", "roles", "phone", "whatsapp_number", "email", "address", "emergency_contact", "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship", "joining_date", "status", "compliance_registration_enabled", "cortex_itime_enabled", "cortex_itime_pin", "cortex_itime_site", "cortex_itime_sites", "cortex_itime_pin_saved", "timegate_pin", "timegate_pin_saved", "profile_completion", "documents_completion", "profile_photo_url", "profile_declaration_accepted_at", "profile_declaration_version", "profile_declaration_text", "has_portal_account", "portal_status", "portal_invite_url", "portal_invite_token", "portal_invite_expires_at", "created_at", "updated_at"]
        read_only_fields = ["profile_declaration_accepted_at", "profile_declaration_version", "profile_declaration_text", "id", "user", "profile_completion", "documents_completion", "has_portal_account", "created_at", "updated_at"]

    def get_profile_completion(self, obj):
        from .profile_completion import profile_completion
        return profile_completion(obj)

    def get_profile_declaration_text(self, obj):
        from .profile_completion import PROFILE_DECLARATION
        return PROFILE_DECLARATION

    def get_documents_completion(self, obj):
        if "document_checklist_options" not in self.context:
            self.context["document_checklist_options"] = document_checklist_options()
        return documents_completion(obj, self.context["document_checklist_options"])

    def get_profile_photo_url(self, obj):
        document = obj.documents.filter(document_type__iexact="Personal Photograph").first()
        if not document or not document.file:
            return None
        request = self.context.get("request")
        path = f"/api/media/document/{document.pk}/"
        return request.build_absolute_uri(path) if request else path

    def get_has_portal_account(self, obj):
        return bool(obj.user_id)

    def get_portal_status(self, obj):
        if not obj.user_id:
            return "NOT_CREATED"
        return "ACTIVE" if obj.user.has_usable_password() else "INVITE_PENDING"

    def _pending_invite(self, obj):
        prefetched = getattr(obj, "_pending_portal_invites", None)
        if prefetched is not None:
            return prefetched[0] if prefetched else None
        return obj.portal_invites.filter(used_at__isnull=True, expires_at__gt=timezone.now()).first()

    def get_portal_invite_url(self, obj):
        invite = self._pending_invite(obj)
        if not invite or not invite.token:
            return None
        frontend_url = os.getenv("FRONTEND_URL", "").rstrip("/")
        if not frontend_url:
            request = self.context.get("request")
            frontend_url = request.build_absolute_uri("/").rstrip("/") if request else "http://127.0.0.1:5173"
        return f"{frontend_url}/guard?activate={invite.token}"

    def get_portal_invite_token(self, obj):
        invite = self._pending_invite(obj)
        return invite.token if invite and invite.token else None

    def get_portal_invite_expires_at(self, obj):
        invite = self._pending_invite(obj)
        return invite.expires_at if invite else None


class GuardComplianceRegistrationSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    approved_by_name = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = GuardComplianceRegistration
        fields = [
            "id", "employee", "employee_name", "form_id",
            "national_insurance_number", "address_line_1", "city", "postcode",
            "previously_unemployed", "main_mode_of_transport", "employment_type",
            "additional_certifications", "next_of_kin_name", "next_of_kin_relationship",
            "next_of_kin_phone", "job_role", "qualifications", "ethnicity", "religion",
            "gender", "sexuality", "disability_health_condition", "declaration_accepted",
            "signature_name", "signed_at", "status", "submitted_at", "approval_deadline", "approved_at", "approved_by", "approved_by_name", "rejection_reason", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "employee", "employee_name", "form_id", "signed_at", "submitted_at", "approval_deadline", "approved_at", "approved_by", "approved_by_name", "rejection_reason", "created_at", "updated_at",
        ]

    def validate(self, attrs):
        status_value = attrs.get("status", getattr(self.instance, "status", GuardComplianceRegistration.Status.DRAFT))
        if status_value not in {GuardComplianceRegistration.Status.PENDING_APPROVAL, GuardComplianceRegistration.Status.APPROVED}:
            return attrs
        declaration = attrs.get("declaration_accepted", getattr(self.instance, "declaration_accepted", False))
        signature = attrs.get("signature_name", getattr(self.instance, "signature_name", ""))
        if not declaration:
            raise serializers.ValidationError({"declaration_accepted": "Please accept the declaration before saving the PDF."})
        if not signature or not signature.strip():
            raise serializers.ValidationError({"signature_name": "Type your full name as your signature."})
        return attrs

    def get_approved_by_name(self, obj):
        if not obj.approved_by:
            return None
        return obj.approved_by.get_full_name() or obj.approved_by.get_username()

class SiteSerializer(serializers.ModelSerializer):
    client_name = serializers.CharField(source="client.name", read_only=True, allow_null=True)
    latitude = serializers.FloatField(required=False, allow_null=True, min_value=-90, max_value=90)
    longitude = serializers.FloatField(required=False, allow_null=True, min_value=-180, max_value=180)
    geofence_radius_m = serializers.IntegerField(required=False, min_value=1)

    def validate_latitude(self, value):
        if value is not None and not isfinite(value):
            raise serializers.ValidationError("Enter a valid latitude between -90 and 90.")
        return value

    def validate_longitude(self, value):
        if value is not None and not isfinite(value):
            raise serializers.ValidationError("Enter a valid longitude between -180 and 180.")
        return value

    class Meta:
        model = Site
        fields = ["id", "client", "client_name", "site_id", "name", "address", "contact_name", "contact_phone", "required_guards", "latitude", "longitude", "geofence_radius_m", "attendance_mode", "location_tracking_enabled", "location_tracking_enabled_at", "cortex_itime_enabled", "timegate_enabled", "is_active", "created_at", "updated_at"]
        read_only_fields = ["created_at", "updated_at", "location_tracking_enabled_at"]

    def create(self, validated_data):
        if validated_data.get("location_tracking_enabled"):
            validated_data["location_tracking_enabled_at"] = timezone.now()
        return super().create(validated_data)

    def update(self, instance, validated_data):
        if validated_data.get("location_tracking_enabled") and not instance.location_tracking_enabled:
            validated_data["location_tracking_enabled_at"] = timezone.now()
        return super().update(instance, validated_data)


class ClientSerializer(serializers.ModelSerializer):
    sites_count = serializers.IntegerField(source="sites.count", read_only=True)

    class Meta:
        model = Client
        fields = ["id", "client_id", "name", "contact_name", "email", "phone", "address", "status", "sites_count", "created_at", "updated_at"]
        read_only_fields = ["id", "sites_count", "created_at", "updated_at"]


class ShiftTypeSerializer(serializers.ModelSerializer):
    crosses_midnight = serializers.ReadOnlyField()

    class Meta:
        model = ShiftType
        fields = ["id", "name", "start_time", "end_time", "crosses_midnight", "is_active"]


class RotaAssignmentSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    employee_code = serializers.CharField(source="employee.employee_id", read_only=True)
    site_name = serializers.CharField(source="site.name", read_only=True)
    site_address = serializers.CharField(source="site.address", read_only=True)
    site_latitude = serializers.FloatField(source="site.latitude", read_only=True, allow_null=True)
    site_longitude = serializers.FloatField(source="site.longitude", read_only=True, allow_null=True)
    shift_name = serializers.CharField(source="shift_type.name", read_only=True)

    class Meta:
        model = RotaAssignment
        fields = [
            "id", "rota_week", "work_date", "shift_type", "shift_name", "employee", "employee_name", "employee_code",
            "site", "site_name", "site_address", "site_latitude", "site_longitude", "scheduled_start", "scheduled_end",
            "notes", "replaced_assignment", "split_cover", "created_at", "updated_at",
        ]
        read_only_fields = ["split_cover", "created_at", "updated_at"]

    def validate(self, attrs):
        rota_week = attrs.get("rota_week", getattr(self.instance, "rota_week", None))
        work_date = attrs.get("work_date", getattr(self.instance, "work_date", None))
        shift_type = attrs.get("shift_type", getattr(self.instance, "shift_type", None))
        employee = attrs.get("employee", getattr(self.instance, "employee", None))
        site = attrs.get("site", getattr(self.instance, "site", None))
        scheduled_start = attrs.get("scheduled_start", getattr(self.instance, "scheduled_start", None)) or shift_type.start_time
        scheduled_end = attrs.get("scheduled_end", getattr(self.instance, "scheduled_end", None)) or shift_type.end_time

        if self.instance and self.instance.split_cover:
            if employee is None:
                raise serializers.ValidationError("Use Find Replacement to assign another guard to this split cover segment.")
            for field in ("rota_week", "work_date", "shift_type", "site", "scheduled_start", "scheduled_end"):
                if field in attrs and attrs[field] != getattr(self.instance, field):
                    raise serializers.ValidationError("A split cover segment must keep its original site and timing.")

        if rota_week and work_date:
            week_end = rota_week.week_start + __import__("datetime").timedelta(days=6)
            if not rota_week.week_start <= work_date <= week_end:
                raise serializers.ValidationError({"work_date": "Assignment date must fall inside the selected rota week."})
        if rota_week and rota_week.status == RotaWeek.Status.PUBLISHED:
            raise serializers.ValidationError("Published rotas cannot be changed. Create a new draft week or unpublish it first.")
        if employee and work_date and site and shift_type:
            candidate = RotaAssignment(
                rota_week=rota_week, employee=employee, site=site, shift_type=shift_type,
                work_date=work_date, scheduled_start=scheduled_start, scheduled_end=scheduled_end,
            )
            checks = RotaAssignmentChecks([employee.pk], [site.pk], work_date, work_date)
            if problem := checks.problem(candidate, employee_compliance_issues, exclude_id=getattr(self.instance, "pk", None)):
                message, code = problem
                raise serializers.ValidationError({"employee": message}, code=code)
        return attrs

    @staticmethod
    def _crosses_midnight(start_time, end_time):
        return end_time <= start_time

    @classmethod
    def _times_overlap(cls, first_start_time, first_end_time, second_start_time, second_end_time):
        def interval(start_time, end_time):
            start = start_time.hour * 60 + start_time.minute
            end = end_time.hour * 60 + end_time.minute
            if end <= start:
                end += 24 * 60
            return start, end

        first_start, first_end = interval(first_start_time, first_end_time)
        second_start, second_end = interval(second_start_time, second_end_time)
        return first_start < second_end and second_start < first_end


class RotaWeekSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()
    assignment_count = serializers.SerializerMethodField()
    whatsapp_previously_shared = serializers.SerializerMethodField()

    class Meta:
        model = RotaWeek
        fields = ["id", "week_start", "status", "created_by", "created_by_name", "published_at", "assignment_count", "whatsapp_previously_shared", "created_at", "updated_at"]
        read_only_fields = ["created_by", "created_by_name", "published_at", "assignment_count", "created_at", "updated_at"]

    def validate_status(self, value):
        if value == RotaWeek.Status.PUBLISHED and getattr(self.instance, "status", None) != value:
            raise serializers.ValidationError("Use Publish rota to run the checks and send assignments to guards.")
        return value

    def get_created_by_name(self, obj):
        return obj.created_by.get_full_name() or obj.created_by.get_username()

    def get_assignment_count(self, obj):
        return obj.assignments.count()

    def get_whatsapp_previously_shared(self, obj):
        request = self.context.get("request")
        return bool(request and is_admin(request.user) and obj.whatsapp_shares.exists())


class RotaConfirmationSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    employee_code = serializers.CharField(source="employee.employee_id", read_only=True)

    class Meta:
        model = RotaConfirmation
        fields = ["id", "rota_week", "employee", "employee_name", "employee_code", "status", "confirmed_at", "updated_at"]
        read_only_fields = ["status", "confirmed_at", "updated_at"]


class SiteShiftRequirementSerializer(serializers.ModelSerializer):
    site_name = serializers.CharField(source="site.name", read_only=True)
    shift_name = serializers.CharField(source="shift_type.name", read_only=True)

    class Meta:
        model = SiteShiftRequirement
        fields = ["id", "site", "site_name", "shift_type", "shift_name", "weekday", "required_guards", "updated_at"]
        read_only_fields = ["updated_at"]


class SiteInductionSerializer(serializers.ModelSerializer):
    site_name = serializers.CharField(source="site.name", read_only=True)
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    employee_code = serializers.CharField(source="employee.employee_id", read_only=True)
    cortex_activation_required = serializers.SerializerMethodField()

    class Meta:
        model = SiteInduction
        fields = ["id", "site", "site_name", "employee", "employee_name", "employee_code", "induction_date", "induction_time", "status", "notes", "created_by", "created_at", "updated_at", "cortex_activation_required"]
        read_only_fields = ["created_by", "created_at", "updated_at"]

    def validate_employee(self, value):
        if value.status != Employee.Status.ACTIVE:
            raise serializers.ValidationError("Only active guards can be inducted at a site.")
        if not value.user_id or not value.user.has_usable_password():
            raise serializers.ValidationError("Complete the guard portal access before adding an induction.")
        return value

    def get_cortex_activation_required(self, induction):
        if induction.status == SiteInduction.Status.CANCELLED or not induction.site.is_active or not induction.site.cortex_itime_enabled:
            return False
        employee = induction.employee
        credential = getattr(employee, "cortex_itime_credential", None)
        return not employee.cortex_itime_enabled or not credential or induction.site not in credential.sites.all()


class GuardSiteInductionSerializer(serializers.ModelSerializer):
    site_name = serializers.CharField(source="site.name", read_only=True)
    site_address = serializers.CharField(source="site.address", read_only=True)
    site_latitude = serializers.FloatField(source="site.latitude", read_only=True, allow_null=True)
    site_longitude = serializers.FloatField(source="site.longitude", read_only=True, allow_null=True)

    class Meta:
        model = SiteInduction
        fields = ["id", "site_name", "site_address", "site_latitude", "site_longitude",
                  "induction_date", "induction_time", "status"]
        read_only_fields = fields


class LeaveRecordSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    approved_by_name = serializers.SerializerMethodField()
    employee = serializers.PrimaryKeyRelatedField(queryset=Employee.objects.all(), required=False)

    class Meta:
        model = LeaveRecord
        fields = ["id", "employee", "employee_name", "leave_type", "start_date", "end_date", "reason", "status", "created_by", "approved_by", "approved_by_name", "approved_at", "created_at", "updated_at"]
        read_only_fields = ["created_by", "approved_by", "approved_by_name", "approved_at", "created_at", "updated_at"]

    def validate(self, attrs):
        if attrs.get("end_date") and attrs.get("start_date") and attrs["end_date"] < attrs["start_date"]:
            raise serializers.ValidationError({"end_date": "End date cannot be before start date."})
        request = self.context.get("request")
        role = getattr(getattr(request, "user", None), "profile", None)
        if attrs.get("employee") is None and getattr(role, "role", None) != "EMPLOYEE":
            raise serializers.ValidationError({"employee": "Select a guard for this leave request."})
        return attrs

    def get_approved_by_name(self, obj):
        return obj.approved_by.get_full_name() if obj.approved_by else None


class DocumentOptionSerializer(serializers.ModelSerializer):
    class Meta:
        model = DocumentOption
        fields = ["id", "name", "instructions", "required", "is_active", "builtin_key"]

    def validate_name(self, value):
        if self.instance and self.instance.builtin_key:
            if value != self.instance.name:
                raise serializers.ValidationError("The built-in document name cannot be changed.")
            return value
        if value.casefold() in RESERVED_DOCUMENT_NAMES:
            raise serializers.ValidationError("This name is already used by a built-in document option.")
        matches = DocumentOption.objects.filter(name__iexact=value)
        if self.instance:
            matches = matches.exclude(pk=self.instance.pk)
        if matches.exists():
            raise serializers.ValidationError("A document option with this name already exists. Edit or restore it instead.")
        return value

    def validate(self, attrs):
        if self.instance and self.instance.builtin_key and attrs.keys() - {"required", "name"}:
            raise serializers.ValidationError("Only the upload requirement can be changed for a built-in document option.")
        return attrs


class EmployeeDocumentSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    document_option = serializers.PrimaryKeyRelatedField(queryset=DocumentOption.objects.all(), required=False, allow_null=True)
    document_type = serializers.CharField(max_length=100, required=False)
    document_label = serializers.CharField(read_only=True)
    status = serializers.ReadOnlyField()
    secure_file_url = serializers.SerializerMethodField()
    reviewed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = EmployeeDocument
        validators = []
        fields = ["id", "employee", "employee_name", "document_type", "document_option", "document_label", "document_number", "certificate_type", "certificate_name", "issue_date", "expiry_date", "file_url", "file", "secure_file_url", "notes", "status", "verification_status", "reviewed_by", "reviewed_by_name", "reviewed_at", "rejection_reason", "drive_file_id", "drive_folder_id", "drive_root_folder_id", "drive_synced_at", "drive_sync_error", "created_by", "created_at", "updated_at"]
        read_only_fields = ["created_by", "status", "verification_status", "reviewed_by", "reviewed_by_name", "reviewed_at", "rejection_reason", "drive_file_id", "drive_folder_id", "drive_root_folder_id", "drive_synced_at", "drive_sync_error", "created_at", "updated_at"]

    def to_internal_value(self, data):
        data = copy(data)
        for field in ("issue_date", "expiry_date"):
            # Older clients appended nullable dates directly to FormData.
            if data.get(field) in ("", "null"):
                data[field] = None
        return super().to_internal_value(data)

    def get_secure_file_url(self, obj):
        if not obj.file:
            return None
        request = self.context.get("request")
        path = f"/api/media/document/{obj.pk}/"
        return request.build_absolute_uri(path) if request else path

    def get_reviewed_by_name(self, obj):
        return (obj.reviewed_by.get_full_name() or obj.reviewed_by.username) if obj.reviewed_by else None

    def validate_file(self, value):
        max_size = 10 * 1024 * 1024
        if value.size > max_size:
            raise serializers.ValidationError("Each document must be 10 MB or smaller.")
        extension = value.name.lower().rsplit(".", 1)[-1] if "." in value.name else ""
        allowed_extensions = {"pdf", "jpg", "jpeg", "png", "webp"}
        if extension not in allowed_extensions:
            raise serializers.ValidationError("Only PDF, JPG, JPEG, PNG or WEBP files are allowed.")
        content_type = getattr(value, "content_type", "")
        allowed_types = {"application/pdf", "image/jpeg", "image/png", "image/webp"}
        if content_type and content_type not in allowed_types:
            raise serializers.ValidationError("The uploaded file type is not supported.")
        header = value.read(16)
        value.seek(0)
        signatures = {
            "pdf": header.startswith(b"%PDF-"),
            "jpg": header.startswith(b"\xff\xd8\xff"),
            "jpeg": header.startswith(b"\xff\xd8\xff"),
            "png": header.startswith(b"\x89PNG\r\n\x1a\n"),
            "webp": header.startswith(b"RIFF") and header[8:12] == b"WEBP",
        }
        if not signatures.get(extension, False):
            raise serializers.ValidationError("The file content does not match its extension.")
        return value

    def validate(self, attrs):
        employee = attrs.get("employee", getattr(self.instance, "employee", None))
        document_type = attrs.get("document_type", getattr(self.instance, "document_type", ""))
        document_option = attrs.get("document_option", getattr(self.instance, "document_option", None))
        uploaded_file = attrs.get("file")
        if self.instance and getattr(document_option, "pk", None) != self.instance.document_option_id:
            raise serializers.ValidationError({"document_option": "The document option on an existing upload cannot be changed."})
        if document_option:
            if document_option.builtin_key:
                raise serializers.ValidationError({"document_option": "Use the built-in document type to upload this file."})
            request = self.context.get("request")
            file = attrs.get("file", getattr(self.instance, "file", None))
            file_url = attrs.get("file_url", getattr(self.instance, "file_url", ""))
            if not file and (not file_url or (request and is_guard(request.user) and "file_url" in attrs)):
                raise serializers.ValidationError({"file": "Upload a file for this document option."})
            issue = attrs.get("issue_date", getattr(self.instance, "issue_date", None))
            expiry = attrs.get("expiry_date", getattr(self.instance, "expiry_date", None))
            if issue and issue > timezone.localdate():
                raise serializers.ValidationError({"issue_date": "Issue date cannot be in the future."})
            if issue and expiry and expiry < issue:
                raise serializers.ValidationError({"expiry_date": "Expiry date cannot be before the issue date."})
            if not self.instance:
                attrs["document_type"] = document_option.name
            else:
                attrs.pop("document_type", None)
            return attrs
        if not document_type:
            raise serializers.ValidationError({"document_type": "Select a document type."})
        if uploaded_file and str(document_type).strip().casefold() == "personal photograph":
            extension = uploaded_file.name.lower().rsplit(".", 1)[-1] if "." in uploaded_file.name else ""
            if extension not in {"jpg", "jpeg", "png", "webp"}:
                raise serializers.ValidationError({"file": "Profile picture must be a JPG, JPEG, PNG or WEBP image."})
        existing = EmployeeDocument.objects.filter(employee=employee, document_option__isnull=True, document_type__iexact=document_type)
        if self.instance:
            existing = existing.exclude(pk=self.instance.pk)
        certificate = document_type == "Certificates"
        if certificate:
            certificate_type = attrs.get("certificate_type", getattr(self.instance, "certificate_type", ""))
            certificate_name = attrs.get("certificate_name", getattr(self.instance, "certificate_name", "")).strip()
            if not certificate_type:
                raise serializers.ValidationError({"certificate_type": "Select a certificate type."})
            if certificate_type == "OTHER" and not certificate_name:
                raise serializers.ValidationError({"certificate_name": "Enter the certificate name."})
            if not (uploaded_file or getattr(self.instance, "file", None) or attrs.get("file_url") or getattr(self.instance, "file_url", "")):
                raise serializers.ValidationError({"file": "Upload the certificate file."})
            attrs["certificate_name"] = certificate_name if certificate_type == "OTHER" else ""
        if employee and document_type and not certificate and existing.exists():
            raise serializers.ValidationError({"document_type": "This employee already has this document. Update the existing record instead."})
        saved_issue_date = getattr(self.instance, "issue_date", None)
        saved_expiry_date = getattr(self.instance, "expiry_date", None)
        issue_date = attrs.get("issue_date", saved_issue_date)
        expiry_date = attrs.get("expiry_date", saved_expiry_date)
        issue_changed = issue_date != saved_issue_date
        expiry_changed = expiry_date != saved_expiry_date
        evidence_changed = (
            self.instance is None or document_type != self.instance.document_type
            or bool(uploaded_file) or ("file_url" in attrs and attrs["file_url"] != self.instance.file_url)
        )
        proof_types = {"Proof of Address (last 3 months)", "Proof of Address 1 (last 3 months)", "Proof of Address 2 (last 3 months)"}
        if document_type in proof_types and (evidence_changed or issue_changed):
            if not issue_date:
                raise serializers.ValidationError({"issue_date": "Proof of address must include its issue date."})
            today = timezone.localdate()
            if issue_date > today or issue_date < today - timedelta(days=92):
                raise serializers.ValidationError({"issue_date": "Proof of address must be dated within the last 3 months."})
        if (evidence_changed or issue_changed) and issue_date and issue_date > timezone.localdate():
            raise serializers.ValidationError({"issue_date": "Issue date cannot be in the future."})
        if (evidence_changed or issue_changed or expiry_changed) and issue_date and expiry_date and expiry_date < issue_date:
            raise serializers.ValidationError({"expiry_date": "Expiry date cannot be before the issue date."})
        expiry_types = {"Passport (First 2 pages)", "SIA Card (Front)", "SIA Card (Front & Back)", "Share Code", "ACT certificate", "CSCS Card (Front)"}
        act_certificate = certificate and certificate_type == "ACT"
        became_act = act_certificate and getattr(self.instance, "certificate_type", "") != "ACT"
        if (document_type in expiry_types or act_certificate) and (evidence_changed or expiry_changed or became_act) and not expiry_date:
            raise serializers.ValidationError({"expiry_date": "This document requires an expiry date."})
        code_types = {"Share Code", "National Insurance Number (NI)", "PPAC Code"}
        notes = attrs.get("notes", getattr(self.instance, "notes", ""))
        document_number = attrs.get("document_number", getattr(self.instance, "document_number", ""))
        if document_type in code_types and not (uploaded_file or getattr(self.instance, "file", None) or attrs.get("file_url") or getattr(self.instance, "file_url", "") or notes.strip() or document_number.strip()):
            raise serializers.ValidationError({"notes": "Enter the code/number or upload supporting evidence."})
        return attrs


class TimesheetSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    site_name = serializers.CharField(source="site.name", read_only=True)
    scheduled_hours = serializers.ReadOnlyField()
    actual_hours = serializers.ReadOnlyField()

    class Meta:
        model = Timesheet
        fields = ["id", "employee", "employee_name", "site", "site_name", "work_date", "scheduled_start", "scheduled_end", "actual_start", "actual_end", "scheduled_hours", "actual_hours", "overtime_minutes", "notes", "approved", "created_by", "created_at", "updated_at", "operation", "actual_start_at", "actual_end_at", "review_flags", "approved_by", "approved_at"]
        read_only_fields = ["created_by", "scheduled_hours", "actual_hours", "created_at", "updated_at", "operation", "actual_start_at", "actual_end_at", "review_flags", "approved_by", "approved_at"]

    def validate(self, attrs):
        if self.instance and self.instance.operation_id:
            protected = {"employee", "site", "work_date", "scheduled_start", "scheduled_end", "actual_start", "actual_end"}
            if protected.intersection(attrs):
                raise serializers.ValidationError("Attendance timesheets retain recorded evidence. Review and approve the draft without replacing its timestamps.")
        for prefix in ["scheduled", "actual"]:
            start = attrs.get(f"{prefix}_start")
            end = attrs.get(f"{prefix}_end")
            if (start and not end) or (end and not start):
                raise serializers.ValidationError({f"{prefix}_end": f"Provide both {prefix} start and end times."})
        return attrs


class ShiftAttendanceEventSerializer(serializers.ModelSerializer):
    photo_url = serializers.SerializerMethodField()
    event_label = serializers.CharField(source="get_event_type_display", read_only=True)

    class Meta:
        model = ShiftAttendanceEvent
        fields = ["id", "event_type", "event_label", "sequence", "photo", "photo_url", "latitude", "longitude", "accuracy_m", "distance_m", "location_status", "notes", "late_reason", "captured_at", "created_by"]
        read_only_fields = ["id", "event_label", "photo_url", "distance_m", "location_status", "captured_at", "created_by"]

    def get_photo_url(self, obj):
        if not obj.photo:
            return None
        request = self.context.get("request")
        path = f"/api/media/attendance/{obj.pk}/"
        return request.build_absolute_uri(path) if request else path


class HourlyCheckinNoteSerializer(serializers.ModelSerializer):
    class Meta:
        model = HourlyCheckinNote
        fields = ["id", "sequence", "reason", "created_at", "updated_at", "created_by"]
        read_only_fields = ["id", "created_at", "updated_at", "created_by"]


class DailyOperationSerializer(serializers.ModelSerializer):
    site_address = serializers.CharField(source="site.address", read_only=True)
    completion_summary = serializers.SerializerMethodField()
    attendance_mode = serializers.CharField(source="site.attendance_mode", read_only=True)
    attendance_mode_label = serializers.CharField(source="site.get_attendance_mode_display", read_only=True)
    hourly_pictures_required = serializers.BooleanField(source="site.hourly_pictures_required", read_only=True)
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    site_name = serializers.CharField(source="site.name", read_only=True)
    site_latitude = serializers.FloatField(source="site.latitude", read_only=True)
    site_longitude = serializers.FloatField(source="site.longitude", read_only=True)
    site_geofence_radius_m = serializers.IntegerField(source="site.geofence_radius_m", read_only=True)
    shift_name = serializers.CharField(source="shift_type.name", read_only=True)
    scheduled_start = serializers.TimeField(source="start_time", read_only=True)
    scheduled_end = serializers.TimeField(source="end_time", read_only=True)
    reached_by_name = serializers.SerializerMethodField()
    delay_minutes = serializers.SerializerMethodField()
    arrival_status = serializers.SerializerMethodField()
    attendance_events = ShiftAttendanceEventSerializer(many=True, read_only=True)
    hourly_checkin_notes = HourlyCheckinNoteSerializer(many=True, read_only=True)
    book_off_note = serializers.SerializerMethodField()
    book_off_due_at = serializers.SerializerMethodField()
    book_off_deadline_at = serializers.SerializerMethodField()
    book_off_status = serializers.SerializerMethodField()
    expected_hourly_checkins = serializers.SerializerMethodField()
    hourly_checkins = serializers.SerializerMethodField()
    attendance_status = serializers.SerializerMethodField()
    book_on_due_at = serializers.SerializerMethodField()
    book_on_is_late = serializers.SerializerMethodField()

    class Meta:
        model = DailyOperation
        fields = ["id", "operation_date", "site", "site_name", "site_address", "site_latitude", "site_longitude", "site_geofence_radius_m", "attendance_mode", "attendance_mode_label", "hourly_pictures_required", "shift_type", "shift_name", "scheduled_start", "scheduled_end", "employee", "employee_name", "status", "arrival_status", "reached_at", "reached_by", "reached_by_name", "delay_minutes", "notes", "follow_up", "attendance_events", "hourly_checkin_notes", "book_on_due_at", "book_on_is_late", "book_off_note", "book_off_due_at", "book_off_deadline_at", "book_off_status", "expected_hourly_checkins", "hourly_checkins", "attendance_status", "completion_summary", "created_by", "created_at", "updated_at"]
        read_only_fields = ["created_by", "reached_by", "reached_by_name", "reached_at", "scheduled_start", "delay_minutes", "arrival_status", "created_at", "updated_at"]

    def validate(self, attrs):
        if self.instance:
            from .models import DutyLocationState
            identity = {"employee", "site", "shift_type", "operation_date"}
            changed = any((getattr(attrs[field], "pk", attrs[field]) != getattr(self.instance, field + "_id" if field != "operation_date" else field)) for field in identity.intersection(attrs))
            if changed and DutyLocationState.objects.filter(operation=self.instance).exists():
                raise serializers.ValidationError("Duty location evidence retains its original guard, site, shift and date.")
        if self.instance and self.instance.attendance_events.filter(event_type="BOOK_OFF").exists():
            if {"employee", "site", "shift_type", "operation_date"}.intersection(attrs):
                raise serializers.ValidationError("Completed attendance retains its original guard, site, shift and date.")
        return attrs

    def get_reached_by_name(self, obj):
        if not obj.reached_by:
            return None
        return obj.reached_by.get_full_name() or obj.reached_by.get_username()

    def get_book_on_due_at(self, obj):
        return obj.scheduled_start_at.isoformat()

    def get_completion_summary(self, obj):
        from .attendance_completion import completion_summary
        return completion_summary(obj)

    def get_book_on_is_late(self, obj):
        event = next((event for event in obj.attendance_events.all() if event.event_type == ShiftAttendanceEvent.EventType.BOOK_ON), None)
        return (event.captured_at if event else timezone.now()) > obj.scheduled_start_at

    def get_delay_minutes(self, obj):
        from .arrival_reporting import arrival_snapshot
        return arrival_snapshot(obj)[1]

    def get_arrival_status(self, obj):
        from .arrival_reporting import arrival_snapshot
        return arrival_snapshot(obj)[0]

    def get_expected_hourly_checkins(self, obj):
        return obj.expected_hourly_checkins

    def _book_off_window(self, obj):
        due_at = obj.scheduled_end_at
        return due_at, due_at + timedelta(minutes=30)

    def get_book_off_due_at(self, obj):
        return self._book_off_window(obj)[0].isoformat()

    def get_book_off_deadline_at(self, obj):
        return self._book_off_window(obj)[1].isoformat()

    def get_book_off_status(self, obj):
        if any(event.event_type == ShiftAttendanceEvent.EventType.BOOK_OFF for event in obj.attendance_events.all()):
            return "COMPLETED"
        if not any(event.event_type == ShiftAttendanceEvent.EventType.BOOK_ON for event in obj.attendance_events.all()):
            return "UPCOMING"
        due_at, deadline_at = self._book_off_window(obj)
        now = timezone.now()
        return "UPCOMING" if now < due_at else "AVAILABLE" if now <= deadline_at else "EXPIRED"

    def get_book_off_note(self, obj):
        try:
            note = obj.book_off_note
        except BookOffNote.DoesNotExist:
            return None
        return {"reason": note.reason, "created_at": note.created_at.isoformat(), "updated_at": note.updated_at.isoformat()}

    def get_hourly_checkins(self, obj):
        from .attendance_windows import HOURLY_PICTURE_WINDOW
        expected = self.get_expected_hourly_checkins(obj)
        shift_start = obj.scheduled_start_at
        events = {event.sequence: event for event in obj.attendance_events.all() if event.event_type == ShiftAttendanceEvent.EventType.HOURLY}
        notes = {note.sequence: note for note in obj.hourly_checkin_notes.all()}
        now = timezone.now()
        result = []
        for sequence in range(1, expected + 1):
            due_at = shift_start + timedelta(hours=sequence)
            deadline_at = due_at + HOURLY_PICTURE_WINDOW
            event = events.get(sequence)
            note = notes.get(sequence)
            result.append({
                "sequence": sequence,
                "due_at": due_at.isoformat(),
                "deadline_at": deadline_at.isoformat(),
                "status": "COMPLETED" if event else "EXPIRED" if now > deadline_at else "AVAILABLE" if now >= due_at else "UPCOMING",
                "captured_at": event.captured_at.isoformat() if event else None,
                "photo_url": self.context.get("request").build_absolute_uri(f"/api/media/attendance/{event.pk}/") if event and event.photo and self.context.get("request") else f"/api/media/attendance/{event.pk}/" if event and event.photo else None,
                "missed_reason": note.reason if note else "",
                "missed_reason_created_at": note.created_at.isoformat() if note else None,
            })
        return result

    def get_attendance_status(self, obj):
        events = list(obj.attendance_events.all())
        if any(event.event_type == ShiftAttendanceEvent.EventType.BOOK_OFF for event in events):
            return "BOOKED_OFF"
        if any(event.event_type == ShiftAttendanceEvent.EventType.BOOK_ON for event in events):
            return "ON_DUTY"
        return "NOT_STARTED"


class DailyArrivalReportSerializer(serializers.ModelSerializer):
    shift_name = serializers.CharField(source="shift_type.name", read_only=True)
    pdf_url = serializers.SerializerMethodField()

    class Meta:
        model = DailyArrivalReport
        fields = ["id", "report_date", "shift_type", "shift_name", "pdf_file", "pdf_url", "scheduled_count", "reached_count", "late_count", "not_reached_count", "unassigned_count", "generated_by", "generated_at"]
        read_only_fields = ["pdf_file", "pdf_url", "scheduled_count", "reached_count", "late_count", "not_reached_count", "unassigned_count", "generated_by", "generated_at"]

    def get_pdf_url(self, obj):
        if not obj.pdf_file:
            return None
        request = self.context.get("request")
        path = f"/api/media/report/daily/{obj.pk}/"
        return request.build_absolute_uri(path) if request else path


class ClientArrivalReportSerializer(serializers.ModelSerializer):
    shift_name = serializers.CharField(source="shift_type.name", read_only=True)
    pdf_url = serializers.SerializerMethodField()

    class Meta:
        model = ClientArrivalReport
        fields = ["id", "client", "report_date", "shift_type", "shift_name", "pdf_file", "pdf_url", "scheduled_count", "reached_count", "late_count", "not_reached_count", "unassigned_count", "generated_at"]
        read_only_fields = ["pdf_file", "pdf_url", "scheduled_count", "reached_count", "late_count", "not_reached_count", "unassigned_count", "generated_at"]

    def get_pdf_url(self, obj):
        if not obj.pdf_file:
            return None
        request = self.context.get("request")
        path = f"/api/media/report/client/{obj.pk}/"
        return request.build_absolute_uri(path) if request else path


class NotificationSerializer(serializers.ModelSerializer):
    category_label = serializers.CharField(source="get_category_display", read_only=True)
    class Meta:
        model = Notification
        fields = ["id", "notification_type", "title", "message", "link", "is_read", "created_at", "category", "category_label", "priority", "context"]
        read_only_fields = fields


class AuditLogSerializer(serializers.ModelSerializer):
    user_name = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = ["id", "user", "user_name", "action", "model_name", "object_id", "summary", "before_data", "after_data", "created_at"]

    def get_user_name(self, obj):
        return obj.user.get_full_name() or obj.user.get_username() if obj.user else "System"
