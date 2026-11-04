"""A scheduled arrival belongs to an assigned guard, not an empty staffing row."""
from django.utils import timezone

from .staffing import range_unfilled_positions


def arrival_snapshot(operation, now=None):
    if not operation.employee_id:
        return "NOT_ASSIGNED", None
    if operation.reached_at:
        delay = max(0, round((operation.reached_at.timestamp() - operation.scheduled_start_at.timestamp()) / 60))
        return ("LATE" if delay else "REACHED"), delay
    return ("UPCOMING" if (now or timezone.now()) < operation.scheduled_start_at else "NOT_REACHED"), None


def arrival_report(operations, sites, shifts, start_date, end_date):
    operations = list(operations)
    counts = {"scheduled": 0, "reached": 0, "late": 0, "not_reached": 0, "upcoming": 0, "not_assigned": 0}
    rows = []
    now = timezone.now()
    for operation in operations:
        if not operation.employee_id:
            continue
        counts["scheduled"] += 1
        status, delay = arrival_snapshot(operation, now)
        counts[{"LATE": "late", "REACHED": "reached", "UPCOMING": "upcoming", "NOT_REACHED": "not_reached"}[status]] += 1
        rows.append({"id": operation.pk, "date": operation.operation_date,
            "employee": operation.employee_id, "employee_id": operation.employee.employee_id,
            "employee_name": operation.employee.name, "site": operation.site_id, "site_name": operation.site.name,
            "shift_name": operation.shift_type.name, "scheduled_start": operation.shift_type.start_time,
            "reached_at": operation.reached_at,
            "reached_by_name": operation.reached_by.get_full_name() or operation.reached_by.get_username() if operation.reached_by else None,
            "delay_minutes": delay, "status": operation.status, "arrival_status": status})
    unfilled = range_unfilled_positions(operations, sites, shifts, start_date, end_date)
    counts["not_assigned"] = sum(row["unfilled"] for row in unfilled)
    return {"arrival_summary": counts, "arrival_rows": rows, "arrival_unfilled": unfilled}
