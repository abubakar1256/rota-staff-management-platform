from django.db import migrations, models


def copy_existing_positions_to_roles(apps, schema_editor):
    Employee = apps.get_model("core", "Employee")
    for employee in Employee.objects.all().iterator():
        parts = [part.strip() for part in (employee.position or "").replace("·", "+").replace(",", "+").split("+") if part.strip()]
        roles = []
        for value in parts:
            if value == "CCTV":
                value = "CCTV Operator"
            if value and value not in roles:
                roles.append(value)
        employee.roles = roles
        employee.save(update_fields=["roles"])


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0027_guardcomplianceregistration_approval_deadline_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="employee",
            name="roles",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.RunPython(copy_existing_positions_to_roles, migrations.RunPython.noop),
    ]
