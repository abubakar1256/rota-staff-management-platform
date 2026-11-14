from collections import Counter, defaultdict
from datetime import timedelta
import hashlib
import json

from rest_framework import serializers

from .models import RotaAssignment, SiteShiftRequirement
from .rota_checks import RotaAssignmentChecks
from .serializers import employee_compliance_issues
from .staffing import staffed_positions


class CopyWeekInput(serializers.Serializer):
    week_start = serializers.DateField()
    site_ids = serializers.ListField(child=serializers.IntegerField(min_value=1), required=False, allow_empty=False)
    preview = serializers.BooleanField(default=False)
    preview_key = serializers.CharField(required=False, max_length=64)


class SiteInput(serializers.Serializer):
    site = serializers.IntegerField(min_value=1)


class AssignmentSlotInput(SiteInput):
    shift_type = serializers.IntegerField(min_value=1)
    scheduled_start = serializers.TimeField(required=False, allow_null=True)
    scheduled_end = serializers.TimeField(required=False, allow_null=True)


class EligibleGuardsInput(AssignmentSlotInput):
    work_date = serializers.DateField()
    include_blocked = serializers.BooleanField(default=False)


class MultiDayInput(AssignmentSlotInput):
    employee = serializers.IntegerField(min_value=1)
    dates = serializers.ListField(child=serializers.DateField(), allow_empty=False, max_length=7)
    notes = serializers.CharField(max_length=250, allow_blank=True, default="")
    cover_only = serializers.BooleanField(default=False)
    preview = serializers.BooleanField(default=False)
    preview_key = serializers.CharField(required=False, max_length=64)


def planning_preview(rows):
    return {
        "rows": rows,
        "ready": sum(row["status"] == "ready" for row in rows),
        "skipped": sum(row["status"] == "skipped" for row in rows),
        "preserved": sum(row["status"] == "preserved" for row in rows),
        "preview_key": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
    }


def plan_multi_day(week, data, employee, site, shift):
    days = sorted(set(data["dates"]))
    checks = RotaAssignmentChecks([employee.pk], [site.pk], days[0], days[-1])
    coverage = {}
    if data["cover_only"]:
        required = dict(SiteShiftRequirement.objects.filter(site=site, shift_type=shift)
                        .values_list("weekday", "required_guards"))
        assigned = defaultdict(list)
        for row in week.assignments.filter(site=site, shift_type=shift, work_date__in=days, employee__isnull=False):
            assigned[row.work_date].append(row)
        coverage = {day: required.get(day.weekday(), site.required_guards) - staffed_positions(assigned[day]) for day in days}
    rows, ready = [], []
    for day in days:
        assignment = RotaAssignment(
            rota_week=week, employee=employee, site=site, shift_type=shift, work_date=day,
            scheduled_start=data.get("scheduled_start"), scheduled_end=data.get("scheduled_end"), notes=data["notes"],
        )
        reason = "This shift is already covered." if day in coverage and coverage[day] <= 0 else ""
        if not reason and (problem := checks.problem(assignment, employee_compliance_issues)):
            reason = problem[0]
        rows.append({
            "id": day.isoformat(), "work_date": day.isoformat(),
            "site_name": site.name, "shift_name": shift.name, "employee_name": employee.name,
            "start": (assignment.scheduled_start or shift.start_time).isoformat(timespec="minutes"),
            "end": (assignment.scheduled_end or shift.end_time).isoformat(timespec="minutes"),
            "status": "skipped" if reason else "ready", "reason": reason,
        })
        if not reason:
            checks.add(assignment)
            ready.append(assignment)
    return planning_preview(rows), ready


def plan_week_copy(source_assignments, target):
    start = target.week_start
    offset = start - source_assignments[0].rota_week.week_start if source_assignments else timedelta()
    site_ids = {item.site_id for item in source_assignments}
    checks = RotaAssignmentChecks(
        {item.employee_id for item in source_assignments if item.employee_id}, site_ids, start, start + timedelta(days=6),
    )
    requirements = {
        (site, shift, weekday): count for site, shift, weekday, count in SiteShiftRequirement.objects.filter(
            site_id__in=site_ids,
        ).values_list("site_id", "shift_type_id", "weekday", "required_guards")
    }
    existing, filled = set(), defaultdict(list)
    if target.pk:
        for row in target.assignments.filter(site_id__in=site_ids, employee__isnull=False):
            slot = (row.work_date, row.site_id, row.shift_type_id)
            existing.add((*slot, row.employee_id))
            filled[slot].append(row)
    assigned = Counter({slot: staffed_positions(rows) for slot, rows in filled.items()})
    rows, ready = [], []
    for source in source_assignments:
        day, site, shift = source.work_date + offset, source.site, source.shift_type
        slot = (day, site.pk, shift.pk)
        capacity = requirements.get((site.pk, shift.pk, day.weekday()), site.required_guards)
        assignment = RotaAssignment(
            rota_week=target, work_date=day, site=site, shift_type=shift, employee=source.employee,
            scheduled_start=source.scheduled_start, scheduled_end=source.scheduled_end, notes=source.notes,
        )
        state, reason = "skipped", ""
        if not site.is_active or not shift.is_active:
            reason = "The site or shift is inactive."
        elif source.split_cover:
            reason = "Split cover is specific to the source week. Choose cover for the new week."
        elif not source.employee_id:
            reason = "Unassigned in the source week. Check Needs cover for open positions."
        elif (*slot, source.employee_id) in existing:
            state, reason = "preserved", "This guard already has an assignment in the target slot."
        elif capacity == 0:
            reason = "No guards are required for this slot."
        elif assigned[slot] >= capacity:
            state, reason = "preserved", "The target slot is already staffed."
        elif problem := checks.problem(assignment, employee_compliance_issues):
            reason = problem[0]
        else:
            state = "ready"
            ready.append(assignment)
            checks.add(assignment)
            assigned[slot] += 1
            existing.add((*slot, source.employee_id))
        rows.append({
            "id": source.pk, "work_date": day.isoformat(), "site_name": site.name, "shift_name": shift.name,
            "site": site.pk, "shift_type": shift.pk, "employee": source.employee_id, "notes": source.notes,
            "employee_name": source.employee.name if source.employee_id else "Unassigned",
            "start": (source.scheduled_start or shift.start_time).isoformat(timespec="minutes"),
            "end": (source.scheduled_end or shift.end_time).isoformat(timespec="minutes"),
            "status": state, "reason": reason,
        })
    return planning_preview(rows), ready
