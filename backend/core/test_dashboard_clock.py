from datetime import datetime, timezone as datetime_timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APITestCase


class DashboardClockTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_superuser(username="clock-admin", password="synthetic-test-password")
        self.client.force_authenticate(self.user)

    @override_settings(TIME_ZONE="Europe/London")
    def test_dashboard_exposes_effective_timezone_and_current_server_instant(self):
        instant = datetime(2026, 11, 4, 8, 24, 1, tzinfo=datetime_timezone.utc)
        with patch("django.utils.timezone.now", return_value=instant):
            response = self.client.get("/api/dashboard/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["time_zone"], "Europe/London")
        self.assertEqual(datetime.fromisoformat(response.data["server_time"]), instant)

    @override_settings(TIME_ZONE="Asia/Karachi")
    def test_dashboard_reports_a_deployment_override_instead_of_claiming_london(self):
        response = self.client.get("/api/dashboard/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["time_zone"], "Asia/Karachi")
