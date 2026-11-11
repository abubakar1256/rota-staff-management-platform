from datetime import datetime, time, timedelta, timezone as utc_timezone
from math import ceil
from zoneinfo import ZoneInfo

from django.db.models import F
from django.utils import timezone

from .models import ControlAttendance, ControlAttendanceSettings


LONDON = ZoneInfo("Europe/London")
AUTO_CHECKOUT_GRACE = timedelta(hours=2)


def attendance_settings():
    return ControlAttendanceSettings.objects.filter(pk=1).first() or ControlAttendanceSettings(pk=1)


def shift_window(timing, shift_date):
    start_time = time.fromisoformat(timing["start"])
    end_time = time.fromisoformat(timing["end"])
    end_date = shift_date + timedelta(days=end_time < start_time)
    start = datetime.combine(shift_date, start_time, LONDON).astimezone(utc_timezone.utc)
    end = datetime.combine(end_date, end_time, LONDON).astimezone(utc_timezone.utc)
    return start, end


def assignment_status(assignment, now):
    entry = getattr(assignment, "attendance", None)
    if entry is not None:
        return "Completed" if entry.checked_out_at else "Checked in"
    if now >= assignment.scheduled_end_at:
        return "Ended"
    if assignment.shift_date > now.astimezone(LONDON).date():
        return "Upcoming"
    return "Available"


def close_expired_attendance(now=None, *, member_id=None):
    due = ControlAttendance.objects.filter(checked_out_at__isnull=True, auto_checkout_at__lte=now or timezone.now())
    if member_id is not None:
        due = due.filter(member_id=member_id)
    return due.update(checked_out_at=F("auto_checkout_at"), auto_checked_out=True)


def minutes_late(entry):
    if entry.scheduled_start_at is not None:
        return max(0, ceil((entry.checked_in_at - entry.scheduled_start_at).total_seconds() / 60))
