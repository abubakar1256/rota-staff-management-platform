from collections import defaultdict
from datetime import datetime, timedelta

from .availability import shift_dates, unavailable_message
from .models import Employee, GuardUnavailability, LeaveRecord, RotaAssignment, SiteInduction
from .rota_document_expiry import document_expiry_conflict


def shift_interval(day, start, end):
    start_at = datetime.combine(day, start)
    end_at = datetime.combine(day, end)
    return start_at, end_at + timedelta(days=end <= start)


class RotaAssignmentChecks:
    """Load the eligibility data once for a preview or batch of shifts."""

    def __init__(self, employee_ids, site_ids, first_day, last_day):
        self.inducted = set(SiteInduction.objects.filter(
            employee_id__in=employee_ids, site_id__in=site_ids, status=SiteInduction.Status.COMPLETED,
        ).values_list("employee_id", "site_id"))
        self.unavailable = set(GuardUnavailability.objects.filter(
            employee_id__in=employee_ids, work_date__range=(first_day, last_day + timedelta(days=1)),
        ).values_list("employee_id", "work_date"))
        self.leave = defaultdict(list)
        for employee_id, start, end in LeaveRecord.objects.filter(
            employee_id__in=employee_ids, status=LeaveRecord.Status.APPROVED,
            start_date__lte=last_day + timedelta(days=1), end_date__gte=first_day,
        ).values_list("employee_id", "start_date", "end_date"):
            self.leave[employee_id].append((start, end))
        self.assignments = defaultdict(list)
        for assignment in RotaAssignment.objects.filter(
            employee_id__in=employee_ids, work_date__range=(first_day - timedelta(days=1), last_day + timedelta(days=1)),
        ).select_related("shift_type", "site").order_by("work_date", "pk"):
            self.add(assignment)

    def add(self, assignment):
        self.assignments[assignment.employee_id].append(assignment)

    def problem(self, assignment, compliance_issues, *, exclude_id=None):
        employee, site, shift = assignment.employee, assignment.site, assignment.shift_type
        day = assignment.work_date
        start, end = assignment.scheduled_start or shift.start_time, assignment.scheduled_end or shift.end_time
        dates = shift_dates(day, start, end)
        if employee.status != Employee.Status.ACTIVE:
            return "Only active employees can be assigned to a new rota.", "invalid"
        for working_day in dates:
            if (employee.pk, working_day) in self.unavailable:
                return unavailable_message(employee.name, working_day), "guard_unavailable"
        if (employee.pk, site.pk) not in self.inducted:
            return f"{employee.name} must have a completed site induction for {site.name} before assignment.", "invalid"
        documents = list(employee.documents.all())
        if expired := document_expiry_conflict(employee, dates[-1], documents=documents):
            return expired, "critical_document_expired"
        if issues := compliance_issues(employee, documents):
            return f"{employee.name} cannot be assigned until critical documents are verified: {'; '.join(issues[:4])}.", "invalid"
        for working_day in dates:
            if any(first <= working_day <= last for first, last in self.leave[employee.pk]):
                return f"{employee.name} is on approved leave on {working_day:%d %b %Y}.", "invalid"

        start_at, end_at = shift_interval(day, start, end)
        for existing in self.assignments[employee.pk]:
            if exclude_id is not None and existing.pk == exclude_id:
                continue
            other_start = existing.scheduled_start or existing.shift_type.start_time
            other_end = existing.scheduled_end or existing.shift_type.end_time
            other_start_at, other_end_at = shift_interval(existing.work_date, other_start, other_end)
            if existing.work_date == day:
                if (existing.rota_week_id, existing.site_id, existing.shift_type_id) == (assignment.rota_week_id, site.pk, shift.pk):
                    return f"{employee.name} is already assigned to this site and shift.", "invalid"
                if shift.pk != existing.shift_type_id and (end <= start or other_end <= other_start):
                    return f"{employee.name} cannot work a day and night shift on the same date.", "invalid"
            if start_at < other_end_at and other_start_at < end_at:
                return f"{employee.name} is already assigned at {existing.site.name} during this time.", "invalid"
        return None
