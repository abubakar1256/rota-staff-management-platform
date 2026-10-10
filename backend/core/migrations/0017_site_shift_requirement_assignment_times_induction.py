from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("core", "0016_seed_default_shift_types")]

    operations = [
        migrations.CreateModel(
            name="SiteShiftRequirement",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("weekday", models.PositiveSmallIntegerField(choices=[(0, "Monday"), (1, "Tuesday"), (2, "Wednesday"), (3, "Thursday"), (4, "Friday"), (5, "Saturday"), (6, "Sunday")])),
                ("required_guards", models.PositiveIntegerField(default=0)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("shift_type", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="site_requirements", to="core.shifttype")),
                ("site", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="shift_requirements", to="core.site")),
            ],
            options={"ordering": ["weekday", "shift_type__start_time"]},
        ),
        migrations.AddField(
            model_name="rotaassignment",
            name="scheduled_end",
            field=models.TimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="rotaassignment",
            name="scheduled_start",
            field=models.TimeField(blank=True, null=True),
        ),
        migrations.CreateModel(
            name="SiteInduction",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("induction_date", models.DateField()),
                ("status", models.CharField(choices=[("PLANNED", "Planned"), ("COMPLETED", "Completed"), ("CANCELLED", "Cancelled")], default="PLANNED", max_length=20)),
                ("notes", models.CharField(blank=True, max_length=250)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="created_site_inductions", to="auth.user")),
                ("employee", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="site_inductions", to="core.employee")),
                ("site", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="inductions", to="core.site")),
            ],
            options={"ordering": ["induction_date", "site__name", "employee__name"]},
        ),
        migrations.AddConstraint(
            model_name="siteshiftrequirement",
            constraint=models.UniqueConstraint(fields=("site", "shift_type", "weekday"), name="unique_site_shift_requirement_day"),
        ),
        migrations.AddConstraint(
            model_name="siteinduction",
            constraint=models.UniqueConstraint(fields=("site", "employee"), name="unique_site_employee_induction"),
        ),
    ]
