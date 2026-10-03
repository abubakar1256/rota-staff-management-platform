from django.core.management.base import BaseCommand

from core.views import create_expiry_notifications


class Command(BaseCommand):
    help = "Create daily notifications for expired or soon-to-expire employee documents."

    def handle(self, *args, **options):
        created = create_expiry_notifications(None)
        self.stdout.write(self.style.SUCCESS(f"Created {created} document expiry notification(s)."))
