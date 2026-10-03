from django.conf import settings
from django.db import models
from django.db.models.functions import Lower, Trim


class UserProfile(models.Model):
    class Role(models.TextChoices):
        SUPER_ADMIN = "SUPER_ADMIN", "Super Admin"
        ADMIN = "ADMIN", "Admin"
        MANAGER = "MANAGER", "Manager"
        OPERATOR = "OPERATOR", "Operator"
        # Kept for existing installations; permissions treat it like Operator.
        RECEPTIONIST = "RECEPTIONIST", "Receptionist"
        EMPLOYEE = "EMPLOYEE", "Guard"
        CLIENT_ADMIN = "CLIENT_ADMIN", "Client Admin"

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.RECEPTIONIST)
    managed_sites = models.ManyToManyField("Site", blank=True, related_name="manager_profiles")
    client = models.ForeignKey("Client", on_delete=models.PROTECT, related_name="user_profiles", null=True, blank=True)

    def __str__(self):
        return f"{self.user.get_username()} ({self.get_role_display()})"


class Client(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "ACTIVE", "Active"
        INACTIVE = "INACTIVE", "Inactive"

    client_id = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=160)
    contact_name = models.CharField(max_length=160, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    address = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return f"{self.client_id} - {self.name}"


class Employee(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "ACTIVE", "Active"
        INACTIVE = "INACTIVE", "Inactive"
        ON_LEAVE = "ON_LEAVE", "On leave"

    employee_id = models.CharField(max_length=40, unique=True)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, related_name="employee_record", null=True, blank=True)
    name = models.CharField(max_length=160)
    position = models.CharField(max_length=100, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    address = models.TextField(blank=True)
    emergency_contact = models.CharField(max_length=160, blank=True)
    emergency_contact_name = models.CharField(max_length=160, blank=True)
    emergency_contact_phone = models.CharField(max_length=40, blank=True)
    emergency_contact_relationship = models.CharField(max_length=80, blank=True)
    joining_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(Lower(Trim("name")), name="unique_employee_name_ci"),
        ]

    def __str__(self):
        return f"{self.employee_id} - {self.name}"


class EmployeePortalInvite(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="portal_invites")
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_portal_invites")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Portal invite for {self.employee.name}"


class Site(models.Model):
    client = models.ForeignKey(Client, on_delete=models.PROTECT, related_name="sites", null=True, blank=True)
    site_id = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=160)
    address = models.TextField(blank=True)
    contact_name = models.CharField(max_length=160, blank=True)
    contact_phone = models.CharField(max_length=40, blank=True)
    required_guards = models.PositiveIntegerField(default=1)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    geofence_radius_m = models.PositiveIntegerField(default=150)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return f"{self.site_id} - {self.name}"


class ShiftType(models.Model):
    name = models.CharField(max_length=80, unique=True)
    start_time = models.TimeField()
    end_time = models.TimeField()
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["start_time", "name"]

    @property
    def crosses_midnight(self):
        return self.end_time <= self.start_time

    def __str__(self):
        return f"{self.name} ({self.start_time:%H:%M}-{self.end_time:%H:%M})"


class RotaWeek(models.Model):
    class Status(models.TextChoices):
        DRAFT = "DRAFT", "Draft"
        PUBLISHED = "PUBLISHED", "Published"

    week_start = models.DateField(unique=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_rota_weeks")
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-week_start"]

    def __str__(self):
        return f"Week starting {self.week_start} ({self.get_status_display()})"


class RotaConfirmation(models.Model):
    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        CONFIRMED = "CONFIRMED", "Confirmed"

    rota_week = models.ForeignKey(RotaWeek, on_delete=models.CASCADE, related_name="confirmations")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="rota_confirmations")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["status", "employee__name"]
        constraints = [
            models.UniqueConstraint(fields=["rota_week", "employee"], name="unique_rota_employee_confirmation"),
        ]

    def __str__(self):
        return f"{self.rota_week} - {self.employee.name} - {self.get_status_display()}"


