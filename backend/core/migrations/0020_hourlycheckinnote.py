import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0019_employeedocument_verification")]

    operations = [
        migrations.CreateModel(
            name="HourlyCheckinNote",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("sequence", models.PositiveIntegerField()),
                ("reason", models.TextField(max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="created_hourly_checkin_notes", to=settings.AUTH_USER_MODEL)),
                ("operation", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="hourly_checkin_notes", to="core.dailyoperation")),
            ],
            options={"ordering": ["sequence"]},
        ),
        migrations.AddConstraint(
            model_name="hourlycheckinnote",
            constraint=models.UniqueConstraint(fields=("operation", "sequence"), name="unique_hourly_checkin_note"),
        ),
    ]
