from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0051_control_checkout_grace")]
    operations = [
        migrations.AddField(
            model_name="controlattendance",
            name="last_verified_at",
            field=models.DateTimeField(null=True, blank=True),
        ),
        migrations.AddField(
            model_name="controlattendance",
            name="geofence_checked_out",
            field=models.BooleanField(default=False),
        ),
    ]
