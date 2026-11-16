from collections import defaultdict
from datetime import timedelta

from django.db.models import Q
from rest_framework import serializers

from .models import DailyOperation, RotaAssignment, ShiftType, SiteShiftRequirement
from .rota_checks import RotaAssignmentChecks
from .rota_planning import SiteInput, planning_preview
from .rota_replacement import evidence_operations
from .serializers import employee_compliance_issues
from .staffing import staffed_positions


class SitePlannerChange(serializers.Serializer):
    employee = serializers.IntegerField(min_value=1)
    work_date = serializers.DateField()
    revision = serializers.CharField(max_length=80, allow_null=True)
    shift_type = serializers.IntegerField(min_value=1, allow_null=True)
    scheduled_start = serializers.TimeField(required=False)
    scheduled_end = serializers.TimeField(required=False)

    def validate(self, attrs):
        if attrs["shift_type"] is not None and not {"scheduled_start", "scheduled_end"} <= attrs.keys():
            raise serializers.ValidationError("Enter a start and end time for this shift.")
        return attrs


class SitePlannerInput(SiteInput):
    changes = SitePlannerChange(many=True, allow_empty=False, max_length=3500)
    preview = serializers.BooleanField(default=True)
    preview_key = serializers.CharField(required=False, max_length=64)

    def validate(self, attrs):
        cells = {(row["employee"], row["work_date"]) for row in attrs["changes"]}
        if len(cells) != len(attrs["changes"]):
            raise serializers.ValidationError("Submit each guard and date once.")
        if not attrs["preview"] and not attrs.get("preview_key"):
            raise serializers.ValidationError("Preview the site rota before saving.")
        return attrs


def cell_revision(rows):
    return f"{rows[0].pk}:{rows[0].updated_at.isoformat()}" if len(rows) == 1 else None


def cell_lock(rows, shifts, protected):
    if len(rows) > 1:
        return "Multiple shifts are assigned. Edit them individually in Weekly rota."
    if rows:
        row = rows[0]
        if row.split_cover:
            return "Split cover. Use Find Replacement to edit it."
        if row.shift_type_id not in shifts:
            return "This shift type is inactive. Edit this assignment in Weekly rota."
        if (row.employee_id, row.work_date, row.shift_type_id) in protected:
            return "This shift has attendance evidence or office notes."
    return ""


def shift_details(row):
    if row is None:
        return None
    return {
        "shift_type": row.shift_type_id,
        "shift_name": row.shift_type.name,
        "scheduled_start": (row.scheduled_start or row.shift_type.start_time).isoformat(),
        "scheduled_end": (row.scheduled_end or row.shift_type.end_time).isoformat(),
    }


