from datetime import timedelta

from django.db import migrations
from django.db.models import F


def update_open_deadlines(apps, schema_editor, grace):
    attendance = apps.get_model("core", "ControlAttendance")
    attendance.objects.using(schema_editor.connection.alias).filter(
        checked_out_at__isnull=True, scheduled_end_at__isnull=False,
    ).update(auto_checkout_at=F("scheduled_end_at") + grace)


def apply_grace(apps, schema_editor):
    update_open_deadlines(apps, schema_editor, timedelta(minutes=30))


def restore_grace(apps, schema_editor):
    update_open_deadlines(apps, schema_editor, timedelta(hours=2))


class Migration(migrations.Migration):
    dependencies = [("core", "0050_control_weekly_assignments")]
    operations = [migrations.RunPython(apply_grace, restore_grace)]
