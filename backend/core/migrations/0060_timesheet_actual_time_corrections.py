from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0059_induction_drive_upload"),
    ]

    operations = [
        migrations.AddField(
            model_name="timesheet",
            name="corrected_start_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="timesheet",
            name="corrected_end_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
