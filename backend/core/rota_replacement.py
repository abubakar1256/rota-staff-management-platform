from collections import defaultdict
from copy import copy
from datetime import timedelta
from functools import lru_cache
from heapq import nsmallest

from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers

from .availability import shift_dates
from .models import DailyOperation, Employee, LeaveRecord, SiteInduction
from .rota_checks import RotaAssignmentChecks, assignment_interval
from .rota_planning import SiteInput
from .serializers import employee_compliance_issues
from .whatsapp import message_version


class ReplacementSlotInput(SiteInput):
    shift_type = serializers.IntegerField(min_value=1)
    work_date = serializers.DateField()


class ReplacementInput(serializers.Serializer):
    assignment = serializers.IntegerField(min_value=1, required=False)
    slot = ReplacementSlotInput(required=False)
    plan = serializers.CharField(min_length=64, max_length=64, required=False)

    def validate(self, attrs):
        if ("assignment" in attrs) == ("slot" in attrs):
            raise serializers.ValidationError("Choose one shift to cover.")
        return attrs


def leave_covers_assignment(leave, assignment):
    start, end = assignment_interval(assignment)
    return any(leave.start_date <= day <= leave.end_date
               for day in shift_dates(assignment.work_date, start.time(), end.time()))


def evidence_operations(queryset):
    return queryset.filter(
        Q(reached_at__isnull=False) | Q(attendance_events__isnull=False) | Q(location_state__isnull=False)
        | Q(location_updates__isnull=False)
        | Q(timesheet__isnull=False) | Q(hourly_checkin_notes__isnull=False) | Q(book_off_note__isnull=False),
    )


