from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("core", "0029_googledriveconnection_employee_document_drive"),
    ]

    operations = [
        migrations.CreateModel(
            name="PasswordResetOTP",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("email", models.EmailField(max_length=254)),
                ("code_hash", models.CharField(max_length=256)),
                ("reset_token_hash", models.CharField(blank=True, max_length=64)),
                ("attempts", models.PositiveSmallIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("expires_at", models.DateTimeField()),
                ("verified_at", models.DateTimeField(blank=True, null=True)),
                ("used_at", models.DateTimeField(blank=True, null=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="password_reset_otps", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(fields=["user", "created_at"], name="core_passwo_user_id_ac9481_idx"),
                    models.Index(fields=["reset_token_hash"], name="core_passwo_reset_t_43eefb_idx"),
                ],
            },
        ),
    ]
