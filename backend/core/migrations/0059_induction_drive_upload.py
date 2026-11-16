from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0058_registration_drive_upload"),
    ]

    operations = [
        migrations.AddField(
            model_name="siteinduction",
            name="drive_file_id",
            field=models.CharField(blank=True, max_length=160),
        ),
        migrations.AddField(
            model_name="siteinduction",
            name="drive_root_folder_id",
            field=models.CharField(blank=True, max_length=160),
        ),
        migrations.AddField(
            model_name="siteinduction",
            name="drive_synced_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
