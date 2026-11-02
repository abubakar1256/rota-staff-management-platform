"""Finish attendance atomically without approving hours or altering evidence."""
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import AuditLog, Notification, ShiftAttendanceEvent, Timesheet

REVIEW_LABELS = {
    "LATE_BOOK_ON": "Late Book On",
    "LOCATION_EXCEPTION": "GPS exception",
    "MISSED_HOURLY_PICTURES": "Missed hourly pictures",
}


def attendance_evidence(operation):
    events = list(operation.attendance_events.all())
    book_on = next((event for event in events if event.event_type == "BOOK_ON"), None)
    book_off = next((event for event in events if event.event_type == "BOOK_OFF"), None)
    flags = []
    if book_on and book_on.captured_at > operation.scheduled_start_at:
        flags.append("LATE_BOOK_ON")
    if any(event.location_status != ShiftAttendanceEvent.LocationStatus.VERIFIED for event in events):
        flags.append("LOCATION_EXCEPTION")
    completed_hourly = {event.sequence for event in events if event.event_type == "HOURLY"}
    if set(range(1, operation.expected_hourly_checkins + 1)) - completed_hourly:
        flags.append("MISSED_HOURLY_PICTURES")
    return book_on, book_off, flags


@transaction.atomic
def complete_shift(operation, user):
    book_on, book_off, flags = attendance_evidence(operation)
    if not book_on or not book_off:
        raise ValueError("Both Book On and Book Off are required to complete a shift.")
    if book_off.captured_at < book_on.captured_at:
        raise ValueError("Book Off cannot precede Book On.")
    start, end = timezone.localtime(book_on.captured_at), timezone.localtime(book_off.captured_at)
    sheet, created = Timesheet.objects.get_or_create(operation=operation, defaults={
        "employee": operation.employee, "site": operation.site, "work_date": operation.operation_date,
        "scheduled_start": operation.shift_type.start_time, "scheduled_end": operation.shift_type.end_time,
        "actual_start": start.time().replace(tzinfo=None), "actual_end": end.time().replace(tzinfo=None),
        "actual_start_at": book_on.captured_at, "actual_end_at": book_off.captured_at,
        "review_flags": flags, "approved": False, "created_by": user,
        "notes": "Created from Book On / Book Off attendance. Awaiting office review.",
    })
    if not created:
        return sheet
    AuditLog.objects.create(user=user, action="CREATE", model_name="Timesheet", object_id=str(sheet.pk),
                            summary=f"Created attendance draft for {operation.employee.name} at {operation.site.name}"[:250])
    admins = get_user_model().objects.filter(is_active=True).filter(Q(is_superuser=True) | Q(profile__role__in=["SUPER_ADMIN", "ADMIN"]))
    detail = ", ".join(REVIEW_LABELS[flag] for flag in flags) if flags else "Draft timesheet ready for review"
    for admin in admins:
        Notification.objects.create(user=admin, notification_type="WARNING" if flags else "INFO",
                                    title="Shift completed - review required" if flags else "Shift completed",
                                    message=f"{operation.employee.name} · {operation.site.name} · {operation.operation_date}: {detail}.", link="timesheets")
    return sheet


def completion_summary(operation):
    book_on, book_off, flags = attendance_evidence(operation)
    if not book_off:
        return None
    try:
        sheet = operation.timesheet
    except Timesheet.DoesNotExist:
        sheet = None
    seconds = max(0, book_off.captured_at.timestamp() - book_on.captured_at.timestamp()) if book_on else None
    return {
        "site_name": operation.site.name, "work_date": str(operation.operation_date),
        "book_on_at": book_on.captured_at.isoformat() if book_on else None, "book_off_at": book_off.captured_at.isoformat(),
        "duration_minutes": int(seconds // 60) if seconds is not None else None,
        "actual_hours": round(seconds / 3600, 2) if seconds is not None else None,
        "review_flags": sheet.review_flags if sheet else flags,
        "timesheet_id": sheet.pk if sheet else None,
        "timesheet_status": "NOT_CREATED" if not sheet else "APPROVED" if sheet.approved else "REVIEW_REQUIRED" if sheet.review_flags else "DRAFT",
    }
