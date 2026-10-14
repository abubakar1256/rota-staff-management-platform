import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0018_siteinduction_induction_time")]

    operations = [
        migrations.AddField(
            model_name="employeedocument",
            name="verification_status",
            field=models.CharField(
                choices=[
                    ("PENDING", "Pending review"),
                    ("VERIFIED", "Verified"),
                    ("REJECTED", "Rejected"),
                ],
                default="PENDING",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="employeedocument",
            name="reviewed_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="reviewed_employee_documents",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="employeedocument",
            name="reviewed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="employeedocument",
            name="rejection_reason",
            field=models.TextField(blank=True),
        ),
    ]
