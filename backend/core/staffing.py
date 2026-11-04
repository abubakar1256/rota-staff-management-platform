"""Staffing capacity is calculated per site/shift, never from stored empty rows."""
from collections import Counter

from .models import SiteShiftRequirement


def day_requirements(sites, shifts, selected_date):
    overrides = {(item.site_id, item.shift_type_id): item.required_guards
        for item in SiteShiftRequirement.objects.filter(site__in=sites, weekday=selected_date.weekday())}
    return {(site.pk, shift.pk): overrides.get((site.pk, shift.pk), site.required_guards)
        for site in sites for shift in shifts}


def unfilled_count(requirements, assignments):
    assigned = Counter((item.site_id, item.shift_type_id) for item in assignments if item.employee_id)
    return sum(max(required - assigned[slot], 0) for slot, required in requirements.items())


def attendance_summary_rows(operations, sites, shifts, selected_date, serialize):
    """Retain every assigned record; show only the empty positions still required.

    Missing empty rows are represented in the response without writing to the
    database. Stored surplus placeholders remain available in operational history.
    """
    operations = list(operations)
    requirements = day_requirements(sites, shifts, selected_date)
    assigned = Counter((item.site_id, item.shift_type_id) for item in operations if item.employee_id)
    rows = [serialize(item) for item in operations if item.employee_id]
    empty = {}
    for item in operations:
        if item.employee_id is None:
            empty.setdefault((item.site_id, item.shift_type_id), []).append(item)
    for site in sites:
        for shift in shifts:
            slot = (site.pk, shift.pk)
            missing = max(requirements[slot] - assigned[slot], 0)
            existing = empty.get(slot, [])
            for index in range(missing):
                if index < len(existing):
                    rows.append(serialize(existing[index]))
                else:
                    rows.append({"id": f"unfilled-{selected_date}-{site.pk}-{shift.pk}-{index}",
                        "operation_date": str(selected_date), "site": site.pk, "site_name": site.name,
                        "shift_type": shift.pk, "shift_name": shift.name,
                        "scheduled_start": shift.start_time.isoformat(), "scheduled_end": shift.end_time.isoformat(),
                        "employee": None, "employee_name": "", "status": "REPLACEMENT_NEEDED",
                        "attendance_mode": site.attendance_mode, "attendance_events": [], "hourly_checkins": [],
                        "expected_hourly_checkins": 0, "attendance_status": "NOT_STARTED"})
    return rows
