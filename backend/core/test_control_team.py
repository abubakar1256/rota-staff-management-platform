from datetime import datetime, timezone
from io import BytesIO
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from PIL import Image
from rest_framework.test import APIClient

from .models import ControlAttendance, ControlTeamMember, Employee, UserProfile


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

    def complete_profile(self):
        buffer = BytesIO()
        Image.new("RGB", (35, 45), "blue").save(buffer, format="PNG")
        response = self.portal.put("/api/control/profile/", {
            "name": "Control Member", "phone": "01234567890",
            "photo": SimpleUploadedFile("portrait.png", buffer.getvalue(), content_type="image/png"),
        }, format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["profile_complete"])
        return response.data["photo_url"]

    def mark(self, action):
        return self.portal.post("/api/control/attendance/", {"action": action}, format="json")

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
        with patch("core.control_team.timezone.now", return_value=start):
            for _ in range(2):
                self.assertEqual(self.mark("check_in").status_code, 200)
            listing = self.office.get("/api/control/team/").data
            self.assertEqual(listing[0]["checked_in_at"], start)
            self.assertEqual(self.member.attendance.count(), 1)
        end = start.replace(hour=10, minute=32)
        with patch("core.control_team.timezone.now", return_value=end):
            for _ in range(2):
                response = self.mark("check_out")
                self.assertIsNone(response.data["checked_in_at"])
                self.assertEqual(response.data["weekly_seconds"], 92 * 60)
                self.assertEqual(response.data["monthly_seconds"], 92 * 60)
        self.assertEqual(self.member.attendance.get().checked_out_at, end)

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
        self.assertEqual(self.portal.get("/api/control/profile/").status_code, 401)
        self.assertEqual(self.portal.post("/api/control/login/", self.credentials, format="json").status_code, 400)
        self.assertEqual(self.office.patch(path, {"is_active": True}, format="json").status_code, 200)
        self.assertEqual(self.portal.post("/api/control/login/", self.credentials, format="json").status_code, 200)
        self.assertEqual(self.member.attendance.count(), 1)

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
