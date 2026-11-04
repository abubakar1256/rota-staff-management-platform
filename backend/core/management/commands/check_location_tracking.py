from django.core.management.base import BaseCommand
from core.location_tracking import refresh_location_alerts


class Command(BaseCommand):
    help = "Check enabled duty tracking for overdue location updates and close ended incidents. Run every 5 minutes."

    def handle(self, *args, **options):
        created = refresh_location_alerts()
        self.stdout.write(f"Created {created} location alert(s).")
