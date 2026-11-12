from contextlib import closing
from datetime import datetime, timezone
from io import BytesIO, StringIO
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase
from PIL import Image
from rest_framework.test import APIClient

from .models import ControlAttendance, ControlAttendanceSettings, ControlTeamMember, Employee, Notification, UserProfile


SETTINGS_URL = "/api/control/attendance/settings/"
ASSIGNMENTS_URL = "/api/control/team/assignments/"
WEEKLY_URL = "/api/control/team/weekly-assignments/"
NOTIFICATIONS_URL = "/api/control/notifications/"
OFFICE_GPS = {"latitude": 51.5074, "longitude": -0.1278, "accuracy_m": 12}


def picture(color="blue"):
    buffer = BytesIO()
    Image.new("RGB", (35, 45), color).save(buffer, format="PNG")
    return SimpleUploadedFile("portrait.png", buffer.getvalue(), content_type="image/png")


class ControlTeamTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        media = self.enterContext(TemporaryDirectory())
        self.enterContext(self.settings(MEDIA_ROOT=media))
        user_model = get_user_model()
        admin = user_model.objects.create_user("office")
        UserProfile.objects.create(user=admin, role=UserProfile.Role.ADMIN)
        self.office = APIClient()
        self.office.force_authenticate(admin)
        self.credentials = {"username": "control@example.com", "password": "Watchtower^93!Paper"}
        response = self.office.post("/api/control/team/", {
            "name": "Control Member", "email": self.credentials["username"], "password": self.credentials["password"],
        }, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.member = ControlTeamMember.objects.get(pk=response.data["id"])
        self.assertFalse(Employee.objects.filter(user=self.member.user).exists())
        self.portal = APIClient()
        response = self.portal.post("/api/control/login/", self.credentials, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.portal.credentials(HTTP_AUTHORIZATION=f"Token {response.data['token']}")
        self.enterContext(patch("core.control_team.timezone.now", return_value=datetime(2026, 11, 11, 9, tzinfo=timezone.utc)))
        self.settings_record = ControlAttendanceSettings.objects.create(pk=1, latitude=51.5074, longitude=-0.1278)
        self.assignment_id = self.assign("M", "2026-11-11")["id"]

    def assign(self, shift, date, member=None):
        response = self.office.post(
            ASSIGNMENTS_URL, {"shift": shift, "shift_date": date, "member": (member or self.member).pk}, format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def complete_profile(self):
        response = self.portal.put("/api/control/profile/", {
            "name": "Control Member", "phone": "01234567890",
            "photo": picture(),
        }, format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["profile_complete"])
        return response.data["photo_url"]

    def mark(self, action, **fields):
        assignment = {"assignment_id": self.assignment_id} if action == "check_in" and "weekly_assignment_id" not in fields else {}
        return self.portal.post(
            "/api/control/attendance/",
            {"action": action, "photo": picture(), **OFFICE_GPS, **assignment, **fields},
            format="multipart",
        )

    def test_portal_is_scoped_and_photo_is_private(self):
        photo_url = self.complete_profile()
        for path in ["/api/dashboard/", "/api/operations/", "/api/notifications/", "/api/auth/me/"]:
            self.assertEqual(self.portal.get(path).status_code, 401, path)
        self.assertEqual(self.portal.get("/api/control/team/").status_code, 403)
        self.assertEqual(self.office.get("/api/control/profile/").status_code, 403)
        self.assertEqual(APIClient().get(photo_url).status_code, 401)
        for client in [self.portal, self.office]:
            response = client.get(photo_url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response["Content-Type"], "image/jpeg")
            response.close()
        other = ControlTeamMember.objects.create(user=get_user_model().objects.create_user("other"), name="Other")
        self.assertEqual(self.portal.get(f"/api/control/photos/{other.pk}/").status_code, 404)
        self.assertEqual(APIClient().post("/api/auth/login/", self.credentials, format="json").status_code, 403)
        self.assertEqual(self.portal.post("/api/control/logout/").status_code, 204)
        self.assertEqual(self.portal.get("/api/control/profile/").status_code, 401)

    def test_profile_required_then_idempotent_check_in_and_out(self):
        incomplete = self.portal.put("/api/control/profile/", {"name": "Control Member", "phone": "01234"}, format="json")
        self.assertEqual(incomplete.status_code, 400)
        self.assertIn("photo", incomplete.data)
        self.assertEqual(self.mark("check_in").status_code, 403)
        self.complete_profile()
        start = datetime(2026, 11, 6, 9, tzinfo=timezone.utc)
        self.assignment_id = self.assign("M", "2026-11-06")["id"]
        with patch("core.control_team.timezone.now", return_value=start):
            for _ in range(2):
                self.assertEqual(self.mark("check_in").status_code, 200)
            listing = self.office.get("/api/control/team/").data
            self.assertEqual(listing[0]["checked_in_at"], start)
            self.assertEqual(self.member.attendance.count(), 1)
        end = start.replace(hour=10, minute=32)
        entry_id = self.member.attendance.get().pk
        with patch("core.control_team.timezone.now", return_value=end):
            for _ in range(2):
                response = self.mark("check_out", attendance_id=entry_id)
                self.assertEqual(response.status_code, 200, response.data)
                self.assertIsNone(response.data["checked_in_at"])
                self.assertEqual(response.data["weekly_seconds"], 92 * 60)
                self.assertEqual(response.data["monthly_seconds"], 92 * 60)
        self.assertEqual(self.member.attendance.get().checked_out_at, end)
        for recipient in (self.member.user, None):
            alerts = Notification.objects.filter(link="control-team", user=recipient, category="ATTENDANCE")
            self.assertEqual(alerts.count(), 2)
            late = alerts.get(title__endswith="Late Check In")
            self.assertEqual(late.priority, "URGENT")
            self.assertIn("120 min late", late.message)
            self.assertTrue(alerts.filter(title__endswith="Check Out recorded").exists())

    def test_control_notification_inbox_and_mark_read_are_scoped(self):
        another_user = get_user_model().objects.create_user("another-control")
        UserProfile.objects.create(user=another_user, role=UserProfile.Role.CONTROL_TEAM)
        other_alert = Notification.objects.create(user=another_user, title="Other member", link="control-team")
        office_only = Notification.objects.create(title="Office team update", link="control-team")
        unrelated = Notification.objects.create(title="Guard office update", link="attendance-review")
        own_alert = Notification.objects.get(user=self.member.user, link="control-team", title="Shift assigned")
        result = self.portal.get(NOTIFICATIONS_URL + "inbox/?category=ROTA_STAFFING")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual([item["id"] for item in result.data["results"]], [own_alert.pk])
        self.assertEqual(result.data["summary"]["unread"], 1)
        self.assertEqual(self.portal.post(f"{NOTIFICATIONS_URL}{other_alert.pk}/mark_read/").status_code, 404)
        self.assertEqual(self.portal.post(f"{NOTIFICATIONS_URL}{office_only.pk}/mark_read/").status_code, 404)
        self.assertEqual(self.portal.post(NOTIFICATIONS_URL + "mark-all-read/").data["updated"], 1)
        self.assertFalse(Notification.objects.filter(pk=own_alert.pk, is_read=False).exists())
        office_ids = {item["id"] for item in self.office.get(NOTIFICATIONS_URL).data}
        self.assertIn(office_only.pk, office_ids)
        self.assertFalse(office_ids.intersection({own_alert.pk, other_alert.pk, unrelated.pk}))
        self.assertEqual(self.office.post(NOTIFICATIONS_URL + "mark-all-read/").status_code, 200)
        self.assertEqual(Notification.objects.filter(pk__in=[other_alert.pk, unrelated.pk], is_read=False).count(), 2)

        guard = get_user_model().objects.create_user("guard-notification-test")
        UserProfile.objects.create(user=guard, role=UserProfile.Role.EMPLOYEE)
        guard_client = APIClient()
        guard_client.force_authenticate(guard)
        self.assertEqual(guard_client.get(NOTIFICATIONS_URL).status_code, 403)

    def test_attendance_photos_are_required_and_private(self):
        self.complete_profile()
        path = "/api/control/attendance/"
        invalid_photo = SimpleUploadedFile("fake.jpg", b"not an image", content_type="image/jpeg")
        for payload in [{"action": "check_in"}, {"action": "check_in", "photo": invalid_photo}]:
            result = self.portal.post(path, payload, format="multipart")
            self.assertEqual(result.status_code, 400)
            self.assertIn("photo", result.data)
        self.assertFalse(self.member.attendance.exists())

        checked_in = self.mark("check_in", photo=picture("red")).data["attendance"][0]
        self.assertIsNone(checked_in["check_out_photo_url"])
        result = self.portal.post(path, {"action": "check_out", "attendance_id": checked_in["id"]}, format="multipart")
        self.assertEqual(result.status_code, 400)
        self.assertIn("photo", result.data)
        self.assertEqual(self.mark("check_out", attendance_id=checked_in["id"] + 1).status_code, 409)
        self.assertIsNone(self.member.attendance.get().checked_out_at)
        checked_out = self.mark("check_out", attendance_id=checked_in["id"], photo=picture("green"))
        self.assertEqual(checked_out.status_code, 200, checked_out.data)

        other_user = get_user_model().objects.create_user("another_member")
        UserProfile.objects.create(user=other_user, role=UserProfile.Role.CONTROL_TEAM)
        other = APIClient()
        other.force_authenticate(other_user)
        entry = self.office.get(f"/api/control/team/{self.member.pk}/").data["attendance"][0]
        self.assertEqual(entry, checked_out.data["attendance"][0])
        photos = []
        for field in ("check_in_photo_url", "check_out_photo_url"):
            url = entry[field]
            self.assertEqual(APIClient().get(url).status_code, 401)
            self.assertEqual(other.get(url).status_code, 404)
            for client in [self.portal, self.office]:
                with closing(client.get(url)) as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response["Content-Type"], "image/jpeg")
                    self.assertIn("no-store", response["Cache-Control"])
                    content = b"".join(response.streaming_content)
                    self.assertTrue(content.startswith(b"\xff\xd8"))
            photos.append(content)
        self.assertNotEqual(*photos)

    def test_hours_clip_at_london_week_and_month_boundaries(self):
        ControlAttendance.objects.create(
            member=self.member,
            checked_in_at=datetime(2026, 5, 31, 21, tzinfo=timezone.utc),
            checked_out_at=datetime(2026, 6, 1, 1, tzinfo=timezone.utc),
        )
        ControlAttendance.objects.create(
            member=self.member,
            checked_in_at=datetime(2026, 6, 1, 2, tzinfo=timezone.utc),
        )
        now = datetime(2026, 6, 1, 3, tzinfo=timezone.utc)
        with patch("core.control_team.timezone.now", return_value=now):
            data = self.portal.get("/api/control/profile/").data
        self.assertEqual(data["weekly_seconds"], 3 * 3600)
        self.assertEqual(data["monthly_seconds"], 3 * 3600)

    def test_deactivation_revokes_access_and_preserves_history(self):
        self.complete_profile()
        self.mark("check_in")
        path = f"/api/control/team/{self.member.pk}/"
        result = self.office.patch(path, {"is_active": False}, format="json")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertFalse(result.data["is_active"])
        self.assertTrue(result.data["attendance"][0]["closed_by_admin"])
        self.assertIsNone(result.data["attendance"][0]["check_out_photo_url"])
        self.assertEqual(self.portal.get("/api/control/profile/").status_code, 401)
        self.assertEqual(self.portal.post("/api/control/login/", self.credentials, format="json").status_code, 400)
        self.assertEqual(self.office.patch(path, {"is_active": True}, format="json").status_code, 200)
        self.assertEqual(self.portal.post("/api/control/login/", self.credentials, format="json").status_code, 200)
        self.assertEqual(self.member.attendance.count(), 1)

    def test_office_edits_settings_and_members_can_only_read_them(self):
        self.settings_record.delete()
        config = self.portal.get(SETTINGS_URL).data
        self.assertIsNone(config["latitude"])
        self.assertEqual(config["shifts"], {
            "M": {"start": "07:00", "end": "17:00"},
            "D": {"start": "11:00", "end": "21:00"},
            "E": {"start": "13:00", "end": "23:00"},
            "N": {"start": "22:00", "end": "08:00"},
        })
        config.update(address="Control office", latitude=51.5074, longitude=-0.1278, radius_m=50)
        self.assertEqual(self.portal.put(SETTINGS_URL, config, format="json").status_code, 403)
        self.assertEqual(self.office.put(SETTINGS_URL, {**config, "radius_m": 0}, format="json").status_code, 400)
        self.assertEqual(self.office.put(SETTINGS_URL, {**config, "longitude": None}, format="json").status_code, 400)
        self.complete_profile()
        self.assertEqual(self.mark("check_in").status_code, 400)
        config["shifts"]["M"]["start"] = "09:00"
        saved = self.office.put(SETTINGS_URL, config, format="json")
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data, self.portal.get(SETTINGS_URL).data)
        assignment = self.assign("M", "2026-11-12")
        with patch("core.control_team.timezone.now", return_value=datetime(2026, 11, 12, 9, tzinfo=timezone.utc)):
            entry = self.mark("check_in", assignment_id=assignment["id"]).data["attendance"][0]
        self.assertEqual(entry["late_minutes"], 0)
        self.assertEqual(entry["shift_name"], "Morning")

    def test_manual_check_in_and_out_enforce_radius_and_record_their_own_location(self):
        self.complete_profile()
        path = "/api/control/attendance/"
        incomplete = self.portal.post(
            path, {"action": "check_in", "assignment_id": self.assignment_id, "photo": picture(), "shift": "N"},
            format="multipart",
        )
        self.assertEqual(incomplete.status_code, 400)
        self.assertIn("latitude", incomplete.data)
        for gps in [{"latitude": "NaN"}, {"latitude": 51.52}, {"accuracy_m": 151}]:
            self.assertEqual(self.mark("check_in", **gps).status_code, 400)
        self.assertFalse(self.member.attendance.exists())

        checked_in = self.mark("check_in", latitude=51.5075)
        self.assertEqual(checked_in.status_code, 200, checked_in.data)
        entry = checked_in.data["attendance"][0]
        self.assertEqual(entry["late_minutes"], 120)
        self.assertEqual(entry["check_in_location"]["latitude"], 51.5075)
        incomplete = self.portal.post(path, {
            "action": "check_out", "attendance_id": entry["id"], "photo": picture(), "shift": "N",
        }, format="multipart")
        self.assertEqual(incomplete.status_code, 400)
        self.assertIn("latitude", incomplete.data)
        self.assertEqual(self.mark("check_out", attendance_id=entry["id"], latitude=51.52).status_code, 400)
        self.assertIsNone(self.member.attendance.get().checked_out_at)
        with patch("core.control_team.haversine_distance_m", return_value=150.004):
            self.assertEqual(self.mark("check_out", attendance_id=entry["id"]).status_code, 400)
        with patch("core.control_team.haversine_distance_m", return_value=150):
            checked_out = self.mark("check_out", attendance_id=entry["id"])
        self.assertEqual(checked_out.status_code, 200, checked_out.data)
        self.assertEqual(checked_out.data["attendance"][0]["check_out_location"], {
            **OFFICE_GPS, "distance_m": 150, "radius_m": 150,
        })

    def test_night_attendance_needs_photos_but_does_not_store_location(self):
        self.complete_profile()
        self.settings_record.latitude = self.settings_record.longitude = None
        self.settings_record.save(update_fields=["latitude", "longitude"])
        rule = self.office.post(WEEKLY_URL, {
            "member": self.member.pk, "shift": "N", "weekdays": [4],
        }, format="json")
        self.assertEqual(rule.status_code, 201, rule.data)
        path = "/api/control/attendance/"
        check_in = {"action": "check_in", "weekly_assignment_id": rule.data["id"], "shift_date": "2026-11-13"}
        with patch("core.control_team.timezone.now", return_value=datetime(2026, 11, 13, 22, tzinfo=timezone.utc)):
            self.assertEqual(self.portal.post(path, check_in, format="multipart").status_code, 400)
            checked_in = self.portal.post(path, {**check_in, "photo": picture()}, format="multipart")
        self.assertEqual(checked_in.status_code, 200, checked_in.data)
        entry = checked_in.data["attendance"][0]
        self.assertEqual(entry["shift"], "N")
        self.assertIsNone(entry["check_in_location"])
        self.assertTrue(entry["check_in_photo_url"])

        check_out = {"action": "check_out", "attendance_id": entry["id"]}
        with patch("core.control_team.timezone.now", return_value=datetime(2026, 11, 14, 8, tzinfo=timezone.utc)):
            self.assertEqual(self.portal.post(path, check_out, format="multipart").status_code, 400)
            checked_out = self.portal.post(path, {**check_out, "photo": picture()}, format="multipart")
        self.assertEqual(checked_out.status_code, 200, checked_out.data)
        entry = checked_out.data["attendance"][0]
        self.assertTrue(entry["checked_out_at"])
        self.assertTrue(entry["check_out_photo_url"])
        self.assertIsNone(entry["check_out_location"])

    def test_overnight_checkout_deadline_survives_shift_edit_and_runs_from_cron(self):
        self.complete_profile()
        # Check in after UK midnight on the night the clocks move forward.
        assignment = self.assign("N", "2026-03-28")
        with patch("core.control_team.timezone.now", return_value=datetime(2026, 3, 29, 0, 30, tzinfo=timezone.utc)):
            checked_in = self.mark("check_in", assignment_id=assignment["id"])
        self.assertEqual(checked_in.status_code, 200, checked_in.data)
        entry = self.member.attendance.get()
        self.assertIsNone(entry.check_in_location)
        self.assertEqual(entry.scheduled_start_at, datetime(2026, 3, 28, 22, tzinfo=timezone.utc))
        self.assertEqual(entry.scheduled_end_at, datetime(2026, 3, 29, 7, tzinfo=timezone.utc))
        deadline = datetime(2026, 3, 29, 7, 30, tzinfo=timezone.utc)
        self.assertEqual(entry.auto_checkout_at, deadline)
        self.settings_record.shifts["N"]["end"] = "09:00"
        self.settings_record.save(update_fields=["shifts"])

        with patch("core.control_team.timezone.now", return_value=deadline.replace(minute=29, second=59)):
            call_command("check_location_tracking", stdout=StringIO())
        entry.refresh_from_db()
        self.assertIsNone(entry.checked_out_at)
        with patch("core.control_team.timezone.now", return_value=deadline.replace(minute=33)):
            call_command("check_location_tracking", stdout=StringIO())
            call_command("check_location_tracking", stdout=StringIO())
            member = self.portal.get("/api/control/profile/").data
        entry.refresh_from_db()
        self.assertEqual(entry.checked_out_at, deadline)
        self.assertTrue(entry.auto_checked_out)
        self.assertFalse(entry.check_out_photo)
        self.assertIsNone(entry.check_out_location)
        self.assertIsNone(member["checked_in_at"])
        self.assertTrue(member["attendance"][0]["auto_checked_out"])
        for recipient in (self.member.user, None):
            alerts = Notification.objects.filter(link="control-team", user=recipient, title__endswith="Automatic Check Out")
            self.assertEqual(alerts.count(), 1)
            message = alerts.get().message
            self.assertIn("08:30 BST", message)
            self.assertIn("No manual Check Out was recorded.", message)

    def test_admin_assigns_reassigns_and_removes_without_exposing_other_members_shifts(self):
        user = get_user_model().objects.create_user("other_control")
        UserProfile.objects.create(user=user, role=UserProfile.Role.CONTROL_TEAM)
        other = ControlTeamMember.objects.create(user=user, name="Other Member")
        self.assertEqual(self.portal.get(ASSIGNMENTS_URL).status_code, 403)
        self.assertEqual(self.portal.post(ASSIGNMENTS_URL, {}, format="json").status_code, 403)
        self.assign("M", "2026-11-11", other)
        night = self.assign("N", "2026-11-11")
        self.assertEqual([row["id"] for row in self.portal.get("/api/control/profile/").data["assigned_shifts"]],
                         [self.assignment_id, night["id"]])
        for code, date in (("D", "2026-11-11"), ("M", "2026-11-12")):
            conflict = self.office.post(
                ASSIGNMENTS_URL, {"member": self.member.pk, "shift": code, "shift_date": date}, format="json",
            )
            self.assertEqual(conflict.status_code, 400)
            self.assertIn("conflicting", conflict.data["detail"])
        path = f"{ASSIGNMENTS_URL}{night['id']}/"
        reassigned = self.office.patch(path, {"member": other.pk}, format="json")
        self.assertEqual(reassigned.status_code, 200, reassigned.data)
        self.assertEqual(reassigned.data["member_name"], other.name)
        self.complete_profile()
        self.assertEqual(self.mark("check_in", assignment_id=night["id"]).status_code, 409)
        self.assertEqual(self.office.delete(path).status_code, 204)
        self.assertEqual(len(self.office.get(ASSIGNMENTS_URL + "?date=2026-11-11").data), 2)
        for recipient in (self.member.user, other.user):
            removed = Notification.objects.get(user=recipient, title="Shift removed")
            self.assertIn("Night", removed.message)

    def test_check_in_requires_an_available_assignment_and_locks_its_record(self):
        self.complete_profile()
        future = self.assign("E", "2026-11-12")
        self.assertEqual(future["status"], "Upcoming")
        self.assertEqual(self.mark("check_in", assignment_id=future["id"]).status_code, 409)
        ended = self.assign("M", "2026-11-10")
        self.assertEqual(self.mark("check_in", assignment_id=ended["id"]).status_code, 409)
        self.settings_record.shifts["M"] = {"start": "08:00", "end": "16:00"}
        self.settings_record.save(update_fields=["shifts"])
        checked_in = self.mark("check_in")
        self.assertEqual(checked_in.status_code, 200, checked_in.data)
        self.assertEqual(checked_in.data["attendance"][0]["late_minutes"], 120)
        entry = self.member.attendance.get()
        self.assertEqual(entry.auto_checkout_at, datetime(2026, 11, 11, 17, 30, tzinfo=timezone.utc))
        path = f"{ASSIGNMENTS_URL}{self.assignment_id}/"
        self.assertEqual(self.office.delete(path).status_code, 409)
        self.assertEqual(self.office.patch(path, {"member": self.member.pk}, format="json").status_code, 409)
        self.assertEqual(self.mark("check_out", attendance_id=entry.pk).status_code, 200)
        self.assertEqual(self.mark("check_in").status_code, 409)

    def test_existing_open_attendance_can_check_out_without_an_assignment(self):
        self.complete_profile()
        entry = ControlAttendance.objects.create(
            member=self.member, checked_in_at=datetime(2026, 11, 11, 8, tzinfo=timezone.utc),
        )
        result = self.mark("check_out", attendance_id=entry.pk)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertIsNone(result.data["checked_in_at"])

    def test_early_check_in_records_arrival_but_counts_hours_from_shift_start(self):
        self.complete_profile()
        day = datetime(2026, 11, 11, tzinfo=timezone.utc)
        with patch("core.control_team.timezone.now", return_value=day.replace(hour=6, minute=29, second=59)):
            profile = self.portal.get("/api/control/profile/").data
            self.assertEqual(profile["assigned_shifts"][0]["status"], "Upcoming")
            self.assertEqual(self.mark("check_in").status_code, 409)
        with patch("core.control_team.timezone.now", return_value=day.replace(hour=6, minute=30)):
            profile = self.portal.get("/api/control/profile/").data
            self.assertEqual(profile["assigned_shifts"][0]["status"], "Available")
            result = self.mark("check_in")
            self.assertEqual(result.status_code, 200, result.data)
            self.assertEqual(result.data["weekly_seconds"], 0)
            self.assertEqual(result.data["monthly_seconds"], 0)
            entry = result.data["attendance"][0]
            self.assertEqual(entry["checked_in_at"], "2026-11-11T06:30:00Z")
            self.assertEqual(entry["worked_start_at"], day.replace(hour=7))
            self.assertEqual(entry["late_minutes"], 0)
        with patch("core.control_team.timezone.now", return_value=day.replace(hour=17, minute=29)):
            result = self.mark("check_out", attendance_id=entry["id"])
            self.assertEqual(result.status_code, 200, result.data)
            self.assertFalse(result.data["attendance"][0]["auto_checked_out"])
            self.assertEqual(result.data["weekly_seconds"], (10 * 60 + 29) * 60)
            self.assertEqual(result.data["monthly_seconds"], (10 * 60 + 29) * 60)
            office_data = self.office.get(f"/api/control/team/{self.member.pk}/").data
            self.assertEqual(office_data["weekly_seconds"], result.data["weekly_seconds"])

    def test_weekly_shift_starting_after_midnight_allows_previous_day_check_in(self):
        self.complete_profile()
        self.settings_record.shifts["N"] = {"start": "00:10", "end": "03:00"}
        self.settings_record.save(update_fields=["shifts"])
        rule = self.office.post(WEEKLY_URL, {
            "member": self.member.pk, "shift": "N", "weekdays": [3],
        }, format="json")
        self.assertEqual(rule.status_code, 201, rule.data)
        with patch("core.control_team.timezone.now", return_value=datetime(2026, 11, 11, 23, 40, tzinfo=timezone.utc)):
            response = self.mark("check_in", weekly_assignment_id=rule.data["id"], shift_date="2026-11-12")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["weekly_seconds"], 0)
        self.assertEqual(response.data["attendance"][0]["worked_start_at"], datetime(2026, 11, 12, 0, 10, tzinfo=timezone.utc))

    def test_weekly_roster_repeats_mixed_shifts_and_uses_assignment_for_check_in(self):
        def add(shift, days):
            result = self.office.post(WEEKLY_URL, {"member": self.member.pk, "shift": shift, "weekdays": days}, format="json")
            self.assertEqual(result.status_code, 201, result.data)
            return result.data

        morning = add("M", [2, 0, 1])
        night = add("N", [4, 5])
        self.assertEqual(morning["weekdays"], [0, 1, 2])
        self.assertEqual(self.portal.get(WEEKLY_URL).status_code, 403)
        roster = self.portal.get("/api/control/profile/").data["assigned_shifts"]
        self.assertEqual([row["id"] for row in roster if row["shift_date"] == "2026-11-11"], [self.assignment_id])
        self.assertEqual(self.member.shift_assignments.count(), 1)
        self.complete_profile()
        with patch("core.control_team.timezone.now", return_value=datetime(2027, 7, 7, 8, tzinfo=timezone.utc)):
            roster = self.portal.get("/api/control/profile/").data["assigned_shifts"]
            self.assertEqual([row["shift"] for row in roster], ["M", "N", "N", "M", "M"])
            available = roster[0]
            self.assertEqual(available["weekly_assignment_id"], morning["id"])
            self.assertEqual(roster[1]["weekly_assignment_id"], night["id"])
            self.assertEqual(self.member.shift_assignments.count(), 1)
            for _ in range(2):
                result = self.mark("check_in", weekly_assignment_id=morning["id"], shift_date="2027-07-07")
                self.assertEqual(result.status_code, 200, result.data)
            self.assertEqual(result.data["attendance"][0]["late_minutes"], 120)
            entry = self.member.attendance.get()
            self.assertEqual(entry.scheduled_start_at, datetime(2027, 7, 7, 6, tzinfo=timezone.utc))
            self.assertEqual(entry.auto_checkout_at, datetime(2027, 7, 7, 16, 30, tzinfo=timezone.utc))
        self.assertEqual(self.member.shift_assignments.count(), 2)

    def test_weekly_conflicts_across_sunday_and_dated_assignments(self):
        member = {"member": self.member.pk}
        sunday = self.office.post(WEEKLY_URL, {**member, "shift": "N", "weekdays": [6]}, format="json")
        self.assertEqual(sunday.status_code, 201, sunday.data)
        conflicts = [
            (WEEKLY_URL, {**member, "shift": "M", "weekdays": [0]}),
            (ASSIGNMENTS_URL, {**member, "shift": "M", "shift_date": "2026-12-07"}),
        ]
        self.assign("E", "2026-12-24")
        conflicts.append((WEEKLY_URL, {**member, "shift": "M", "weekdays": [3]}))
        for path, payload in conflicts:
            response = self.office.post(path, payload, format="json")
            self.assertEqual(response.status_code, 400, response.data)
            self.assertIn("conflicting", response.data["detail"])

    def test_edit_and_end_weekly_schedule_keep_started_overnight_attendance(self):
        member = {"member": self.member.pk}
        saved = self.office.post(WEEKLY_URL, {**member, "shift": "N", "weekdays": [2, 4]}, format="json")
        self.assertEqual(saved.status_code, 201, saved.data)
        self.complete_profile()
        old_id = saved.data["id"]
        path = f"{WEEKLY_URL}{old_id}/"
        with patch("core.control_team.timezone.now", return_value=datetime(2026, 11, 12, 1, tzinfo=timezone.utc)):
            edited = self.office.patch(path, {**member, "shift": "N", "weekdays": [5]}, format="json")
            self.assertEqual(edited.status_code, 200, edited.data)
            checked_in = self.mark("check_in", weekly_assignment_id=old_id, shift_date="2026-11-11")
            self.assertEqual(checked_in.status_code, 200, checked_in.data)
            self.assertEqual(self.office.delete(f"{WEEKLY_URL}{edited.data['id']}/").status_code, 204)
            shifts = self.portal.get("/api/control/profile/").data["assigned_shifts"]
            self.assertEqual([(row["shift_date"], row["status"]) for row in shifts], [("2026-11-11", "Checked in")])
            entry = self.member.attendance.get()
            self.assertEqual(entry.scheduled_end_at, datetime(2026, 11, 12, 8, tzinfo=timezone.utc))
            self.assertEqual(self.mark("check_out", attendance_id=entry.pk).status_code, 200)

    def test_leave_and_replacement_requests_are_reviewed_by_admin(self):
        self.complete_profile()
        for kind, decision in [("LEAVE", "APPROVED"), ("REPLACEMENT", "REJECTED")]:
            response = self.portal.post("/api/control/requests/", {
                "kind": kind, "start_date": "2026-11-08", "end_date": "2026-11-08", "reason": "Personal appointment",
                "status": "APPROVED",
            }, format="json")
            self.assertEqual(response.status_code, 201, response.data)
            self.assertEqual(response.data["status"], "PENDING")
            request_id = response.data["id"]
            path = f"/api/control/team/requests/{request_id}/"
            self.assertEqual(self.portal.patch(path, {"status": decision}, format="json").status_code, 403)
            review = self.office.patch(path, {"status": decision, "review_note": "Office response"}, format="json")
            self.assertEqual(review.status_code, 200, review.data)
            self.assertEqual(review.data["status"], decision)
            self.assertEqual(self.office.patch(path, {"status": decision}, format="json").status_code, 409)
        member_requests = self.portal.get("/api/control/requests/").data
        self.assertEqual({item["status"] for item in member_requests}, {"APPROVED", "REJECTED"})
        self.assertTrue(all(item["review_note"] == "Office response" for item in member_requests))
        alerts = self.portal.get(NOTIFICATIONS_URL + "inbox/?category=LEAVE_REPLACEMENT").data["results"]
        self.assertEqual({item["title"] for item in alerts}, {
            "Leave request submitted", "Leave request approved", "Replacement request submitted", "Replacement request rejected",
        })
        self.assertTrue(all(item["context"]["control_tab"] == "requests" for item in alerts))
