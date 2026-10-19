from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0021_bookoffnote")]

    operations = [
        migrations.AddField(
            model_name="employee",
            name="date_of_birth",
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="employee",
            name="nationality",
            field=models.CharField(blank=True, max_length=80),
        ),
    ]
