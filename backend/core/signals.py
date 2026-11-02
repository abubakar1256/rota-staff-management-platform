from django.db.models.signals import post_delete, post_save, pre_save
from django.dispatch import receiver

from .models import AuditLog, DailyOperation, Employee, EmployeeDocument, LeaveRecord, RotaAssignment, RotaWeek, ShiftType, Site, Timesheet


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
