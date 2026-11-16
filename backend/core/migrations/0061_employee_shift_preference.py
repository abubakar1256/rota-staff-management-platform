from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0060_timesheet_actual_time_corrections")]

    operations = [
        migrations.AddField(
            model_name="employee",
            name="shift_preference",
            field=models.CharField(
                blank=True, max_length=6,
                choices=[("DAY", "Day"), ("NIGHT", "Night"), ("BOTH", "Day + Night"), ("CUSTOM", "Customize")],
            ),
        ),
    ]
