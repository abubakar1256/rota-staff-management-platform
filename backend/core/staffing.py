"""Staffing capacity is calculated per site/shift, never from stored empty rows."""
from collections import defaultdict
from datetime import time, timedelta

from .models import SiteShiftRequirement
from .rota_checks import shift_interval


def staffed_positions(rows):
    count = 0
    groups = defaultdict(list)
    for row in rows:
        if not row.employee_id:
            continue
        if not row.split_cover:
            count += 1
            continue
        groups[row.split_cover["group"]].append(row)
    for parts in groups.values():
        first = parts[0]
        day = getattr(first, "work_date", None) or first.operation_date
        start, end = shift_interval(day, time.fromisoformat(first.split_cover["start"]),
                                    time.fromisoformat(first.split_cover["end"]))
        intervals = sorted(shift_interval(getattr(part, "work_date", None) or part.operation_date,
                                          part.scheduled_start, part.scheduled_end) for part in parts)
        for part_start, part_end in intervals:
            if part_start > start:
                break
            start = max(start, part_end)
        count += start >= end
    return count


def day_requirements(sites, shifts, selected_date):
    overrides = {(item.site_id, item.shift_type_id): item.required_guards
        for item in SiteShiftRequirement.objects.filter(site__in=sites, weekday=selected_date.weekday())}
    return {(site.pk, shift.pk): overrides.get((site.pk, shift.pk), site.required_guards)
        for site in sites for shift in shifts}


def unfilled_count(requirements, assignments):
    assigned = defaultdict(list)
    for item in assignments:
        assigned[item.site_id, item.shift_type_id].append(item)
    return sum(max(required - staffed_positions(assigned[slot]), 0) for slot, required in requirements.items())


def attendance_summary_rows(operations, sites, shifts, selected_date, serialize):
    """Retain every assigned record; show only the empty positions still required.

    Missing empty rows are represented in the response without writing to the
    database. Stored surplus placeholders remain available in operational history.
    """
    operations = list(operations)
    requirements = day_requirements(sites, shifts, selected_date)
    assigned = defaultdict(list)
    for item in operations:
        assigned[item.site_id, item.shift_type_id].append(item)
    rows = [serialize(item) for item in operations if item.employee_id]
    empty = {}
    for item in operations:
        if item.employee_id is None:
            empty.setdefault((item.site_id, item.shift_type_id), []).append(item)
    for site in sites:
        for shift in shifts:
            slot = (site.pk, shift.pk)
            missing = max(requirements[slot] - staffed_positions(assigned[slot]), 0)
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


def range_unfilled_positions(operations, sites, shifts, start_date, end_date):
    """Group vacancies by date/site/shift without treating them as guard arrivals."""
    overrides = {(item.site_id, item.shift_type_id, item.weekday): item.required_guards
        for item in SiteShiftRequirement.objects.filter(site__in=sites)}
    assigned = defaultdict(list)
    for item in operations:
        assigned[item.operation_date, item.site_id, item.shift_type_id].append(item)
    rows = []
    current = start_date
    while current <= end_date:
        for site in sites:
            for shift in shifts:
                required = overrides.get((site.pk, shift.pk, current.weekday()), site.required_guards)
                missing = max(required - staffed_positions(assigned[current, site.pk, shift.pk]), 0)
                if missing:
                    rows.append({"id": f"unfilled-{current}-{site.pk}-{shift.pk}", "date": current,
                        "site": site.pk, "site_name": site.name, "shift_name": shift.name,
                        "scheduled_start": shift.start_time, "scheduled_end": shift.end_time, "unfilled": missing})
        current += timedelta(days=1)
    return rows