class RotaAssignment(models.Model):
    rota_week = models.ForeignKey(RotaWeek, on_delete=models.CASCADE, related_name="assignments")
    work_date = models.DateField()
    shift_type = models.ForeignKey(ShiftType, on_delete=models.PROTECT, related_name="assignments")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="rota_assignments", null=True, blank=True)
    site = models.ForeignKey(Site, on_delete=models.PROTECT, related_name="rota_assignments")
    notes = models.CharField(max_length=250, blank=True)
    replaced_assignment = models.ForeignKey("self", on_delete=models.SET_NULL, related_name="replacement_assignments", null=True, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_rota_assignments")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["work_date", "shift_type__start_time", "site__name", "employee__name"]
        constraints = [
            models.UniqueConstraint(fields=["rota_week", "work_date", "shift_type", "site", "employee"], name="unique_rota_employee_slot"),
        ]

    def __str__(self):
        employee = self.employee.name if self.employee else "Unfilled"
        return f"{self.work_date} - {self.shift_type.name} - {self.site.name} - {employee}"


class LeaveRecord(models.Model):
    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        APPROVED = "APPROVED", "Approved"
        REJECTED = "REJECTED", "Rejected"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="leave_records")
    leave_type = models.CharField(max_length=40, default="ANNUAL")
    start_date = models.DateField()
    end_date = models.DateField()
    reason = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_leave_records")
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="approved_leave_records", null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-start_date", "employee__name"]

    def clean(self):
        from django.core.exceptions import ValidationError
        if self.end_date < self.start_date:
            raise ValidationError({"end_date": "End date cannot be before start date."})

    def __str__(self):
        return f"{self.employee.name} - {self.leave_type} ({self.start_date} to {self.end_date})"


class EmployeeDocument(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="documents")
    document_type = models.CharField(max_length=100)
    document_number = models.CharField(max_length=100, blank=True)
    issue_date = models.DateField(null=True, blank=True)
    expiry_date = models.DateField(null=True, blank=True)
    file_url = models.URLField(blank=True)
    file = models.FileField(upload_to="employee-documents/%Y/%m/", blank=True, null=True)
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_documents")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["expiry_date", "employee__name"]

    @property
    def status(self):
        from datetime import timedelta
        from django.utils import timezone
        if not self.expiry_date:
            return "VALID"
        today = timezone.localdate()
        if self.expiry_date < today:
            return "EXPIRED"
        if self.expiry_date <= today + timedelta(days=30):
            return "EXPIRING_SOON"
        return "VALID"

    def __str__(self):
        return f"{self.employee.name} - {self.document_type}"


class Timesheet(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="timesheets")
    site = models.ForeignKey(Site, on_delete=models.PROTECT, related_name="timesheets", null=True, blank=True)
    work_date = models.DateField()
    scheduled_start = models.TimeField(null=True, blank=True)
    scheduled_end = models.TimeField(null=True, blank=True)
    actual_start = models.TimeField(null=True, blank=True)
    actual_end = models.TimeField(null=True, blank=True)
    overtime_minutes = models.PositiveIntegerField(default=0)
    notes = models.CharField(max_length=250, blank=True)
    approved = models.BooleanField(default=False)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_timesheets")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-work_date", "employee__name"]

    @staticmethod
    def _hours(start, end):
        if not start or not end:
            return 0
        start_minutes = start.hour * 60 + start.minute
        end_minutes = end.hour * 60 + end.minute
        if end_minutes <= start_minutes:
            end_minutes += 24 * 60
        return round((end_minutes - start_minutes) / 60, 2)

    @property
    def scheduled_hours(self):
        return self._hours(self.scheduled_start, self.scheduled_end)

    @property
    def actual_hours(self):
        return self._hours(self.actual_start, self.actual_end)

    def __str__(self):
        return f"{self.work_date} - {self.employee.name}"


class DailyOperation(models.Model):
    class Status(models.TextChoices):
        PRESENT = "PRESENT", "Present"
        ABSENT = "ABSENT", "Absent"
        UNCONFIRMED = "UNCONFIRMED", "Unconfirmed"
        REPLACEMENT_NEEDED = "REPLACEMENT_NEEDED", "Replacement needed"

    operation_date = models.DateField()
    site = models.ForeignKey(Site, on_delete=models.PROTECT, related_name="daily_operations")
    shift_type = models.ForeignKey(ShiftType, on_delete=models.PROTECT, related_name="daily_operations")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="daily_operations", null=True, blank=True)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.UNCONFIRMED)
    notes = models.TextField(blank=True)
    follow_up = models.TextField(blank=True)
    reached_at = models.DateTimeField(null=True, blank=True)
    reached_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, related_name="verified_daily_operations", null=True, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_daily_operations")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-operation_date", "site__name", "shift_type__start_time"]

    def __str__(self):
        return f"{self.operation_date} - {self.site.name} - {self.shift_type.name}"


