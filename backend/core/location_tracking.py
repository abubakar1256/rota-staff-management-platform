"""Duty-only location evidence. Missing evidence never proves a guard disabled GPS."""
import math
from datetime import timedelta, timezone as datetime_timezone

from django.conf import settings
from django.db import transaction
from django.db.models import Exists, OuterRef
from django.utils import timezone

from .models import DailyOperation, DutyLocationState, DutyLocationUpdate, Notification, ShiftAttendanceEvent
from .notifications import publish_notification

INTERVAL = timedelta(minutes=30)
GRACE = timedelta(minutes=5)
STATUS_LABELS = {"UPDATED": "Updated", "PERMISSION_DENIED": "Permission denied", "UNAVAILABLE": "Location unavailable",
                 "TIMEOUT": "Location timed out", "OVERDUE": "Location update overdue", "WAITING": "Awaiting location",
                 "NOT_BOOKED_ON": "Awaiting Book On", "STOPPED": "Tracking ended", "DISABLED": "Tracking disabled"}


def operation_end(operation):
    return operation.scheduled_end_at


def live_operations(now=None, *, tracking_only=True):
    now = now or timezone.now()
    today = timezone.localtime(now).date()
    events = ShiftAttendanceEvent.objects.filter(operation_id=OuterRef("pk"))
    query = (DailyOperation.objects.filter(operation_date__range=(today - timedelta(days=1), today),
            site__is_active=True, employee__status="ACTIVE",
            employee__user__is_active=True, employee__user__profile__role="EMPLOYEE")
            .annotate(has_on=Exists(events.filter(event_type="BOOK_ON")), has_off=Exists(events.filter(event_type="BOOK_OFF")))
            .filter(has_on=True, has_off=False).select_related("site", "shift_type", "employee__user")
            .prefetch_related("attendance_events"))
    return query.filter(site__location_tracking_enabled=True) if tracking_only else query


def tracking_info(operation, now=None):
    now = now or timezone.now()
    events = list(operation.attendance_events.all())
    on = next((event for event in events if event.event_type == "BOOK_ON"), None)
    off = next((event for event in events if event.event_type == "BOOK_OFF"), None)
    end = operation_end(operation)
    enabled = operation.site.location_tracking_enabled and operation.site.is_active
    eligible = bool(operation.employee_id and operation.employee.status == "ACTIVE" and operation.employee.user_id
                    and operation.employee.user.is_active and getattr(getattr(operation.employee.user, "profile", None), "role", None) == "EMPLOYEE")
    started = max(on.captured_at, operation.site.location_tracking_enabled_at or on.captured_at) if on else None
    # Stop at the scheduled end even if the guard forgets Book Off.
    active = bool(enabled and eligible and on and not off and operation.operation_date <= timezone.localtime(now).date() and started <= now < end)
    return {"enabled": enabled, "active": active, "started": started, "end": end, "on": on, "off": off}


def ensure_state(operation, info):
    if not info["started"]:
        return None
    state, created = DutyLocationState.objects.get_or_create(operation=operation, defaults={"tracking_started_at": info["started"]})
    if state.tracking_started_at < info["started"]:
        close_incident(state, "Tracking restarted")
        state.tracking_started_at = info["started"]
        state.last_status = "WAITING"
        state.save()
    on = info["on"]
    if created and on.captured_at >= state.tracking_started_at and valid_coordinates(on.latitude, on.longitude, on.accuracy_m):
        state.latitude, state.longitude, state.accuracy_m = on.latitude, on.longitude, on.accuracy_m
        state.last_location_at = state.last_contact_at = on.captured_at
        state.last_status = "UPDATED"
        state.save()
        DutyLocationUpdate.objects.create(operation=operation, status="UPDATED", latitude=on.latitude, longitude=on.longitude,
            accuracy_m=on.accuracy_m, captured_at=on.captured_at, received_at=on.captured_at, source="BOOK_ON", created_by=on.created_by)
    return state


def valid_coordinates(latitude, longitude, accuracy):
    return (isinstance(latitude, (int, float)) and math.isfinite(latitude) and -90 <= latitude <= 90
            and isinstance(longitude, (int, float)) and math.isfinite(longitude) and -180 <= longitude <= 180
            and isinstance(accuracy, (int, float)) and math.isfinite(accuracy) and accuracy >= 0)


def next_due(state):
    # Add elapsed seconds in UTC so DST does not stretch a 30-minute interval.
    baseline = max(state.tracking_started_at, state.last_location_at or state.tracking_started_at)
    return baseline.astimezone(datetime_timezone.utc) + INTERVAL


def next_capture_due(state):
    # A new tracking session needs a first fix immediately. The overdue grace
    # period still runs from the session start, not from this capture deadline.
    if (not state.last_location_at or state.last_location_at < state.tracking_started_at
            or not valid_coordinates(state.latitude, state.longitude, state.accuracy_m)):
        return state.tracking_started_at
    return next_due(state)


