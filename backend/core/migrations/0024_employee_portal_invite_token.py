from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0023_employee_on_hold_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="employeeportalinvite",
            name="token",
            field=models.CharField(blank=True, max_length=128),
        ),
    ]
