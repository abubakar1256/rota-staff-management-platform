from django.core.management.base import BaseCommand

from core.notification_alerts import refresh_operational_alerts
from core.views import create_expiry_notifications


class Command(BaseCommand):
    help = "Generate deduplicated document expiry and current shift exception notifications."

    def handle(self, *args, **options):
        created = create_expiry_notifications(None) + refresh_operational_alerts()
        self.stdout.write(self.style.SUCCESS(f"Created {created} notification(s)."))
