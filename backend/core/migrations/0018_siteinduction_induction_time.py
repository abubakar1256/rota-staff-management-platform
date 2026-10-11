from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0017_site_shift_requirement_assignment_times_induction")]

    operations = [
        migrations.AddField(
            model_name="siteinduction",
            name="induction_time",
            field=models.TimeField(blank=True, null=True),
        ),
    ]
