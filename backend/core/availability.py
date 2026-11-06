from datetime import time, timedelta

from .models import GuardUnavailability


def shift_dates(work_date, start, end):
    """Calendar dates on which the guard is scheduled to work."""
    if end <= start and end != time.min:
        return work_date, work_date + timedelta(days=1)
    return (work_date,)


def unavailable_message(employee_name, work_date):
    return f"{employee_name} is unavailable on {work_date:%d %b %Y}."


def unavailable_for_shift(employee_id, work_date, start, end):
    return (
        GuardUnavailability.objects.filter(employee_id=employee_id, work_date__in=shift_dates(work_date, start, end))
        .order_by("work_date")
        .values_list("work_date", flat=True)
        .first()
    )


def assignment_availability_conflicts(assignments, offset=timedelta()):
    scheduled = [
        (assignment, shift_dates(
            assignment.work_date + offset,
            assignment.scheduled_start or assignment.shift_type.start_time,
            assignment.scheduled_end or assignment.shift_type.end_time,
        ))
        for assignment in assignments if assignment.employee_id
    ]
    marked = set(GuardUnavailability.objects.filter(
        employee_id__in={assignment.employee_id for assignment, _ in scheduled},
        work_date__in={day for _, days in scheduled for day in days},
    ).values_list("employee_id", "work_date"))
    return list(dict.fromkeys(
        unavailable_message(assignment.employee.name, day)
        for assignment, days in scheduled
        for day in days if (assignment.employee_id, day) in marked
    ))
