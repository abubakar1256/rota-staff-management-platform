from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0057_rota_replacement_cover"),
    ]

    operations = [
        migrations.AddField(
            model_name="guardcomplianceregistration",
            name="drive_file_id",
            field=models.CharField(blank=True, max_length=160),
        ),
        migrations.AddField(
            model_name="guardcomplianceregistration",
            name="drive_root_folder_id",
            field=models.CharField(blank=True, max_length=160),
        ),
        migrations.AddField(
            model_name="guardcomplianceregistration",
            name="drive_synced_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
