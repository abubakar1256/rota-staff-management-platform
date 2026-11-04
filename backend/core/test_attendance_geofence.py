from unittest.mock import patch

from rest_framework.test import APITestCase
from .models import AuditLog, ShiftAttendanceEvent, Timesheet
from .test_site_attendance import AttendanceFixture


class AttendanceGeofenceTests(AttendanceFixture, APITestCase):
    def setUp(self):
        super().setUp()
        for site in (self.full_site, self.basic_site):
            site.geofence_radius_m = 50
            site.save(update_fields=["geofence_radius_m"])

    def test_book_on_outside_radius_is_rejected_without_saving_attendance(self):
        for operation in (self.full, self.basic):
            response = self.submit(operation, "BOOK_ON", self.now(8), latitude="51.5006")
            self.assertEqual(response.status_code, 400, response.data)
            self.assertEqual(response.data["code"], "OUTSIDE_SITE")
            self.assertEqual(response.data["geofence_radius_m"], 50)
            self.assertGreater(response.data["distance_m"], 50)
            self.assertFalse(operation.attendance_events.exists())
            operation.refresh_from_db(); self.assertIsNone(operation.reached_at)
        self.assertEqual(Timesheet.objects.count(), 0)
        self.assertFalse(AuditLog.objects.filter(model_name="ShiftAttendanceEvent").exists())

    def test_hourly_and_book_off_cannot_bypass_the_geofence(self):
        for operation in (self.full, self.basic):
            self.assertEqual(self.submit(operation, "BOOK_ON", self.now(8)).status_code, 201)
        response = self.submit(self.full, "HOURLY", self.now(9, 45), sequence=1, longitude="-0.13")
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data["code"], "OUTSIDE_SITE")
        self.assertFalse(self.full.attendance_events.filter(event_type="HOURLY").exists())
        self.assertEqual(self.submit(self.full, "HOURLY", self.now(9, 45), sequence=1).status_code, 201)
        for operation in (self.full, self.basic):
            response = self.submit(operation, "BOOK_OFF", self.now(20, 10), latitude="51.5006")
            self.assertEqual(response.status_code, 400, response.data)
            self.assertEqual(response.data["code"], "OUTSIDE_SITE")
            self.assertFalse(operation.attendance_events.filter(event_type="BOOK_OFF").exists())
            self.assertFalse(Timesheet.objects.filter(operation=operation).exists())
            accepted = self.submit(operation, "BOOK_OFF", self.now(20, 10))
            self.assertEqual(accepted.status_code, 201, accepted.data)
            self.assertEqual(accepted.data["event"]["location_status"], "VERIFIED")

    def test_radius_boundary_is_checked_before_distance_rounding(self):
        with patch("core.views.haversine_distance_m", return_value=50.004):
            response = self.submit(self.full, "BOOK_ON", self.now(8))
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data["code"], "OUTSIDE_SITE")
        self.assertFalse(self.full.attendance_events.exists())
        with patch("core.views.haversine_distance_m", return_value=50):
            response = self.submit(self.full, "BOOK_ON", self.now(8))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["event"]["distance_m"], 50)

    def test_missing_unreliable_and_invalid_gps_are_rejected(self):
        for extra in ({"latitude":"nan"}, {"latitude":"inf"}, {"latitude":"91"},
                {"longitude":"-181"}, {"longitude":"inf"}, {"accuracy_m":"nan"},
                {"accuracy_m":"inf"}, {"accuracy_m":"-1"}, {"accuracy_m":""}, {"accuracy_m":"51"}):
            with self.subTest(extra=extra):
                response = self.submit(self.full, "BOOK_ON", self.now(8), **extra)
                self.assertEqual(response.status_code, 400, response.data)
        self.assertFalse(self.full.attendance_events.exists())
        response = self.submit(self.full, "BOOK_ON", self.now(8), accuracy_m="50")
        self.assertEqual(response.status_code, 201, response.data)

    def test_zero_coordinates_are_valid_and_not_treated_as_missing(self):
        self.full_site.latitude = 0; self.full_site.longitude = 0; self.full_site.save()
        response = self.submit(self.full, "BOOK_ON", self.now(8), latitude="0", longitude="0")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["event"]["distance_m"], 0)

    def test_invalid_or_missing_site_configuration_blocks_submissions(self):
        for latitude, longitude, radius in ((None,-.12,50),(51.5,None,50),(91,-.12,50),(51.5,-181,50),(51.5,-.12,0)):
            self.full_site.latitude=latitude;self.full_site.longitude=longitude;self.full_site.geofence_radius_m=radius;self.full_site.save()
            response=self.submit(self.full,"BOOK_ON",self.now(8))
            self.assertEqual(response.status_code,400,response.data)
            self.assertIn("site",response.data["detail"].lower())
        self.assertFalse(self.full.attendance_events.exists())

    def test_api_geofence_cannot_be_skipped_by_an_office_account(self):
        self.client.force_authenticate(self.admin)
        response=self.submit(self.full,"BOOK_ON",self.now(8),latitude="51.5006")
        self.assertEqual(response.status_code,400,response.data)
        self.assertEqual(response.data["code"],"OUTSIDE_SITE")
        self.assertFalse(self.full.attendance_events.exists())

    def test_site_settings_reject_invalid_coordinates_and_non_positive_radius(self):
        self.client.force_authenticate(self.admin)
        for value in ({"latitude":91},{"latitude":"nan"},{"longitude":-181},{"longitude":"inf"},{"geofence_radius_m":0},{"geofence_radius_m":-1}):
            with self.subTest(value=value):
                response=self.client.patch(f"/api/sites/{self.full_site.pk}/",value,format="json")
                self.assertEqual(response.status_code,400,response.data)
        self.full_site.refresh_from_db()
        self.assertEqual(self.full_site.geofence_radius_m,50)
        self.assertEqual(self.full_site.latitude,51.5)
