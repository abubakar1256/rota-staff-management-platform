from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.utils import timezone

from core.models import DailyOperation, Employee, EmployeeDocument, ShiftType, Site, Timesheet, UserProfile


class Command(BaseCommand):
    help = "Create a local demo admin, employees, and site."

    def handle(self, *args, **options):
        User = get_user_model()
        user, created = User.objects.get_or_create(username="admin@rota.local", defaults={"email": "admin@rota.local", "first_name": "System", "last_name": "Admin", "is_staff": True})
        user.set_password("Admin123!")
        user.is_staff = True
        user.is_active = True
        user.save()
        UserProfile.objects.update_or_create(user=user, defaults={"role": UserProfile.Role.ADMIN})

        ahmed, _ = Employee.objects.get_or_create(employee_id="EMP-001", defaults={"name": "Ahmed Khan", "position": "Security Guard", "phone": "+92 300 0000001"})
        sara, _ = Employee.objects.get_or_create(employee_id="EMP-002", defaults={"name": "Sara Malik", "position": "Site Supervisor", "phone": "+92 300 0000002"})
        site, _ = Site.objects.get_or_create(site_id="SITE-001", defaults={"name": "Head Office", "address": "Main Boulevard", "required_guards": 2})
        day_shift, _ = ShiftType.objects.get_or_create(name="Day Shift", defaults={"start_time": "07:00", "end_time": "19:00"})
        ShiftType.objects.get_or_create(name="Night Shift", defaults={"start_time": "19:00", "end_time": "07:00"})
        EmployeeDocument.objects.get_or_create(employee=ahmed, document_type="Security Licence", defaults={"document_number": "LIC-001", "issue_date": timezone.localdate() - timedelta(days=180), "expiry_date": timezone.localdate() + timedelta(days=20), "created_by": user})
        Timesheet.objects.get_or_create(employee=ahmed, site=site, work_date=timezone.localdate() - timedelta(days=1), defaults={"scheduled_start": "07:00", "scheduled_end": "19:00", "actual_start": "07:05", "actual_end": "19:10", "overtime_minutes": 10, "approved": True, "created_by": user})
        DailyOperation.objects.get_or_create(operation_date=timezone.localdate(), site=site, shift_type=day_shift, employee=ahmed, defaults={"status": DailyOperation.Status.UNCONFIRMED, "notes": "Confirm arrival at site.", "created_by": user})

        self.stdout.write(self.style.SUCCESS("Demo data is ready. Login: admin@rota.local / Admin123!"))
