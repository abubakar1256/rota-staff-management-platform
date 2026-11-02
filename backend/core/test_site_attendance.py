from datetime import date, datetime, time, timedelta
from io import BytesIO
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import DailyOperation, Employee, HourlyCheckinNote, ShiftAttendanceEvent, ShiftType, Site, UserProfile
from .serializers import DailyOperationSerializer


class SiteAttendanceModeTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_user(username="mode-admin", is_superuser=True)
        self.guard = User.objects.create_user(username="mode-guard")
        self.other = User.objects.create_user(username="mode-other")
        for user in (self.guard, self.other):
            UserProfile.objects.update_or_create(user=user, defaults={"role": "EMPLOYEE"})
        self.employee = Employee.objects.create(employee_id="MODE-1", name="Attendance mode guard", user=self.guard)
        self.day = date(2026, 11, 2)
        self.shift = ShiftType.objects.create(name="Attendance mode day", start_time=time(8), end_time=time(20))
        self.full_site = Site.objects.create(site_id="MODE-FULL", name="Hourly site", latitude=51.5, longitude=-.12)
        self.basic_site = Site.objects.create(site_id="MODE-BASIC", name="Book On Off site", latitude=51.5, longitude=-.12, attendance_mode=Site.AttendanceMode.BOOK_ON_OFF)
        self.full = self.operation(self.full_site)
        self.basic = self.operation(self.basic_site)
        media = TemporaryDirectory()
        self.addCleanup(media.cleanup)
        settings = self.settings(MEDIA_ROOT=media.name)
        settings.enable()
        self.addCleanup(settings.disable)
        self.client.force_authenticate(self.guard)

    def operation(self, site, shift=None):
        return DailyOperation.objects.create(operation_date=self.day, site=site, employee=self.employee, shift_type=shift or self.shift, created_by=self.admin)

    def now(self, hour, minute=0, next_day=False):
        return timezone.make_aware(datetime.combine(self.day + timedelta(days=int(next_day)), time(hour, minute)))

    def submit(self, operation, event_type, at, gps=True, photo=True, **extras):
        payload = {"event_type": event_type, **extras}
        if gps:
            payload.update(latitude="51.5", longitude="-0.12", accuracy_m="8")
        if photo:
            buffer = BytesIO()
            Image.new("RGB", (8, 8), "blue").save(buffer, format="JPEG")
            payload["photo"] = SimpleUploadedFile("attendance.jpg", buffer.getvalue(), content_type="image/jpeg")
        with patch("core.views.timezone.now", return_value=at), patch("core.views.generate_daily_arrival_reports", return_value=[]):
            return self.client.post(f"/api/operations/{operation.pk}/attendance/", payload, format="multipart")

    def book_on_record(self, operation):
        return ShiftAttendanceEvent.objects.create(operation=operation, event_type="BOOK_ON", photo="test/book-on.jpg", created_by=self.guard)

    def test_existing_site_default_retains_hourly_workflow(self):
        self.assertEqual(self.full_site.attendance_mode, "WITH_HOURLY")
        self.assertEqual(DailyOperationSerializer(self.full).data["expected_hourly_checkins"], 11)
        response = self.client.get(f"/api/operations/{self.basic.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["attendance_mode"], "BOOK_ON_OFF")
        self.assertFalse(response.data["hourly_pictures_required"])
        self.assertEqual(response.data["expected_hourly_checkins"], 0)
        self.assertEqual(response.data["hourly_checkins"], [])

    def test_admin_can_create_and_edit_a_site_mode_without_changing_other_sites(self):
        self.client.force_authenticate(self.admin)
        response = self.client.post("/api/sites/", {"site_id": "MODE-NEW", "name": "New mode site", "attendance_mode": "BOOK_ON_OFF"}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(Site.objects.get(pk=response.data["id"]).attendance_mode, "BOOK_ON_OFF")
        response = self.client.patch(f"/api/sites/{self.full_site.pk}/", {"attendance_mode": "BOOK_ON_OFF"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get(f"/api/operations/{self.full.pk}/").data["hourly_checkins"], [])
        self.basic_site.refresh_from_db()
        self.assertEqual(self.basic_site.attendance_mode, "BOOK_ON_OFF")

    def test_basic_site_can_complete_book_on_and_off_without_hourly_pictures(self):
        booked_on = self.submit(self.basic, "BOOK_ON", self.now(8))
        self.assertEqual(booked_on.status_code, 201, booked_on.data)
        booked_off = self.submit(self.basic, "BOOK_OFF", self.now(20, 10))
        self.assertEqual(booked_off.status_code, 201, booked_off.data)
        self.assertEqual(booked_off.data["operation"]["attendance_status"], "BOOKED_OFF")
        self.assertEqual(booked_off.data["operation"]["hourly_checkins"], [])
        self.assertEqual(list(self.basic.attendance_events.values_list("event_type", flat=True)), ["BOOK_ON", "BOOK_OFF"])

    def test_disabled_hourly_upload_and_reason_cannot_be_forced_through_api(self):
        response = self.submit(self.basic, "HOURLY", self.now(9, 10), attendance_mode="WITH_HOURLY")
        self.assertEqual(response.status_code, 400)
        self.assertIn("not required", response.data["detail"])
        response = self.client.post(f"/api/operations/{self.basic.pk}/hourly-note/", {"sequence": 1, "reason": "Test"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("not required", response.data["detail"])
        self.assertFalse(self.basic.attendance_events.exists())
        self.assertFalse(HourlyCheckinNote.objects.filter(operation=self.basic).exists())

    def test_full_site_still_accepts_hourly_picture_in_its_window(self):
        self.assertEqual(self.submit(self.full, "BOOK_ON", self.now(8)).status_code, 201)
        response = self.submit(self.full, "HOURLY", self.now(9, 10))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["event"]["sequence"], 1)
        self.assertEqual(response.data["operation"]["expected_hourly_checkins"], 11)
        self.assertEqual(response.data["operation"]["hourly_checkins"][0]["status"], "COMPLETED")

    def test_gps_and_photo_remain_mandatory_in_both_modes(self):
        for operation in (self.basic, self.full):
            response = self.submit(operation, "BOOK_ON", self.now(8), gps=False)
            self.assertEqual(response.status_code, 400)
            self.assertIn("GPS", response.data["detail"])
            response = self.submit(operation, "BOOK_ON", self.now(8), photo=False)
            self.assertEqual(response.status_code, 400)
            self.assertIn("live image file", response.data["detail"].lower())
            self.assertFalse(operation.attendance_events.exists())

    def test_overnight_basic_site_keeps_next_day_book_off_window(self):
        night = ShiftType.objects.create(name="Attendance mode night", start_time=time(20), end_time=time(8))
        operation = self.operation(self.basic_site, night)
        self.assertEqual(self.submit(operation, "BOOK_ON", self.now(20)).status_code, 201)
        self.assertEqual(self.submit(operation, "BOOK_OFF", self.now(7, 50, next_day=True)).status_code, 400)
        response = self.submit(operation, "BOOK_OFF", self.now(8, 10, next_day=True))
        self.assertEqual(response.status_code, 201, response.data)

    def test_changing_mode_preserves_existing_attendance_evidence(self):
        self.book_on_record(self.full)
        evidence = ShiftAttendanceEvent.objects.create(operation=self.full, event_type="HOURLY", sequence=1, photo="test/old-hourly.jpg", created_by=self.guard)
        self.full_site.attendance_mode = "BOOK_ON_OFF"
        self.full_site.save(update_fields=["attendance_mode"])
        response = self.client.get(f"/api/operations/{self.full.pk}/")
        self.assertEqual(response.data["hourly_checkins"], [])
        self.assertIn(evidence.pk, {event["id"] for event in response.data["attendance_events"]})

    def test_guards_cannot_change_site_mode_or_submit_another_guards_attendance(self):
        self.assertEqual(self.client.patch(f"/api/sites/{self.basic_site.pk}/", {"attendance_mode": "WITH_HOURLY"}, format="json").status_code, 403)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.submit(self.basic, "BOOK_ON", self.now(8)).status_code, 404)

    def test_invalid_attendance_mode_is_rejected(self):
        self.client.force_authenticate(self.admin)
        response = self.client.patch(f"/api/sites/{self.basic_site.pk}/", {"attendance_mode": "INVALID"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.basic_site.refresh_from_db()
        self.assertEqual(self.basic_site.attendance_mode, "BOOK_ON_OFF")
