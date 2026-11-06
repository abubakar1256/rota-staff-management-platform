from datetime import timedelta

from django.db.models import prefetch_related_objects
from django.utils import timezone

from .availability import shift_dates


CRITICAL_EXPIRY_TYPES = {
    "sia", "sia card", "sia licence", "sia license", "security licence", "security license",
    "sia card (front)", "sia card (back)", "sia card (front & back)",
    "passport", "passport (first 2 pages)", "right to work", "right-to-work", "share code",
}


def document_expiry_conflict(employee, through_date, *, documents=None):
    today = timezone.localdate()
    required_through = max(today, through_date)
    if documents is None:
        documents = employee.documents.all()

    issues = []
    for document in documents:
        expiry = document.expiry_date
        if document.document_type.strip().casefold() not in CRITICAL_EXPIRY_TYPES or not expiry or expiry >= required_through:
            continue
        if expiry < today:
            issues.append(f"{document.document_type} expired on {expiry:%d %b %Y}")
        else:
            issues.append(
                f"{document.document_type} expires on {expiry:%d %b %Y} before scheduled work on {required_through:%d %b %Y}"
            )
    if issues:
        return f"{employee.name}: {'; '.join(dict.fromkeys(issues))}."
    return ""


def assignment_document_expiry_conflicts(assignments, offset=timedelta()):
    latest_shift = {}
    for assignment in assignments:
        if not assignment.employee_id:
            continue
        through_date = shift_dates(
            assignment.work_date + offset,
            assignment.scheduled_start or assignment.shift_type.start_time,
            assignment.scheduled_end or assignment.shift_type.end_time,
        )[-1]
        previous = latest_shift.get(assignment.employee_id)
        if previous is None or through_date > previous[1]:
            latest_shift[assignment.employee_id] = (assignment.employee, through_date)

    prefetch_related_objects([employee for employee, _ in latest_shift.values()], "documents")
    return [
        conflict for employee, through_date in latest_shift.values()
        if (conflict := document_expiry_conflict(employee, through_date))
    ]
