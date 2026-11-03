"""Current operational exceptions; each shift/slot generates one office alert."""
from datetime import datetime, timedelta

from django.utils import timezone

from .models import DailyOperation
from .notifications import publish_notification


def refresh_operational_alerts(now=None, employee_user=None):
    now = now or timezone.now()
    today = timezone.localtime(now).date()
    operations = DailyOperation.objects.filter(operation_date__range=(today - timedelta(days=1), today)).select_related("employee__user__profile", "site", "shift_type").prefetch_related("attendance_events")
    if employee_user:
        operations = operations.filter(employee__user=employee_user)
    created = 0
    for operation in operations:
        start = operation.scheduled_start_at
        end_day = operation.operation_date + timedelta(days=int(operation.shift_type.end_time <= operation.shift_type.start_time))
        end = timezone.make_aware(datetime.combine(end_day, operation.shift_type.end_time))
        if end_day < today:
            continue
        context = {"operation_id": operation.pk}

        def alert(key, title, detail, category="ATTENDANCE", priority="URGENT", link="attendance-review", personal_only=False):
            count = 0
            if not employee_user and not personal_only:
                count += publish_notification(title=title, message=f"{operation.employee.name if operation.employee else 'Unassigned'} · {operation.site.name} · {operation.operation_date}: {detail}",
                                        notification_type="WARNING" if priority == "URGENT" else "INFO", category=category, priority=priority,
                                        employee=operation.employee, site=operation.site, event_date=operation.operation_date, context=context,
                                        link=link, event_key=f"operation:{operation.pk}:{key}")[1]
            if category == "ATTENDANCE" and operation.employee_id and operation.employee.user_id and getattr(getattr(operation.employee.user, "profile", None), "role", None) == "EMPLOYEE":
                count += publish_notification(user=operation.employee.user, title=title,
                                              message=f"{operation.site.name} · {operation.operation_date}: {detail}",
                                              category="ATTENDANCE", priority=priority, notification_type="WARNING" if priority == "URGENT" else "INFO",
                                              employee=operation.employee, site=operation.site, event_date=operation.operation_date,
                                              context=context, link="attendance", event_key=f"operation:{operation.pk}:{key}")[1]
            return count

        if not operation.employee_id:
            if start <= now <= end:
                created += alert("unfilled", "Unfilled shift", "Assign a guard to cover this shift.", "ROTA_STAFFING", link="rota")
            continue
        events = list(operation.attendance_events.all())
        book_on = next((event for event in events if event.event_type == "BOOK_ON"), None)
        book_off = next((event for event in events if event.event_type == "BOOK_OFF"), None)
        if not book_on and start - timedelta(minutes=30) <= now <= start:
            created += alert("book-on-reminder", "Book On reminder", f"Your shift starts at {timezone.localtime(start).strftime('%H:%M')}. Book On when you arrive.", priority="NORMAL", personal_only=True)
        if not book_on and start < now <= end:
            created += alert("missing-book-on", "Missed Book On", "Book On has not been received.")
        if book_on and book_on.captured_at > start:
            created += alert("late-book-on", "Late Book On", "Review the arrival time and any explanation.")
        if book_on and not book_off and now > end + timedelta(minutes=30):
            created += alert("missing-book-off", "Missed Book Off", "The Book Off window has ended without a submission.")
        elif book_on and not book_off and end <= now <= end + timedelta(minutes=30):
            created += alert("book-off-reminder", "Book Off reminder", "Your shift has ended. Complete Book Off before its window closes.", priority="NORMAL", personal_only=True)
        if book_on:
            received = {event.sequence for event in events if event.event_type == "HOURLY"}
            for sequence in range(1, operation.expected_hourly_checkins + 1):
                due = start + timedelta(hours=sequence)
                deadline = start + timedelta(hours=sequence, minutes=30)
                if deadline < now and sequence not in received and (not book_off or deadline <= book_off.captured_at):
                    created += alert(f"missing-hourly:{sequence}", "Missed hourly picture", f"Hourly picture {sequence} was not received in its window.")
                elif sequence not in received and not book_off and due <= now <= deadline:
                    created += alert(f"hourly-reminder:{sequence}", "Hourly picture reminder", f"Hourly picture {sequence} is due. Submit your live picture and location.", priority="NORMAL", personal_only=True)
        for event in events:
            if event.location_status != "VERIFIED":
                created += alert(f"location:{event.pk}", "Attendance location exception", f"Review GPS evidence for {event.get_event_type_display()}.")
    return created
