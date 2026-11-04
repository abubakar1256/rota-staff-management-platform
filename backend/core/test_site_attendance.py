from datetime import date, datetime, time, timedelta
from io import BytesIO
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import AuditLog, DailyOperation, Employee, HourlyCheckinNote, ShiftAttendanceEvent, ShiftType, Site, UserProfile
from .serializers import DailyOperationSerializer


class AttendanceFixture:
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
        payload.update(extras)
        if photo:
            buffer = BytesIO()
            Image.new("RGB", (8, 8), "blue").save(buffer, format="JPEG")
            payload["photo"] = SimpleUploadedFile("attendance.jpg", buffer.getvalue(), content_type="image/jpeg")
        with patch("core.views.timezone.now", return_value=at), patch("core.views.generate_daily_arrival_reports", return_value=[]):
            return self.client.post(f"/api/operations/{operation.pk}/attendance/", payload, format="multipart")

    def book_on_record(self, operation):
        return ShiftAttendanceEvent.objects.create(operation=operation, event_type="BOOK_ON", photo="test/book-on.jpg", created_by=self.guard)


class SiteAttendanceModeTests(AttendanceFixture, APITestCase):
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

    def test_late_book_on_requires_a_reason_in_both_modes(self):
        for operation in (self.basic, self.full):
            for reason in ("", "   "):
                response = self.submit(operation, "BOOK_ON", self.now(8, 10), late_reason=reason)
                self.assertEqual(response.status_code, 400)
                self.assertIn("reason for late Book On", response.data["detail"])
            self.assertFalse(operation.attendance_events.exists())

    def test_late_book_on_saves_reason_with_photo_gps_and_actual_timestamp(self):
        for operation in (self.basic, self.full):
            response = self.submit(operation, "BOOK_ON", self.now(8, 10), late_reason="  Delayed by traffic  ")
            self.assertEqual(response.status_code, 201, response.data)
            event = operation.attendance_events.get(event_type="BOOK_ON")
            self.assertEqual(event.late_reason, "Delayed by traffic")
            self.assertEqual(event.captured_at, self.now(8, 10))
            self.assertEqual(event.location_status, "VERIFIED")
            self.assertTrue(event.photo.name)
            self.assertTrue(response.data["operation"]["book_on_is_late"])
            self.assertEqual(response.data["event"]["late_reason"], "Delayed by traffic")
            self.assertEqual(response.data["operation"]["book_on_due_at"], self.now(8).isoformat())

    def test_invalid_late_reason_does_not_create_attendance(self):
        response = self.submit(self.basic, "BOOK_ON", self.now(8, 10), late_reason="x" * 501)
        self.assertEqual(response.status_code, 400)
        self.assertIn("500", response.data["detail"])
        self.assertFalse(self.basic.attendance_events.exists())

    def test_on_time_book_on_never_becomes_late_when_read_later(self):
        response = self.submit(self.basic, "BOOK_ON", self.now(8))
        self.assertEqual(response.status_code, 201)
        with patch("core.serializers.timezone.now", return_value=self.now(14)):
            response = self.client.get(f"/api/operations/{self.basic.pk}/")
        self.assertFalse(response.data["book_on_is_late"])
        self.assertEqual(response.data["attendance_events"][0]["late_reason"], "")
        response = self.client.post(f"/api/operations/{self.basic.pk}/book-on-note/", {"reason": "Late"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_guard_can_add_or_update_a_legacy_late_reason_without_changing_evidence(self):
        event = self.book_on_record(self.basic)
        ShiftAttendanceEvent.objects.filter(pk=event.pk).update(captured_at=self.now(8, 10))
        for reason in ("Traffic delay", "Updated traffic explanation"):
            response = self.client.post(f"/api/operations/{self.basic.pk}/book-on-note/", {"reason": reason}, format="json")
            self.assertEqual(response.status_code, 200, response.data)
            event.refresh_from_db()
            self.assertEqual(event.late_reason, reason)
            self.assertEqual(event.captured_at, self.now(8, 10))
            self.assertEqual(event.photo.name, "test/book-on.jpg")
            self.assertEqual(response.data["operation"]["attendance_events"][0]["late_reason"], reason)
        self.assertTrue(AuditLog.objects.filter(model_name="ShiftAttendanceEvent", object_id=str(event.pk), action="ATTENDANCE").exists())
        for reason in (" ", "x" * 501, {"invalid": "value"}):
            self.assertEqual(self.client.post(f"/api/operations/{self.basic.pk}/book-on-note/", {"reason": reason}, format="json").status_code, 400)

    def test_late_reason_endpoint_requires_existing_book_on_and_correct_guard(self):
        self.assertEqual(self.client.post(f"/api/operations/{self.basic.pk}/book-on-note/", {"reason": "Traffic"}, format="json").status_code, 400)
        event = self.book_on_record(self.basic)
        ShiftAttendanceEvent.objects.filter(pk=event.pk).update(captured_at=self.now(8, 10))
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.post(f"/api/operations/{self.basic.pk}/book-on-note/", {"reason": "Tampered"}, format="json").status_code, 404)
        event.refresh_from_db()
        self.assertEqual(event.late_reason, "")

    def test_overnight_late_book_on_uses_the_operation_start_date(self):
        night = ShiftType.objects.create(name="Late reason night", start_time=time(20), end_time=time(8))
        operation = self.operation(self.basic_site, night)
        response = self.submit(operation, "BOOK_ON", self.now(0, 10, next_day=True))
        self.assertEqual(response.status_code, 400)
        response = self.submit(operation, "BOOK_ON", self.now(0, 10, next_day=True), late_reason="Emergency delay")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(response.data["operation"]["book_on_is_late"])
        self.assertEqual(response.data["operation"]["book_on_due_at"], self.now(20).isoformat())

    def test_expired_book_off_still_accepts_a_reason_in_both_modes(self):
        for operation in (self.basic, self.full):
            self.book_on_record(operation)
            with patch("core.views.timezone.now", return_value=self.now(20, 45)):
                response = self.client.post(f"/api/operations/{operation.pk}/book-off-note/", {"reason": "Site emergency"}, format="json")
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data["operation"]["book_off_note"]["reason"], "Site emergency")


