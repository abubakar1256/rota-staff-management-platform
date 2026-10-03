from django.contrib import admin

from .models import AuditLog, DailyArrivalReport, DailyOperation, Employee, EmployeeDocument, LeaveRecord, Notification, RotaAssignment, RotaWeek, ShiftType, Site, Timesheet, UserProfile


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "role")
    list_filter = ("role",)


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = ("employee_id", "name", "position", "status", "joining_date")
    list_filter = ("status",)
    search_fields = ("employee_id", "name", "phone")


@admin.register(Site)
class SiteAdmin(admin.ModelAdmin):
    list_display = ("site_id", "name", "required_guards", "is_active")
    list_filter = ("is_active",)
    search_fields = ("site_id", "name", "address")


@admin.register(ShiftType)
class ShiftTypeAdmin(admin.ModelAdmin):
    list_display = ("name", "start_time", "end_time", "is_active")
    list_filter = ("is_active",)


@admin.register(RotaWeek)
class RotaWeekAdmin(admin.ModelAdmin):
    list_display = ("week_start", "status", "created_by", "published_at")
    list_filter = ("status",)


@admin.register(RotaAssignment)
class RotaAssignmentAdmin(admin.ModelAdmin):
    list_display = ("work_date", "shift_type", "site", "employee", "rota_week")
    list_filter = ("shift_type", "site")


@admin.register(LeaveRecord)
class LeaveRecordAdmin(admin.ModelAdmin):
    list_display = ("employee", "leave_type", "start_date", "end_date", "status")
    list_filter = ("status", "leave_type")


@admin.register(EmployeeDocument)
class EmployeeDocumentAdmin(admin.ModelAdmin):
    list_display = ("employee", "document_type", "document_number", "expiry_date", "status")
    search_fields = ("employee__name", "document_type", "document_number")


@admin.register(Timesheet)
class TimesheetAdmin(admin.ModelAdmin):
    list_display = ("work_date", "employee", "site", "actual_start", "actual_end", "approved")
    list_filter = ("approved", "site")


@admin.register(DailyOperation)
class DailyOperationAdmin(admin.ModelAdmin):
    list_display = ("operation_date", "site", "shift_type", "employee", "status", "reached_at", "reached_by")
    list_filter = ("status", "operation_date", "site")


@admin.register(DailyArrivalReport)
class DailyArrivalReportAdmin(admin.ModelAdmin):
    list_display = ("report_date", "shift_type", "scheduled_count", "reached_count", "late_count", "generated_at")
    list_filter = ("report_date", "shift_type")


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("title", "user", "notification_type", "is_read", "created_at")
    list_filter = ("notification_type", "is_read")


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ("created_at", "action", "model_name", "object_id", "user", "summary")
    list_filter = ("action", "model_name")