class SiteWeeklyPlan:
    def __init__(self, week, site, *, locking=False):
        self.week = week
        self.site = site
        self.days = [week.week_start + timedelta(days=index) for index in range(7)]
        self.shifts = ShiftType.objects.filter(is_active=True).in_bulk()
        assignments = week.assignments.filter(site=site, work_date__range=(self.days[0], self.days[-1]),
                                             employee__isnull=False).select_related("shift_type").order_by("pk")
        operations = DailyOperation.objects.filter(site=site, operation_date__range=(self.days[0], self.days[-1]),
                                                   employee__isnull=False).order_by("pk")
        if locking:
            assignments = assignments.select_for_update(of=("self",))
        self.assignments = list(assignments)
        self.operation_ids = defaultdict(list)
        if locking:
            for employee, day, shift, pk in operations.select_for_update().values_list(
                "employee_id", "operation_date", "shift_type_id", "pk",
            ):
                self.operation_ids[employee, day, shift].append(pk)
        self.cells = defaultdict(list)
        for row in self.assignments:
            self.cells[row.employee_id, row.work_date].append(row)

        self.protected = set(operations.filter(
            ~Q(notes="") | ~Q(follow_up__in=["", "Replacement needed"])
            | Q(pk__in=evidence_operations(operations).order_by().values("pk")),
        ).values_list("employee_id", "operation_date", "shift_type_id"))

    def snapshot(self, guards):
        return {"guards": [{
            "id": guard.pk, "name": guard.name, "employee_id": guard.employee_id,
            "shift_preference": guard.shift_preference,
            "days": {
                day.isoformat(): {
                    "shifts": [shift_details(row) for row in rows],
                    "revision": cell_revision(rows),
                    "locked_reason": cell_lock(rows, self.shifts, self.protected),
                }
                for day in self.days if (rows := self.cells.get((guard.pk, day)))
            },
        } for guard in guards]}

    def coverage(self, assignments):
        counts = defaultdict(list)
        for row in assignments:
            counts[row.work_date, row.shift_type_id].append(row)
        overrides = {(weekday, shift): required for weekday, shift, required in
                     SiteShiftRequirement.objects.filter(site=self.site).values_list("weekday", "shift_type_id", "required_guards")}
        result = []
        for day in self.days:
            for shift in self.shifts.values():
                required = overrides.get((day.weekday(), shift.pk), self.site.required_guards)
                assigned = staffed_positions(counts[day, shift.pk])
                result.append({"work_date": day.isoformat(), "shift_type": shift.pk, "shift_name": shift.name,
                               "required": required, "assigned": assigned, "unfilled": max(required - assigned, 0)})
        return result

    def preview(self, changes, guards):
        rows, pending, stale = [], [], False
        for change in sorted(changes, key=lambda item: (item["work_date"], item["employee"])):
            employee_id, day, shift_id = change["employee"], change["work_date"], change["shift_type"]
            guard = guards.get(employee_id)
            existing = self.cells.get((employee_id, day), [])
            old = existing[0] if len(existing) == 1 else None
            shift = self.shifts.get(shift_id)
            reason = cell_lock(existing, self.shifts, self.protected)
            if not guard:
                reason = "This guard is no longer active and inducted at this site."
            elif change["revision"] != cell_revision(existing):
                reason = "This cell changed after the planner was opened. Reload the site to see its latest shifts."
                stale = True
            elif shift_id is not None and not shift:
                reason = "This shift type is no longer active."
            elif (employee_id, day, shift_id) in self.protected:
                reason = "This shift has attendance evidence or office notes."

            proposed = RotaAssignment(
                rota_week=self.week, site=self.site, employee=guard, shift_type=shift, work_date=day,
                scheduled_start=change.get("scheduled_start"), scheduled_end=change.get("scheduled_end"),
            ) if shift else None
            before, after = shift_details(old), shift_details(proposed)
            row = {
                "id": f"{employee_id}:{day.isoformat()}", "employee_name": guard.name if guard else f"Guard #{employee_id}",
                "work_date": day.isoformat(), "before": before, "after": after,
                "action": "change" if old and proposed else "add" if proposed else "remove",
                "revision": change["revision"], "status": "skipped" if reason else "ready", "reason": reason,
            }
            if reason:
                rows.append(row)
            elif before != after:
                rows.append(row)
                pending.append((row, old, proposed))

        # Check the proposed week after removing cells being edited so that a guard can
        # move a shift between neighbouring days in the same atomic save.
        removed = {old.pk for _, old, _ in pending if old}
        checks = RotaAssignmentChecks(guards.keys(), [self.site.pk], self.days[0], self.days[-1])
        for guard in guards:
            checks.assignments[guard] = [row for row in checks.assignments[guard] if row.pk not in removed]
        for row, _, proposed in pending:
            if proposed is None:
                continue
            if problem := checks.problem(proposed, employee_compliance_issues):
                row.update(status="skipped", reason=problem[0])
            else:
                checks.add(proposed)

        projected = self.assignments
        if not any(row["status"] == "skipped" for row in rows):
            projected = [row for row in self.assignments if row.pk not in removed]
            projected.extend(proposed for _, _, proposed in pending if proposed is not None)
        coverage = self.coverage(projected)
        # Bind saving to the reviewed coverage as well as the exact cell revisions.
        result = planning_preview(rows, context={"site": self.site.pk, "coverage": coverage})
        result.update(coverage=coverage, stale=stale)
        return result, [(old, proposed) for _, old, proposed in pending]

    def save(self, changes, user):
        slots_by_day = defaultdict(set)
        obsolete = []
        for old, proposed in changes:
            if old and (proposed is None or old.shift_type_id != proposed.shift_type_id):
                obsolete.extend(self.operation_ids[old.employee_id, old.work_date, old.shift_type_id])
                slots_by_day[old.work_date].add((old.site_id, old.shift_type_id))
            if proposed is None:
                old.delete()
                continue
            slots_by_day[proposed.work_date].add((proposed.site_id, proposed.shift_type_id))
            if old:
                old.shift_type = proposed.shift_type
                old.scheduled_start, old.scheduled_end = proposed.scheduled_start, proposed.scheduled_end
                old.save(update_fields=["shift_type", "scheduled_start", "scheduled_end", "updated_at"])
            else:
                proposed.created_by = user
                proposed.save(force_insert=True)
        if obsolete:
            DailyOperation.objects.filter(pk__in=obsolete).delete()
        return slots_by_day
