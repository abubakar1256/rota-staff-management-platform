from django.db import migrations


def seed_default_shift_types(apps, schema_editor):
    ShiftType = apps.get_model("core", "ShiftType")
    ShiftType.objects.update_or_create(
        name="Day Shift",
        defaults={"start_time": "07:00", "end_time": "19:00", "is_active": True},
    )
    ShiftType.objects.update_or_create(
        name="Night Shift",
        defaults={"start_time": "19:00", "end_time": "07:00", "is_active": True},
    )


class Migration(migrations.Migration):
    dependencies = [("core", "0015_client_alter_userprofile_role_site_client_and_more")]

    operations = [migrations.RunPython(seed_default_shift_types, migrations.RunPython.noop)]
