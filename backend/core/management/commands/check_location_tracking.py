from django.core.management.base import BaseCommand
from core.control_attendance import close_expired_attendance
from core.location_tracking import refresh_location_alerts


class Command(BaseCommand):
    help = "Check duty location tracking and close overdue Control Team attendance. Run every 5 minutes."

    def handle(self, *args, **options):
        closed = close_expired_attendance()
        self.stdout.write(f"Automatically checked out {closed} Control Team attendance record(s).")
        created = refresh_location_alerts()
        self.stdout.write(f"Created {created} location alert(s).")
