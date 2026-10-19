from django.db import migrations, models


def move_legacy_leave_statuses(apps, schema_editor):
    Employee = apps.get_model("core", "Employee")
    Employee.objects.filter(status="ON_LEAVE").update(status="ON_HOLD")


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0022_employee_profile_fields"),
    ]

    operations = [
        migrations.RunPython(move_legacy_leave_statuses, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="employee",
            name="status",
            field=models.CharField(
                choices=[
                    ("ACTIVE", "Active"),
                    ("INACTIVE", "Inactive"),
                    ("ON_HOLD", "On hold"),
                ],
                default="ACTIVE",
                max_length=20,
            ),
        ),
    ]