def replacement_plans(week, target, movable_sites):
    start, end = assignment_interval(target)
    now = timezone.now()
    if timezone.make_aware(end) <= now:
        return [], "This shift has already ended."
    operations = DailyOperation.objects.filter(
        operation_date__range=(target.work_date - timedelta(days=1), target.work_date + timedelta(days=1)),
    )
    identity = ("operation_date", "site_id", "shift_type_id", "employee_id")
    evidence = set(evidence_operations(operations).values_list(*identity))
    notes = operations.exclude(notes="", follow_up__in=["", "Replacement needed"])
    evidence.update(notes.values_list(*identity))

    def protected(row):
        return row.employee_id and (row.work_date, row.site_id, row.shift_type_id, row.employee_id) in evidence

    if protected(target):
        return [], "This shift already has attendance evidence or office notes."

    guards = list(Employee.objects.filter(
        status=Employee.Status.ACTIVE, site_inductions__site_id__in=movable_sites,
        site_inductions__status=SiteInduction.Status.COMPLETED,
    ).distinct().order_by("name", "pk").prefetch_related("documents"))
    checks = RotaAssignmentChecks(
        [guard.pk for guard in guards], movable_sites, week.week_start - timedelta(days=1),
        week.week_start + timedelta(days=7),
    )
    for employee_id, first, last in LeaveRecord.objects.filter(
        employee_id__in=[guard.pk for guard in guards], status=LeaveRecord.Status.PENDING,
        start_date__lte=week.week_start + timedelta(days=7), end_date__gte=week.week_start,
    ).values_list("employee_id", "start_date", "end_date"):
        checks.leave[employee_id].append((first, last))
    by_site = defaultdict(list)
    sites_by_guard = defaultdict(set)
    for employee_id, site_id in checks.inducted:
        sites_by_guard[employee_id].add(site_id)
    for guard in guards:
        if guard.pk != target.employee_id:
            for site in sites_by_guard[guard.pk]:
                by_site[site].append(guard)

    compliance_cache = {}

    def compliance(guard, documents):
        if guard.pk not in compliance_cache:
            compliance_cache[guard.pk] = employee_compliance_issues(guard, documents)
        return compliance_cache[guard.pk]

    def candidate(row, guard):
        replacement = copy(row)
        replacement.employee = guard
        return replacement

    def valid(row, *, exclude=None):
        return checks.problem(row, compliance, exclude_id=exclude) is None

    @lru_cache(maxsize=None)
    def guard_stats(employee_id, row_start, row_end, removed):
        hours = row_end - row_start
        rest = []
        for other in checks.assignments[employee_id]:
            if other.pk == removed:
                continue
            other_start, other_end = assignment_interval(other)
            if other.rota_week_id == week.pk:
                hours += other_end - other_start
            rest.append(max(row_start - other_end, other_start - row_end))
        return round(hours.total_seconds() / 3600, 1), (
            int(min(rest).total_seconds() // 60) if rest else None
        )

    def make_plan(kind, changes):
        rows = []
        for before, after, removed in changes:
            row_start, row_end = assignment_interval(after)
            hours, rest = guard_stats(after.employee_id, row_start, row_end, removed)
            rows.append({
                "assignment": before.pk if before is not None else None,
                "previous_guard": before.employee.name if before is not None and before.employee_id else None,
                "previous_guard_id": before.employee_id if before is not None else None,
                "guard": after.employee.name, "guard_id": after.employee_id,
                "guard_code": after.employee.employee_id,
                "site": after.site.name, "site_id": after.site_id,
                "shift": after.shift_type.name, "shift_id": after.shift_type_id,
                "start": row_start.isoformat(), "end": row_end.isoformat(),
                "weekly_hours": hours, "rest_minutes": rest,
            })
        return {"kind": kind, "rows": rows, "id": message_version(
            week.pk, week.status, kind, rows, target.pk, target.employee_id, target.notes,
            target.updated_at.isoformat() if target.pk else None,
            [(before.pk, before.updated_at.isoformat()) for before, _, _ in changes if before is not None and before.pk],
        )}, [(before, after) for before, after, _ in changes]

    target_guards = by_site[target.site_id]
    direct = [(guard, candidate(target, guard)) for guard in target_guards]
    free = {guard.pk for guard, replacement in direct if valid(replacement)}

    def moves():
        for guard, replacement in direct:
            if guard.pk in free:
                continue
            for other in checks.assignments[guard.pk]:
                if (other.rota_week_id != week.pk or other.site_id not in movable_sites
                        or not other.site.is_active or not other.shift_type.is_active or protected(other)
                        or timezone.make_aware(assignment_interval(other)[0]) <= now):
                    continue
                if not valid(replacement, exclude=other.pk):
                    continue
                for cover_guard in by_site[other.site_id]:
                    if cover_guard.pk == guard.pk:
                        continue
                    cover = candidate(other, cover_guard)
                    if valid(cover):
                        yield [(target, replacement, other.pk), (other, cover, None)]

    def splits():
        # Both parts stay in the shift's rota date. For overnight shifts, hand over before midnight.
        if target.split_cover or timezone.make_aware(start) < now:
            return
        step = timedelta(minutes=30)
        midpoint = start + (end - start) / 2
        handovers = []
        handover = start.replace(minute=30 * (start.minute // 30), second=0, microsecond=0) + step
        while handover.date() == start.date() and handover < end:
            handovers.append(handover)
            handover += step
        pairs = set()
        for handover in sorted(handovers, key=lambda value: abs(value - midpoint)):
            first_parts, second_parts = [], []
            for guard in target_guards:
                first = candidate(target, guard)
                first.scheduled_start, first.scheduled_end = start.time(), handover.time()
                if valid(first):
                    first_parts.append(first)
                second = candidate(target, guard)
                second.pk = None
                second.scheduled_start, second.scheduled_end = handover.time(), end.time()
                if valid(second):
                    second_parts.append(second)
            for first in first_parts:
                for second in second_parts:
                    pair = (first.employee_id, second.employee_id)
                    if pair[0] == pair[1] or pair in pairs:
                        continue
                    pairs.add(pair)
                    yield [(target, first, None), (None, second, None)]

    def rank(changes):
        stats = [guard_stats(after.employee_id, *assignment_interval(after), removed) for _, after, removed in changes]
        return sum(hours for hours, _ in stats), -min((rest for _, rest in stats if rest is not None), default=1440)

    direct_plans = [[(target, replacement, None)] for guard, replacement in direct if guard.pk in free]
    return [
        make_plan(kind, changes)
        for kind, group in (("direct", sorted(direct_plans, key=rank)), ("move", nsmallest(12, moves(), key=rank)),
                            ("split", nsmallest(12, splits(), key=rank)))
        for changes in group
    ], ""
