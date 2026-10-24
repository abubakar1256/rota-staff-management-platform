from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0028_employee_roles"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="GoogleDriveConnection",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("connection_key", models.CharField(default="default", max_length=40, unique=True)),
                ("authorized_email", models.EmailField(blank=True, max_length=254)),
                ("encrypted_refresh_token", models.TextField()),
                ("scopes", models.JSONField(blank=True, default=list)),
                ("root_folder_id", models.CharField(blank=True, max_length=160)),
                ("connected_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("connected_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="google_drive_connections", to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddField(model_name="employeedocument", name="drive_file_id", field=models.CharField(blank=True, max_length=160)),
        migrations.AddField(model_name="employeedocument", name="drive_folder_id", field=models.CharField(blank=True, max_length=160)),
        migrations.AddField(model_name="employeedocument", name="drive_synced_at", field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name="employeedocument", name="drive_sync_error", field=models.TextField(blank=True)),
    ]
