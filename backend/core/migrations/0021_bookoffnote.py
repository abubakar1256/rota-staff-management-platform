import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0020_hourlycheckinnote")]

    operations = [
        migrations.CreateModel(
            name="BookOffNote",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("reason", models.TextField(max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="created_book_off_notes", to=settings.AUTH_USER_MODEL)),
                ("operation", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="book_off_note", to="core.dailyoperation")),
            ],
        ),
    ]