def incident_key(state):
    return f"duty-location:{state.operation_id}:{state.tracking_started_at.isoformat()}:{state.incident_sequence}"


def close_incident(state, reason="Location restored"):
    if not state.incident_open:
        return
    # Keep the alert in history, but remove its urgent/unread state after recovery/end.
    for notice in Notification.objects.filter(category="ATTENDANCE", context__location_incident=incident_key(state)):
        notice.context = {**notice.context, "resolved_at": timezone.now().isoformat(), "resolution": reason}
        notice.is_read = True
        notice.priority = "NORMAL"
        notice.save(update_fields=["context", "is_read", "priority"])
    state.incident_open = False
    state.incident_status = ""
    state.save(update_fields=["incident_open", "incident_status"])


def open_incident(operation, state, status):
    if state.incident_open:
        return 0
    state.incident_open = True
    state.incident_sequence += 1
    state.incident_status = status
    state.save(update_fields=["incident_open", "incident_sequence", "incident_status"])
    return publish_notification(title=STATUS_LABELS[status],
        message=f"{operation.employee.name} · {operation.site.name}: {STATUS_LABELS[status]}. Check the last location and contact the guard if needed.",
        link="attendance-review", category="ATTENDANCE", priority="URGENT", notification_type="WARNING",
        employee=operation.employee, site=operation.site, event_date=operation.operation_date,
        context={"operation_id": operation.pk, "location_tracking": True, "location_incident": incident_key(state)}, event_key=incident_key(state))[1]


def snapshot(operation, state=None, now=None):
    now = now or timezone.now()
    info = tracking_info(operation, now)
    state = state or getattr(operation, "location_state", None)
    overdue = bool(info["active"] and state and now >= next_due(state) + GRACE)
    if not info["enabled"]:
        status = "DISABLED"
    elif not info["on"]:
        status = "NOT_BOOKED_ON"
    elif not info["active"]:
        status = "STOPPED"
    elif state and state.last_status in {"PERMISSION_DENIED", "UNAVAILABLE", "TIMEOUT"}:
        status = state.last_status
    elif overdue:
        status = "OVERDUE"
    else:
        status = state.last_status if state else "WAITING"
    return {"operation_id": operation.pk, "employee_id": operation.employee_id, "employee_name": operation.employee.name if operation.employee else "Unassigned",
        "site_id": operation.site_id, "site_name": operation.site.name, "shift_name": operation.shift_type.name, "operation_date": str(operation.operation_date),
        "tracking_enabled": info["enabled"], "tracking_active": info["active"], "status": status, "status_label": STATUS_LABELS[status], "overdue": overdue,
        "last_contact_at": state.last_contact_at.isoformat() if state and state.last_contact_at else None,
        "last_location_at": state.last_location_at.isoformat() if state and state.last_location_at else None,
        "point": {"latitude": state.latitude, "longitude": state.longitude, "accuracy_m": state.accuracy_m} if state and state.latitude is not None else None,
        "next_due_at": next_capture_due(state).isoformat() if state and info["active"] else None,
        "stop_at": info["end"].isoformat(), "interval_seconds": int(INTERVAL.total_seconds()), "grace_seconds": int(GRACE.total_seconds())}


@transaction.atomic
def check_operation(operation_id, now=None):
    now = now or timezone.now()
    operation = DailyOperation.objects.select_for_update(of=("self",)).select_related("site", "shift_type", "employee__user__profile").get(pk=operation_id)
    info = tracking_info(operation, now)
    state = ensure_state(operation, info) if info["active"] else DutyLocationState.objects.filter(operation=operation).first()
    if not info["active"]:
        if state:
            close_incident(state, "Tracking ended")
        return 0
    if now >= next_due(state) + GRACE:
        return open_incident(operation, state, "OVERDUE")
    return 0


def refresh_location_alerts(now=None):
    now = now or timezone.now()
    # Also close old open incidents after Book Off, site disablement or shift end.
    ids = set(live_operations(now).values_list("pk", flat=True))
    ids.update(DutyLocationState.objects.filter(incident_open=True).values_list("operation_id", flat=True))
    created = 0
    for pk in ids:
        try:
            created += check_operation(pk, now)
        except DailyOperation.DoesNotExist:
            continue  # An office cancellation can race the candidate query.
    return created


def protect_tracked_assignment(assignment):
    from rest_framework.exceptions import ValidationError
    if DutyLocationState.objects.filter(operation__operation_date=assignment.work_date, operation__site_id=assignment.site_id,
            operation__shift_type_id=assignment.shift_type_id, operation__employee_id=assignment.employee_id).exists():
        raise ValidationError("This assignment has duty location evidence. Its guard, site, date and shift must be retained.")
