from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from .models import AuditLog, DailyOperation, Employee, EmployeeDocument, LeaveRecord, RotaAssignment, RotaWeek, ShiftType, Site, Timesheet


TRACKED_MODELS = (Employee, Site, ShiftType, RotaWeek, RotaAssignment, LeaveRecord, EmployeeDocument, Timesheet, DailyOperation)


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
