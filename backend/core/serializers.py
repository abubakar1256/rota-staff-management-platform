from datetime import datetime, timedelta
from math import ceil
from secrets import token_urlsafe

from django.contrib.auth import authenticate, get_user_model
from django.utils import timezone
from rest_framework import serializers

from .models import AuditLog, Client, ClientArrivalReport, DailyArrivalReport, DailyOperation, Employee, EmployeeDocument, LeaveRecord, Notification, RotaAssignment, RotaConfirmation, RotaWeek, ShiftAttendanceEvent, ShiftType, Site, Timesheet, UserProfile


User = get_user_model()


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        user = authenticate(username=attrs["username"], password=attrs["password"])
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
        return attrs

    def to_representation(self, instance):
        data = super().to_representation(instance)
        profile = getattr(instance, "profile", None)
        data["managed_site_ids"] = list(profile.managed_sites.values_list("id", flat=True)) if profile else []
        data["client_id"] = profile.client_id if profile else None
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
        return instance


class EmployeeSerializer(serializers.ModelSerializer):
    profile_completion = serializers.SerializerMethodField(read_only=True)
    has_portal_account = serializers.SerializerMethodField(read_only=True)
    portal_status = serializers.SerializerMethodField(read_only=True)
    documents_completion = serializers.SerializerMethodField(read_only=True)

    def validate_name(self, value):
        normalized = " ".join(value.split())
        duplicate = Employee.objects.filter(name__iexact=normalized)
        if self.instance:
            duplicate = duplicate.exclude(pk=self.instance.pk)
        if duplicate.exists():
            raise serializers.ValidationError("An employee with this name already exists. Use the existing employee record instead.")
        return normalized

    class Meta:
        model = Employee
        fields = ["id", "employee_id", "user", "name", "position", "phone", "email", "address", "emergency_contact", "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship", "joining_date", "status", "profile_completion", "documents_completion", "has_portal_account", "portal_status", "created_at", "updated_at"]
        read_only_fields = ["id", "user", "profile_completion", "documents_completion", "has_portal_account", "created_at", "updated_at"]

    def get_profile_completion(self, obj):
        fields = [obj.name, obj.position, obj.phone, obj.email, obj.address, obj.emergency_contact_name or obj.emergency_contact, obj.emergency_contact_phone, obj.emergency_contact_relationship, obj.joining_date]
        return round(sum(bool(value) for value in fields) / len(fields) * 100)

    def get_documents_completion(self, obj):
        required_types = {
            "Passport (First 2 pages)",
            "SIA Card (Front & Back)",
            "Proof of Address 1 (last 3 months)",
            "Proof of Address 2 (last 3 months)",
            "Share Code",
            "National Insurance Number (NI)",
            "Personal Photograph",
        }
        completed = obj.documents.filter(document_type__in=required_types).values("document_type").distinct().count()
        return {"completed": completed, "required": len(required_types), "percentage": round(completed / len(required_types) * 100)}

    def get_has_portal_account(self, obj):
        return bool(obj.user_id)

    def get_portal_status(self, obj):
        if not obj.user_id:
            return "NOT_CREATED"
        return "ACTIVE" if obj.user.has_usable_password() else "INVITE_PENDING"


