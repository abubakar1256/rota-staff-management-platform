from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0007_dailyoperation_reached_at_and_reached_by"),
    ]

    operations = [
        migrations.CreateModel(
            name="DailyArrivalReport",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("report_date", models.DateField()),
                ("pdf_file", models.FileField(upload_to="arrival-reports/%Y/%m/")),
                ("scheduled_count", models.PositiveIntegerField(default=0)),
                ("reached_count", models.PositiveIntegerField(default=0)),
                ("late_count", models.PositiveIntegerField(default=0)),
                ("not_reached_count", models.PositiveIntegerField(default=0)),
                ("unassigned_count", models.PositiveIntegerField(default=0)),
                ("generated_at", models.DateTimeField(auto_now=True)),
                ("generated_by", models.ForeignKey(blank=True, null=True, on_delete=models.SET_NULL, related_name="generated_arrival_reports", to=settings.AUTH_USER_MODEL)),
                ("shift_type", models.ForeignKey(on_delete=models.PROTECT, related_name="arrival_reports", to="core.shifttype")),
            ],
            options={
                "ordering": ["-report_date", "shift_type__start_time"],
            },
        ),
        migrations.AddConstraint(
            model_name="dailyarrivalreport",
            constraint=models.UniqueConstraint(fields=("report_date", "shift_type"), name="unique_daily_arrival_report_shift"),
        ),
    ]
