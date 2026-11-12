from datetime import datetime, time, timedelta, timezone as utc_timezone
from math import ceil
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import ControlAttendance, ControlAttendanceSettings, ControlShiftAssignment, ControlWeeklyAssignment
from .notifications import publish_control_notification


LONDON = ZoneInfo("Europe/London")
EARLY_CHECK_IN_WINDOW = timedelta(minutes=30)
AUTO_CHECKOUT_GRACE = timedelta(minutes=30)


def attendance_settings():
    return ControlAttendanceSettings.objects.filter(pk=1).first() or ControlAttendanceSettings(pk=1)


def shift_window(timing, shift_date):
    start_time = time.fromisoformat(timing["start"])
    end_time = time.fromisoformat(timing["end"])
    end_date = shift_date + timedelta(days=end_time < start_time)
    start = london_instant(shift_date, start_time)
    end = london_instant(end_date, end_time)
    return start, end


def london_instant(day, clock):
    wall = datetime.combine(day, clock)
    while True:
        instant = wall.replace(tzinfo=LONDON).astimezone(utc_timezone.utc)
        if instant.astimezone(LONDON).replace(tzinfo=None) == wall:
            return instant
        # Move nonexistent UK spring-forward times to the first valid minute.
        wall += timedelta(minutes=1)


def weekly_rules(member_id, from_date):
    return ControlWeeklyAssignment.objects.filter(member_id=member_id).filter(
        Q(ends_before__isnull=True) | Q(ends_before__gt=from_date),
    ).select_related("member")


def weekly_occurrence(rule, day):
    if day < rule.starts_on or (rule.ends_before and day >= rule.ends_before) or day.weekday() not in rule.weekdays:
        return None
    timing = {"start": rule.start_time.isoformat(), "end": rule.end_time.isoformat()}
    start, end = shift_window(timing, day)
    if start >= end:
        return None
    return ControlShiftAssignment(
        member=rule.member, shift=rule.shift, shift_date=day, scheduled_start_at=start, scheduled_end_at=end,
    )


def weekly_occurrences(rule, first, last):
    day = first
    while day <= last:
        occurrence = weekly_occurrence(rule, day)
        if occurrence is not None:
            yield occurrence
        day += timedelta(days=1)


def shift_conflicts(first, second, *, allow_identical=False):
    if first.shift_date == second.shift_date and first.shift == second.shift:
        return not allow_identical or (
            first.scheduled_start_at != second.scheduled_start_at or first.scheduled_end_at != second.scheduled_end_at
        )
    return first.scheduled_start_at < second.scheduled_end_at and second.scheduled_start_at < first.scheduled_end_at


def weekly_conflict_for_assignment(assignment):
    first = assignment.shift_date - timedelta(days=1)
    last = assignment.shift_date + timedelta(days=1)
    return next(
        (occurrence for rule in weekly_rules(assignment.member_id, first)
         for occurrence in weekly_occurrences(rule, first, last)
         if shift_conflicts(occurrence, assignment, allow_identical=True)),
        None,
    )


def weekly_schedule_conflict(rule):
    first = rule.starts_on - timedelta(days=1)
    # Two weeks cover the Sunday-to-Monday boundary and provide an ordinary week around a clock change.
    last = rule.starts_on + timedelta(days=14)
    upcoming = list(weekly_occurrences(rule, rule.starts_on, last))
    for other in weekly_rules(rule.member_id, first):
        for occurrence in weekly_occurrences(other, first, last):
            if any(shift_conflicts(occurrence, shift) for shift in upcoming):
                return occurrence
    for dated in ControlShiftAssignment.objects.filter(member_id=rule.member_id, shift_date__gte=first):
        if any(
            shift_conflicts(occurrence, dated, allow_identical=True)
            for occurrence in weekly_occurrences(rule, dated.shift_date - timedelta(days=1), dated.shift_date + timedelta(days=1))
        ):
            return dated
    return None


def assignment_status(assignment, now):
    entry = getattr(assignment, "attendance", None)
    if entry is not None:
        return "Completed" if entry.checked_out_at else "Checked in"
    if now >= assignment.scheduled_end_at:
        return "Ended"
    if now < assignment.scheduled_start_at - EARLY_CHECK_IN_WINDOW:
        return "Upcoming"
    return "Available"


@transaction.atomic
def close_expired_attendance(now=None, *, member_id=None):
    due = ControlAttendance.objects.filter(checked_out_at__isnull=True, auto_checkout_at__lte=now or timezone.now())
    if member_id is not None:
        due = due.filter(member_id=member_id)
    entries = list(due.select_related("member__user").select_for_update(of=("self",)).order_by("pk"))
    for entry in entries:
        entry.checked_out_at = entry.auto_checkout_at
        entry.auto_checked_out = True
    ControlAttendance.objects.bulk_update(entries, ["checked_out_at", "auto_checked_out"])
    for entry in entries:
        notify_control_attendance(entry, "auto_checkout")
    return len(entries)


def minutes_late(entry):
    if entry.scheduled_start_at is not None:
        return max(0, ceil((entry.checked_in_at - entry.scheduled_start_at).total_seconds() / 60))


def worked_start_at(entry):
    return max(entry.checked_in_at, entry.scheduled_start_at or entry.checked_in_at)


def notify_control_attendance(entry, event):
    late = (minutes_late(entry) or 0) if event == "check_in" else 0
    if event == "check_in":
        title, action, recorded = "Check In recorded", "checked in", entry.checked_in_at
    elif event == "auto_checkout":
        title, action, recorded = "Automatic Check Out", "were automatically checked out", entry.checked_out_at
    else:
        title, action, recorded = "Check Out recorded", "checked out", entry.checked_out_at
    if late:
        title = "Late Check In"
    warning = late or event == "auto_checkout"
    shift = f" for the {entry.get_shift_display()} shift" if entry.shift else ""
    details = f"{shift} at {recorded.astimezone(LONDON):%d %b %Y, %H:%M %Z}"
    details += f" ({late} min late)." if late else "."
    if event == "auto_checkout":
        details += " No manual Check Out was recorded."
    for office in (False, True):
        subject = entry.member.name if office else "You"
        verb = "was automatically checked out" if office and event == "auto_checkout" else action
        publish_control_notification(
            entry.member, office=office, tab="team", title=f"Control Team: {title}" if office else title,
            message=f"{subject} {verb}{details}", event_key=f"attendance:{entry.pk}:{event}",
            category="ATTENDANCE", notification_type="WARNING" if warning else "SUCCESS",
            priority="URGENT" if warning else "NORMAL",
        )
