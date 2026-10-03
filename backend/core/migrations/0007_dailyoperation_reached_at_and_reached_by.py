from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0006_employee_unique_employee_name_ci"),
    ]

    operations = [
        migrations.AddField(
            model_name="dailyoperation",
            name="reached_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="dailyoperation",
            name="reached_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.SET_NULL,
                related_name="verified_daily_operations",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