class SiteSerializer(serializers.ModelSerializer):
    client_name = serializers.CharField(source="client.name", read_only=True, allow_null=True)

    class Meta:
        model = Site
        fields = ["id", "client", "client_name", "site_id", "name", "address", "contact_name", "contact_phone", "required_guards", "latitude", "longitude", "geofence_radius_m", "is_active", "created_at", "updated_at"]
        read_only_fields = ["created_at", "updated_at"]


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
    shift_name = serializers.CharField(source="shift_type.name", read_only=True)

    class Meta:
        model = RotaAssignment
        fields = [
            "id", "rota_week", "work_date", "shift_type", "shift_name", "employee", "employee_name", "employee_code",
            "site", "site_name", "notes", "replaced_assignment", "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    def validate(self, attrs):
        request = self.context.get("request")
        rota_week = attrs.get("rota_week", getattr(self.instance, "rota_week", None))
        work_date = attrs.get("work_date", getattr(self.instance, "work_date", None))
        shift_type = attrs.get("shift_type", getattr(self.instance, "shift_type", None))
        employee = attrs.get("employee", getattr(self.instance, "employee", None))

        if rota_week and work_date:
            week_end = rota_week.week_start + __import__("datetime").timedelta(days=6)
            if not rota_week.week_start <= work_date <= week_end:
                raise serializers.ValidationError({"work_date": "Assignment date must fall inside the selected rota week."})
        if employee and employee.status != Employee.Status.ACTIVE:
            raise serializers.ValidationError({"employee": "Only active employees can be assigned to a new rota."})
        if rota_week and rota_week.status == RotaWeek.Status.PUBLISHED:
            raise serializers.ValidationError("Published rotas cannot be changed. Create a new draft week or unpublish it first.")
        if employee and work_date and shift_type:
            if LeaveRecord.objects.filter(employee=employee, status=LeaveRecord.Status.APPROVED, start_date__lte=work_date, end_date__gte=work_date).exists():
                raise serializers.ValidationError({"employee": f"{employee.name} is on approved leave on this date."})
            assignments = RotaAssignment.objects.filter(employee=employee, work_date=work_date).select_related("shift_type")
            if self.instance:
                assignments = assignments.exclude(pk=self.instance.pk)
            duplicate_slot = RotaAssignment.objects.filter(
                rota_week=rota_week,
                work_date=work_date,
                shift_type=shift_type,
                site=attrs.get("site", getattr(self.instance, "site", None)),
                employee=employee,
            )
            if self.instance:
                duplicate_slot = duplicate_slot.exclude(pk=self.instance.pk)
            if duplicate_slot.exists():
                raise serializers.ValidationError({"employee": f"{employee.name} is already assigned to this site and shift."})
            for assignment in assignments:
                if self._shifts_overlap(shift_type, assignment.shift_type):
                    raise serializers.ValidationError({"employee": f"{employee.name} already has an overlapping {assignment.shift_type.name} shift on this date."})
        return attrs

    @staticmethod
    def _shifts_overlap(first, second):
        def interval(shift):
            start = shift.start_time.hour * 60 + shift.start_time.minute
            end = shift.end_time.hour * 60 + shift.end_time.minute
            if end <= start:
                end += 24 * 60
            return start, end

        first_start, first_end = interval(first)
        second_start, second_end = interval(second)
        return first_start < second_end and second_start < first_end


class RotaWeekSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()
    assignment_count = serializers.SerializerMethodField()

    class Meta:
        model = RotaWeek
        fields = ["id", "week_start", "status", "created_by", "created_by_name", "published_at", "assignment_count", "created_at", "updated_at"]
        read_only_fields = ["created_by", "created_by_name", "published_at", "assignment_count", "created_at", "updated_at"]

    def get_created_by_name(self, obj):
        return obj.created_by.get_full_name() or obj.created_by.get_username()

    def get_assignment_count(self, obj):
        return obj.assignments.count()


class RotaConfirmationSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    employee_code = serializers.CharField(source="employee.employee_id", read_only=True)

    class Meta:
        model = RotaConfirmation
        fields = ["id", "rota_week", "employee", "employee_name", "employee_code", "status", "confirmed_at", "updated_at"]
        read_only_fields = ["status", "confirmed_at", "updated_at"]


class LeaveRecordSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    approved_by_name = serializers.SerializerMethodField()

    class Meta:
        model = LeaveRecord
        fields = ["id", "employee", "employee_name", "leave_type", "start_date", "end_date", "reason", "status", "created_by", "approved_by", "approved_by_name", "approved_at", "created_at", "updated_at"]
        read_only_fields = ["created_by", "approved_by", "approved_by_name", "approved_at", "created_at", "updated_at"]

    def validate(self, attrs):
        if attrs.get("end_date") and attrs.get("start_date") and attrs["end_date"] < attrs["start_date"]:
            raise serializers.ValidationError({"end_date": "End date cannot be before start date."})
        return attrs

    def get_approved_by_name(self, obj):
        return obj.approved_by.get_full_name() if obj.approved_by else None


class EmployeeDocumentSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    status = serializers.ReadOnlyField()

    class Meta:
        model = EmployeeDocument
        fields = ["id", "employee", "employee_name", "document_type", "document_number", "issue_date", "expiry_date", "file_url", "file", "notes", "status", "created_by", "created_at", "updated_at"]
        read_only_fields = ["created_by", "status", "created_at", "updated_at"]

    def validate(self, attrs):
        employee = attrs.get("employee", getattr(self.instance, "employee", None))
        document_type = attrs.get("document_type", getattr(self.instance, "document_type", ""))
        existing = EmployeeDocument.objects.filter(employee=employee, document_type__iexact=document_type)
        if self.instance:
            existing = existing.exclude(pk=self.instance.pk)
        if employee and document_type and existing.exists():
            raise serializers.ValidationError({"document_type": "This employee already has this document. Update the existing record instead."})
        proof_types = {"Proof of Address 1 (last 3 months)", "Proof of Address 2 (last 3 months)"}
        if document_type in proof_types:
            issue_date = attrs.get("issue_date", getattr(self.instance, "issue_date", None))
            if not issue_date:
                raise serializers.ValidationError({"issue_date": "Proof of address must include its issue date."})
            today = timezone.localdate()
            if issue_date > today or issue_date < today - timedelta(days=92):
                raise serializers.ValidationError({"issue_date": "Proof of address must be dated within the last 3 months."})
        return attrs


class TimesheetSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    site_name = serializers.CharField(source="site.name", read_only=True)
    scheduled_hours = serializers.ReadOnlyField()
    actual_hours = serializers.ReadOnlyField()

    class Meta:
        model = Timesheet
        fields = ["id", "employee", "employee_name", "site", "site_name", "work_date", "scheduled_start", "scheduled_end", "actual_start", "actual_end", "scheduled_hours", "actual_hours", "overtime_minutes", "notes", "approved", "created_by", "created_at", "updated_at"]
        read_only_fields = ["created_by", "scheduled_hours", "actual_hours", "created_at", "updated_at"]

    def validate(self, attrs):
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
        fields = ["id", "event_type", "event_label", "sequence", "photo", "photo_url", "latitude", "longitude", "accuracy_m", "distance_m", "location_status", "notes", "captured_at", "created_by"]
        read_only_fields = ["id", "event_label", "photo_url", "distance_m", "location_status", "captured_at", "created_by"]

    def get_photo_url(self, obj):
        if not obj.photo:
            return None
        request = self.context.get("request")
        return request.build_absolute_uri(obj.photo.url) if request else obj.photo.url


class DailyOperationSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source="employee.name", read_only=True)
    site_name = serializers.CharField(source="site.name", read_only=True)
    shift_name = serializers.CharField(source="shift_type.name", read_only=True)
    scheduled_start = serializers.TimeField(source="shift_type.start_time", read_only=True)
    reached_by_name = serializers.SerializerMethodField()
    delay_minutes = serializers.SerializerMethodField()
    arrival_status = serializers.SerializerMethodField()
    attendance_events = ShiftAttendanceEventSerializer(many=True, read_only=True)
    expected_hourly_checkins = serializers.SerializerMethodField()
    attendance_status = serializers.SerializerMethodField()

    class Meta:
        model = DailyOperation
        fields = ["id", "operation_date", "site", "site_name", "shift_type", "shift_name", "scheduled_start", "employee", "employee_name", "status", "arrival_status", "reached_at", "reached_by", "reached_by_name", "delay_minutes", "notes", "follow_up", "attendance_events", "expected_hourly_checkins", "attendance_status", "created_by", "created_at", "updated_at"]
        read_only_fields = ["created_by", "reached_by", "reached_by_name", "reached_at", "scheduled_start", "delay_minutes", "arrival_status", "created_at", "updated_at"]

    def get_reached_by_name(self, obj):
        if not obj.reached_by:
            return None
        return obj.reached_by.get_full_name() or obj.reached_by.get_username()

    def get_delay_minutes(self, obj):
        if not obj.reached_at:
            return None
        scheduled = timezone.make_aware(datetime.combine(obj.operation_date, obj.shift_type.start_time), timezone.get_current_timezone())
        return max(0, round((obj.reached_at - scheduled).total_seconds() / 60))

    def get_arrival_status(self, obj):
        if not obj.employee_id:
            return "NOT_ASSIGNED"
        if not obj.reached_at:
            return "NOT_REACHED"
        return "LATE" if self.get_delay_minutes(obj) > 0 else "REACHED"

    def get_expected_hourly_checkins(self, obj):
        start = obj.shift_type.start_time.hour * 60 + obj.shift_type.start_time.minute
        end = obj.shift_type.end_time.hour * 60 + obj.shift_type.end_time.minute
        duration = end - start if end > start else end + 24 * 60 - start
        return max(0, ceil(duration / 60) - 1)

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
        return request.build_absolute_uri(obj.pdf_file.url) if request else obj.pdf_file.url


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
        return request.build_absolute_uri(obj.pdf_file.url) if request else obj.pdf_file.url


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ["id", "notification_type", "title", "message", "link", "is_read", "created_at"]
        read_only_fields = ["notification_type", "title", "message", "link", "created_at"]


class AuditLogSerializer(serializers.ModelSerializer):
    user_name = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = ["id", "user", "user_name", "action", "model_name", "object_id", "summary", "before_data", "after_data", "created_at"]

    def get_user_name(self, obj):
        return obj.user.get_full_name() or obj.user.get_username() if obj.user else "System"