class ShiftAttendanceEvent(models.Model):
    class EventType(models.TextChoices):
        BOOK_ON = "BOOK_ON", "Book On"
        HOURLY = "HOURLY", "Hourly check-in"
        BOOK_OFF = "BOOK_OFF", "Book Off"

    class LocationStatus(models.TextChoices):
        VERIFIED = "VERIFIED", "Verified"
        OUTSIDE_SITE = "OUTSIDE_SITE", "Outside site"
        LOCATION_UNVERIFIED = "LOCATION_UNVERIFIED", "Location unverified"

    operation = models.ForeignKey(DailyOperation, on_delete=models.CASCADE, related_name="attendance_events")
    event_type = models.CharField(max_length=20, choices=EventType.choices)
    sequence = models.PositiveIntegerField(default=0)
    photo = models.FileField(upload_to="shift-attendance/%Y/%m/", blank=False)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    accuracy_m = models.FloatField(null=True, blank=True)
    distance_m = models.FloatField(null=True, blank=True)
    location_status = models.CharField(max_length=30, choices=LocationStatus.choices, default=LocationStatus.LOCATION_UNVERIFIED)
    notes = models.CharField(max_length=250, blank=True)
    captured_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_shift_attendance_events")

    class Meta:
        ordering = ["captured_at"]
        constraints = [
            models.UniqueConstraint(fields=["operation", "event_type", "sequence"], name="unique_shift_attendance_event")
        ]

    def __str__(self):
        return f"{self.operation} - {self.get_event_type_display()}"


class DailyArrivalReport(models.Model):
    report_date = models.DateField()
    shift_type = models.ForeignKey(ShiftType, on_delete=models.PROTECT, related_name="arrival_reports")
    pdf_file = models.FileField(upload_to="arrival-reports/%Y/%m/")
    scheduled_count = models.PositiveIntegerField(default=0)
    reached_count = models.PositiveIntegerField(default=0)
    late_count = models.PositiveIntegerField(default=0)
    not_reached_count = models.PositiveIntegerField(default=0)
    unassigned_count = models.PositiveIntegerField(default=0)
    generated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, related_name="generated_arrival_reports", null=True, blank=True)
    generated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-report_date", "shift_type__start_time"]
        constraints = [
            models.UniqueConstraint(fields=["report_date", "shift_type"], name="unique_daily_arrival_report_shift"),
        ]

    def __str__(self):
        return f"{self.report_date} - {self.shift_type.name} arrival report"


class ClientArrivalReport(models.Model):
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="arrival_reports")
    report_date = models.DateField()
    shift_type = models.ForeignKey(ShiftType, on_delete=models.PROTECT, related_name="client_arrival_reports")
    pdf_file = models.FileField(upload_to="client-arrival-reports/%Y/%m/")
    scheduled_count = models.PositiveIntegerField(default=0)
    reached_count = models.PositiveIntegerField(default=0)
    late_count = models.PositiveIntegerField(default=0)
    not_reached_count = models.PositiveIntegerField(default=0)
    unassigned_count = models.PositiveIntegerField(default=0)
    generated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, related_name="generated_client_arrival_reports", null=True, blank=True)
    generated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-report_date", "shift_type__start_time"]
        constraints = [
            models.UniqueConstraint(fields=["client", "report_date", "shift_type"], name="unique_client_arrival_report_shift"),
        ]

    def __str__(self):
        return f"{self.client.name} - {self.report_date} - {self.shift_type.name} arrival report"


class Notification(models.Model):
    class Type(models.TextChoices):
        INFO = "INFO", "Info"
        WARNING = "WARNING", "Warning"
        SUCCESS = "SUCCESS", "Success"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications", null=True, blank=True)
    notification_type = models.CharField(max_length=20, choices=Type.choices, default=Type.INFO)
    title = models.CharField(max_length=160)
    message = models.TextField()
    link = models.CharField(max_length=250, blank=True)
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title


class AuditLog(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_logs")
    action = models.CharField(max_length=20)
    model_name = models.CharField(max_length=100)
    object_id = models.CharField(max_length=64, blank=True)
    summary = models.CharField(max_length=250)
    before_data = models.JSONField(default=dict, blank=True)
    after_data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.action} {self.model_name} {self.object_id}" 