class HourlySlotSubmissionTests(AttendanceFixture, APITestCase):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.submit(self.full, "BOOK_ON", self.now(8)).status_code, 201)

    def test_current_picture_uses_its_slot_after_earlier_pictures_were_missed(self):
        for sequence in (1, 2):
            HourlyCheckinNote.objects.create(operation=self.full, sequence=sequence,
                reason="Site incident", created_by=self.guard)
        response = self.submit(self.full, "HOURLY", self.now(11, 10), sequence=3)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["event"]["sequence"], 3)
        checkins = response.data["operation"]["hourly_checkins"]
        self.assertEqual([row["status"] for row in checkins[:3]], ["EXPIRED", "EXPIRED", "COMPLETED"])
        self.assertEqual([row["missed_reason"] for row in checkins[:2]], ["Site incident", "Site incident"])
        later = self.submit(self.full, "HOURLY", self.now(12, 10), sequence=4)
        self.assertEqual(later.status_code, 201, later.data)
        self.assertEqual(later.data["event"]["sequence"], 4)
        self.assertEqual(set(self.full.attendance_events.filter(event_type="HOURLY").values_list("sequence", flat=True)), {3, 4})

    def test_older_portal_without_slot_number_uses_the_current_open_window(self):
        response = self.submit(self.full, "HOURLY", self.now(11, 10))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["event"]["sequence"], 3)

    def test_expired_and_future_slots_cannot_be_backfilled_or_submitted_early(self):
        expired = self.submit(self.full, "HOURLY", self.now(11, 10), sequence=1)
        self.assertEqual(expired.status_code, 400)
        self.assertIn("check-in 1 expired at 10:00", expired.data["detail"])
        future = self.submit(self.full, "HOURLY", self.now(11, 10), sequence=4)
        self.assertEqual(future.status_code, 400)
        self.assertIn("check-in 4 is available from 12:00", future.data["detail"])
        self.assertFalse(self.full.attendance_events.filter(event_type="HOURLY").exists())

    def test_duplicate_current_slot_is_rejected_without_creating_extra_evidence(self):
        self.assertEqual(self.submit(self.full, "HOURLY", self.now(11, 10), sequence=3).status_code, 201)
        response = self.submit(self.full, "HOURLY", self.now(11, 11), sequence=3)
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn("already been recorded", response.data["detail"])
        self.assertEqual(self.full.attendance_events.filter(event_type="HOURLY").count(), 1)

    def test_invalid_slot_numbers_never_store_a_picture(self):
        for sequence in (0, -1, 12, "wrong", "1.5", "²", True, "999999999999999999999"):
            with self.subTest(sequence=sequence):
                self.assertEqual(self.submit(self.full, "HOURLY", self.now(11, 10), sequence=sequence).status_code, 400)
        self.assertFalse(self.full.attendance_events.filter(event_type="HOURLY").exists())

    def test_overnight_shift_accepts_the_correct_slot_after_midnight(self):
        night = ShiftType.objects.create(name="Hourly overnight", start_time=time(20), end_time=time(8))
        operation = self.operation(self.full_site, night)
        self.assertEqual(self.submit(operation, "BOOK_ON", self.now(20)).status_code, 201)
        response = self.submit(operation, "HOURLY", self.now(1, 10, next_day=True), sequence=5)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["event"]["sequence"], 5)

    def test_slot_deadline_is_inclusive_and_a_later_upload_is_rejected(self):
        late = self.submit(self.full, "HOURLY", self.now(12) + timedelta(seconds=1), sequence=3)
        self.assertEqual(late.status_code, 400)
        self.assertFalse(self.full.attendance_events.filter(event_type="HOURLY").exists())
        on_deadline = self.submit(self.full, "HOURLY", self.now(12), sequence=3)
        self.assertEqual(on_deadline.status_code, 201, on_deadline.data)

    def test_second_half_hour_remains_available_and_accepts_a_live_picture(self):
        for minute in (31, 59):
            with patch("core.serializers.timezone.now", return_value=self.now(11, minute)):
                slot = DailyOperationSerializer(self.full).data["hourly_checkins"][2]
            self.assertEqual(slot["status"], "AVAILABLE")
            self.assertEqual(slot["due_at"], self.now(11).isoformat())
            self.assertEqual(slot["deadline_at"], self.now(12).isoformat())
        response = self.submit(self.full, "HOURLY", self.now(11, 59), sequence=3)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["event"]["sequence"], 3)

    def test_missed_reason_is_only_accepted_after_the_complete_hour_expires(self):
        url = f"/api/operations/{self.full.pk}/hourly-note/"
        for at in (self.now(11, 31), self.now(11, 59), self.now(12)):
            with patch("core.views.timezone.now", return_value=at):
                response = self.client.post(url, {"sequence": 3, "reason": "Site emergency"}, format="json")
            self.assertEqual(response.status_code, 400, response.data)
            self.assertIn("not missed yet", response.data["detail"])
        self.assertFalse(HourlyCheckinNote.objects.filter(operation=self.full).exists())
        with patch("core.views.timezone.now", return_value=self.now(12) + timedelta(seconds=1)):
            response = self.client.post(url, {"sequence": 3, "reason": "Site emergency"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["operation"]["hourly_checkins"][2]["status"], "EXPIRED")
        self.assertEqual(response.data["operation"]["hourly_checkins"][2]["missed_reason"], "Site emergency")

    def test_final_hour_reaches_shift_end_and_book_off_keeps_its_own_window(self):
        with patch("core.serializers.timezone.now", return_value=self.now(19, 59)):
            data = DailyOperationSerializer(self.full).data
        final = data["hourly_checkins"][-1]
        self.assertEqual(final["due_at"], self.now(19).isoformat())
        self.assertEqual(final["deadline_at"], self.now(20).isoformat())
        self.assertEqual(final["status"], "AVAILABLE")
        self.assertEqual(data["book_off_deadline_at"], self.now(20, 30).isoformat())

    def test_overnight_slot_has_the_full_hour_after_midnight(self):
        night = ShiftType.objects.create(name="Full hour night", start_time=time(20), end_time=time(8))
        operation = self.operation(self.full_site, night)
        self.assertEqual(self.submit(operation, "BOOK_ON", self.now(20)).status_code, 201)
        response = self.submit(operation, "HOURLY", self.now(1, 59, next_day=True), sequence=5)
        self.assertEqual(response.status_code, 201, response.data)
        slot = response.data["operation"]["hourly_checkins"][4]
        self.assertEqual(slot["deadline_at"], self.now(2, next_day=True).isoformat())
