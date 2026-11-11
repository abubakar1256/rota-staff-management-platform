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


def shift_window(timing, now):
    start_time = time.fromisoformat(timing["start"])
    end_time = time.fromisoformat(timing["end"])
    local_today = now.astimezone(LONDON).date()
    starts_on = ends_on = local_today
    if end_time < start_time:
        end_today = datetime.combine(local_today, end_time, LONDON).astimezone(utc_timezone.utc)
        if now < end_today:
            starts_on -= timedelta(days=1)
        else:
            ends_on += timedelta(days=1)
    start = datetime.combine(starts_on, start_time, LONDON).astimezone(utc_timezone.utc)
    end = datetime.combine(ends_on, end_time, LONDON).astimezone(utc_timezone.utc)
    return start, end


def close_expired_attendance(now=None, *, member_id=None):
    due = ControlAttendance.objects.filter(checked_out_at__isnull=True, auto_checkout_at__lte=now or timezone.now())
    if member_id is not None:
        due = due.filter(member_id=member_id)
    return due.update(checked_out_at=F("auto_checkout_at"), auto_checked_out=True)


def minutes_late(entry):
    if entry.scheduled_start_at is not None:
        return max(0, ceil((entry.checked_in_at - entry.scheduled_start_at).total_seconds() / 60))
