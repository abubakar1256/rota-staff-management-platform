from datetime import date, datetime, time
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .attendance_completion import complete_shift
from .models import AuditLog, Notification, ShiftAttendanceEvent, ShiftType, Timesheet, UserProfile
from .test_site_attendance import AttendanceFixture


class ShiftCompletionTests(AttendanceFixture, APITestCase):
    def finish(self, operation=None, start=None, end=None, **book_on_options):
        operation = operation or self.basic
        on = self.submit(operation, "BOOK_ON", start or self.now(8), **book_on_options)
        self.assertEqual(on.status_code, 201, on.data)
        off = self.submit(operation, "BOOK_OFF", end or self.now(20, 10))
        self.assertEqual(off.status_code, 201, off.data)
        return off.data["operation"]["completion_summary"]

    def test_success_returns_summary_and_one_unapproved_draft_with_exact_times(self):
        summary = self.finish()
        sheet = Timesheet.objects.get(operation=self.basic)
        self.assertEqual(summary["timesheet_id"], sheet.pk)
        self.assertEqual(summary["timesheet_status"], "DRAFT")
        self.assertEqual(summary["duration_minutes"], 730)
        self.assertEqual(summary["actual_hours"], 12.17)
        self.assertEqual(summary["site_name"], self.basic_site.name)
        self.assertEqual(sheet.actual_start_at, self.now(8))
        self.assertEqual(sheet.actual_end_at, self.now(20, 10))
        self.assertEqual(sheet.actual_hours, 12.17)
        self.assertFalse(sheet.approved)
        self.assertIsNone(sheet.approved_by)
        self.assertEqual(sheet.review_flags, [])
        self.assertTrue(AuditLog.objects.filter(model_name="Timesheet", object_id=str(sheet.pk), action="CREATE").exists())

    def test_only_active_admins_receive_individual_completion_notifications(self):
        User = get_user_model()
        second_admin = User.objects.create_user(username="completion-admin")
        UserProfile.objects.update_or_create(user=second_admin, defaults={"role": "ADMIN"})
        inactive = User.objects.create_user(username="inactive-admin", is_superuser=True, is_active=False)
        self.finish()
        notices = Notification.objects.filter(title="Shift completed")
        self.assertEqual(set(notices.values_list("user_id", flat=True)), {self.admin.pk, second_admin.pk})
        self.assertFalse(notices.filter(user__in=[inactive, self.guard, self.other]).exists())
        self.assertEqual(set(notices.values_list("link", flat=True)), {"timesheets"})

    def test_late_location_and_missing_hourly_exceptions_require_office_review(self):
        summary = self.finish(self.full, start=self.now(8, 10), late_reason="Traffic", accuracy_m="500")
        self.assertEqual(set(summary["review_flags"]), {"LATE_BOOK_ON", "LOCATION_EXCEPTION", "MISSED_HOURLY_PICTURES"})
        self.assertEqual(summary["timesheet_status"], "REVIEW_REQUIRED")
        self.assertTrue(Notification.objects.filter(user=self.admin, title="Shift completed - review required", notification_type="WARNING").exists())

    def test_all_hourly_pictures_avoid_missing_picture_flag(self):
        self.assertEqual(self.submit(self.full, "BOOK_ON", self.now(8)).status_code, 201)
        for hour in range(9, 20):
            response = self.submit(self.full, "HOURLY", self.now(hour, 5))
            self.assertEqual(response.status_code, 201, response.data)
        response = self.submit(self.full, "BOOK_OFF", self.now(20))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["operation"]["completion_summary"]["review_flags"], [])

    def test_duplicate_book_off_and_retries_never_duplicate_or_reset_approved_draft(self):
        self.finish()
        sheet = Timesheet.objects.get(operation=self.basic)
        sheet.approved, sheet.approved_by, sheet.approved_at = True, self.admin, self.now(21)
        sheet.save()
        count = Notification.objects.count()
        complete_shift(self.basic, self.guard)
        response = self.submit(self.basic, "BOOK_OFF", self.now(20, 15))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Timesheet.objects.filter(operation=self.basic).count(), 1)
        self.assertEqual(Notification.objects.count(), count)
        sheet.refresh_from_db()
        self.assertTrue(sheet.approved)
        self.assertEqual(sheet.approved_at, self.now(21))

    def test_overnight_duration_keeps_real_dates(self):
        night = ShiftType.objects.create(name="Completion night", start_time=time(20), end_time=time(8))
        operation = self.operation(self.basic_site, night)
        summary = self.finish(operation, start=self.now(20), end=self.now(8, 10, next_day=True))
        self.assertEqual(summary["duration_minutes"], 730)
        sheet = Timesheet.objects.get(operation=operation)
        self.assertEqual(sheet.work_date, self.day)
        self.assertEqual(timezone.localdate(sheet.actual_end_at), date(2026, 11, 3))

    def test_duration_across_clock_change_uses_elapsed_time(self):
        london = ZoneInfo("Europe/London")
        night = ShiftType.objects.create(name="Clock change", start_time=time(20), end_time=time(8))
        operation = self.operation(self.basic_site, night)
        operation.operation_date = date(2026, 10, 24)
        operation.save()
        with timezone.override(london):
            on = ShiftAttendanceEvent.objects.create(operation=operation, event_type="BOOK_ON", photo="test/on.jpg", created_by=self.guard)
            off = ShiftAttendanceEvent.objects.create(operation=operation, event_type="BOOK_OFF", photo="test/off.jpg", created_by=self.guard)
            ShiftAttendanceEvent.objects.filter(pk=on.pk).update(captured_at=datetime(2026, 10, 24, 20, tzinfo=london))
            ShiftAttendanceEvent.objects.filter(pk=off.pk).update(captured_at=datetime(2026, 10, 25, 8, tzinfo=london))
            self.assertEqual(complete_shift(operation, self.guard).actual_hours, 13)

    def test_expired_book_off_reason_does_not_complete_or_create_hours(self):
        self.submit(self.basic, "BOOK_ON", self.now(8))
        self.assertEqual(self.submit(self.basic, "BOOK_OFF", self.now(21)).status_code, 400)
        with patch("core.views.timezone.now", return_value=self.now(21)):
            response = self.client.post(f"/api/operations/{self.basic.pk}/book-off-note/", {"reason": "Forgot to book off"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(Timesheet.objects.exists())
        self.assertIsNone(self.client.get(f"/api/operations/{self.basic.pk}/").data["completion_summary"])

    def test_office_approval_records_reviewer_and_notifies_only_owner_once(self):
        summary = self.finish()
        self.client.force_authenticate(self.admin)
        url = f"/api/timesheets/{summary['timesheet_id']}/"
        for _ in range(2):
            response = self.client.patch(url, {"approved": True}, format="json")
            self.assertEqual(response.status_code, 200, response.data)
        sheet = Timesheet.objects.get(pk=summary["timesheet_id"])
        self.assertEqual(sheet.approved_by, self.admin)
        self.assertIsNotNone(sheet.approved_at)
        notices = Notification.objects.filter(title="Shift hours approved")
        self.assertEqual(list(notices.values_list("user_id", flat=True)), [self.guard.pk])
        self.assertTrue(AuditLog.objects.filter(model_name="Timesheet", object_id=str(sheet.pk), action="APPROVE").exists())
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get(f"/api/operations/{self.basic.pk}/").data["completion_summary"]["timesheet_status"], "APPROVED")
        self.assertEqual(self.client.patch(url, {"approved": False}, format="json").status_code, 403)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(f"/api/operations/{self.basic.pk}/").status_code, 404)

    def test_completed_evidence_cannot_be_replaced_or_deleted(self):
        summary = self.finish(start=self.now(8, 10), late_reason="Traffic")
        response = self.client.post(f"/api/operations/{self.basic.pk}/book-on-note/", {"reason": "Changed"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.client.force_authenticate(self.admin)
        url = f"/api/timesheets/{summary['timesheet_id']}/"
        self.assertEqual(self.client.patch(url, {"actual_start": "09:00"}, format="json").status_code, 400)
        self.assertEqual(self.client.delete(url).status_code, 400)
        self.assertEqual(self.client.patch(f"/api/operations/{self.basic.pk}/", {"site": self.full_site.pk}, format="json").status_code, 400)
        self.assertEqual(self.client.delete(f"/api/operations/{self.basic.pk}/").status_code, 400)
        response = self.client.post(f"/api/operations/{self.basic.pk}/book-on-note/", {"reason": "Office correction"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)

    def test_manual_timesheets_still_work_and_are_not_overwritten(self):
        manual = Timesheet.objects.create(employee=self.employee, site=self.basic_site, work_date=self.day, actual_start=time(9), actual_end=time(17), created_by=self.admin)
        self.finish()
        self.assertEqual(Timesheet.objects.count(), 2)
        self.client.force_authenticate(self.admin)
        response = self.client.patch(f"/api/timesheets/{manual.pk}/", {"actual_start": "10:00", "actual_end": "18:00"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["actual_hours"], 8)

    def test_timesheet_failure_rolls_back_book_off_instead_of_half_completing(self):
        self.submit(self.basic, "BOOK_ON", self.now(8))
        with patch("core.attendance_completion.complete_shift", side_effect=ValueError("Unable to complete")):
            response = self.submit(self.basic, "BOOK_OFF", self.now(20))
        self.assertEqual(response.status_code, 400)
        self.assertFalse(self.basic.attendance_events.filter(event_type="BOOK_OFF").exists())
        self.assertFalse(Timesheet.objects.exists())

    def test_legacy_completed_records_show_history_without_inventing_timesheets(self):
        on = self.book_on_record(self.basic)
        ShiftAttendanceEvent.objects.filter(pk=on.pk).update(captured_at=self.now(8))
        off = ShiftAttendanceEvent.objects.create(operation=self.basic, event_type="BOOK_OFF", photo="test/legacy.jpg", created_by=self.guard)
        ShiftAttendanceEvent.objects.filter(pk=off.pk).update(captured_at=self.now(20))
        response = self.client.get(f"/api/operations/{self.basic.pk}/")
        self.assertEqual(response.data["completion_summary"]["timesheet_status"], "NOT_CREATED")
        self.assertEqual(response.data["completion_summary"]["duration_minutes"], 720)
        self.assertFalse(Timesheet.objects.exists())
