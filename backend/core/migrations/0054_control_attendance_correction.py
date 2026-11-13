from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0053_control_gps_checkout_grace")]
    operations = [
        migrations.AddField(
            model_name="controlattendance",
            name="corrected_by_admin",
            field=models.BooleanField(default=False),
        ),
    ]
