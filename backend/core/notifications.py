import hashlib
import json

from .models import Notification
from .notification_rules import classify_notification


def publish_notification(*, user=None, title, message, link="", notification_type="INFO", category=None,
                         priority=None, employee=None, site=None, event_date=None, context=None, event_key=None):
    inferred_category, inferred_priority = classify_notification(title, link, message)
    metadata = dict(context or {})
    if employee:
        metadata.update(employee_record_id=employee.pk, employee_id=employee.employee_id, employee_name=employee.name)
    if site:
        metadata.update(site_id=site.pk, site_name=site.name)
    if event_date:
        metadata["event_date"] = str(event_date)
    values = dict(user=user, title=title, message=message, link=link, notification_type=notification_type,
                  category=category or inferred_category, priority=priority or inferred_priority, context=metadata)
    identity = event_key or json.dumps([title, message, link, metadata], sort_keys=True, default=str)
    key = hashlib.sha256(f"{getattr(user, 'pk', None)}:{identity}".encode()).hexdigest()
    return Notification.objects.get_or_create(dedupe_key=key, defaults=values)


def publish_control_notification(member, *, office=False, tab, title, message, event_key,
                                 category, notification_type="INFO", priority="NORMAL"):
    return publish_notification(
        user=None if office else member.user, link="control-team", title=title, message=message,
        context={"control_tab": tab, "control_member_id": member.pk},
        event_key=f"control:{event_key}", category=category, notification_type=notification_type, priority=priority,
    )
