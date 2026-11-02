from django.db.models.signals import post_delete, post_save, pre_save
from django.dispatch import receiver

from .models import AuditLog, BookOffNote, DailyOperation, Employee, EmployeeDocument, HourlyCheckinNote, LeaveRecord, Notification, RotaAssignment, RotaWeek, ShiftType, Site, Timesheet
from .notification_rules import classify_notification


@receiver(pre_save, sender=Notification)
def classify_alert(sender, instance, **kwargs):
    category, priority = classify_notification(instance.title, instance.link, instance.message)
    if instance.category == "SYSTEM":
        instance.category = category
    if instance.priority == "NORMAL":
        instance.priority = priority


@receiver(pre_save, sender=EmployeeDocument)
def detect_document_evidence_change(sender, instance, **kwargs):
    fields = ("file", "file_url", "document_number", "issue_date", "expiry_date", "notes", "certificate_type", "certificate_name")
    old = sender.objects.filter(pk=instance.pk).values(*fields).first() if instance.pk else None
    instance._notify_document_review = not old or not getattr(instance.file, "_committed", True) or any(
        old[field] != (instance.file.name if field == "file" else getattr(instance, field)) for field in fields
    )


@receiver(post_save, sender=EmployeeDocument)
def notify_document_review(sender, instance, created, **kwargs):
    if instance.verification_status != "PENDING" or not getattr(instance, "_notify_document_review", False):
        return
    if not (instance.file or instance.file_url or instance.document_number or instance.notes):
        return
    from .notifications import publish_notification
    identity = [instance.pk, instance.file.name, instance.file_url, instance.document_number, str(instance.issue_date), str(instance.expiry_date), instance.notes, instance.certificate_type, instance.certificate_name]
    publish_notification(title="New document uploaded" if created else "Document updated for review",
                         message=f"{instance.employee.name}: {instance.document_type} is awaiting verification.",
                         link="documents", category="DOCUMENT_REVIEW", employee=instance.employee,
                         context={"document_id": instance.pk}, event_key=f"document-review:{identity}")


@receiver(post_save, sender=HourlyCheckinNote)
@receiver(post_save, sender=BookOffNote)
def notify_attendance_reason(sender, instance, **kwargs):
    from .notifications import publish_notification
    operation = instance.operation
    publish_notification(title="Guard attendance reason submitted", message=f"{operation.employee.name}: {instance.reason}",
                         category="ATTENDANCE", link="attendance-review", employee=operation.employee, site=operation.site,
                         event_date=operation.operation_date, context={"operation_id": operation.pk},
                         event_key=f"attendance-reason:{sender.__name__}:{instance.pk}:{instance.reason}")


TRACKED_MODELS = (Employee, Site, ShiftType, RotaWeek, RotaAssignment, LeaveRecord, EmployeeDocument, Timesheet, DailyOperation)


@receiver(pre_save, sender=EmployeeDocument)
def detect_profile_photo_change(sender, instance, **kwargs):
    old = sender.objects.filter(pk=instance.pk).values("file", "document_type", "employee_id").first() if instance.pk else None
    changed = not old or not getattr(instance.file, "_committed", True) or any((
        old["file"] != instance.file.name, old["document_type"] != instance.document_type, old["employee_id"] != instance.employee_id,
    ))
    owners = set()
    if changed:
        if instance.document_type.casefold() == "personal photograph":
            owners.add(instance.employee_id)
        if old and old["document_type"].casefold() == "personal photograph":
            owners.add(old["employee_id"])
    instance._changed_profile_photo_owners = owners


@receiver(post_save, sender=EmployeeDocument)
@receiver(post_delete, sender=EmployeeDocument)
def invalidate_photo_declaration(sender, instance, signal, **kwargs):
    if signal == post_delete:
        owners = {instance.employee_id} if instance.document_type.casefold() == "personal photograph" else set()
    else:
        owners = getattr(instance, "_changed_profile_photo_owners", set())
    if owners:
        Employee.objects.filter(pk__in=owners, profile_declaration_accepted_at__isnull=False).update(
            profile_declaration_accepted_at=None, profile_declaration_version="",
        )


def actor_for(instance):
    return getattr(instance, "created_by", None) or getattr(instance, "approved_by", None)


@receiver(post_save)
def log_save(sender, instance, created, **kwargs):
    if sender not in TRACKED_MODELS:
        return
    actor = actor_for(instance)
    label = str(instance)[:180]
    AuditLog.objects.create(user=actor, action="CREATE" if created else "UPDATE", model_name=sender.__name__, object_id=str(instance.pk), summary=f"{'Created' if created else 'Updated'} {label}")


@receiver(post_delete)
def log_delete(sender, instance, **kwargs):
    if sender not in TRACKED_MODELS:
        return
    AuditLog.objects.create(action="DELETE", model_name=sender.__name__, object_id=str(instance.pk), summary=f"Deleted {str(instance)[:180]}")
