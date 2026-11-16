import csv
from datetime import date, time

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import DailyOperation, Employee, RotaAssignment, RotaWeek, ShiftType, Site, SiteInduction, UserProfile


class GuardSiteLocationTests(APITestCase):
    def setUp(self):
        users = get_user_model().objects
        self.admin = users.create_user(username="site-location-office", is_superuser=True)
        self.guard = users.create_user(username="site-location-guard")
        self.other = users.create_user(username="site-location-other")
        for user in (self.guard, self.other):
            UserProfile.objects.update_or_create(user=user, defaults={"role": UserProfile.Role.EMPLOYEE})
        self.employee = Employee.objects.create(employee_id="PIN-1", name="Assigned guard", user=self.guard)
        self.other_employee = Employee.objects.create(employee_id="PIN-2", name="Other guard", user=self.other)
        self.site = Site.objects.create(site_id="PIN", name="Main site", address="1 Example Road, London")
        self.day = date(2026, 11, 6)
        self.induction = SiteInduction.objects.create(
            site=self.site, employee=self.employee, induction_date=self.day, induction_time=time(9, 30),
            created_by=self.admin, notes="Office-only note",
        )

    def test_guard_can_read_only_their_own_induction_schedule(self):
        other_site = Site.objects.create(site_id="OTHER-PIN", name="Other site")
        SiteInduction.objects.create(
            site=other_site, employee=self.other_employee, induction_date=self.day, created_by=self.admin,
        )
        self.client.force_authenticate(self.guard)
        response = self.client.get(f"/api/site-inductions/my/?employee={self.other_employee.pk}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["id"] for row in response.data], [self.induction.pk])
        self.assertEqual(response.data[0]["induction_time"], "09:30:00")
        self.assertNotIn("notes", response.data[0])
        self.assertIsNone(response.data[0]["site_latitude"])
        self.assertEqual(self.client.patch(f"/api/site-inductions/{self.induction.pk}/", {"status": "COMPLETED"}).status_code, 403)
        self.assertEqual(self.client.post("/api/site-inductions/my/", {}).status_code, 405)

    def test_updated_site_pin_reaches_existing_guard_rota_attendance_and_induction(self):
        week = RotaWeek.objects.create(week_start=date(2026, 11, 2), status=RotaWeek.Status.PUBLISHED, created_by=self.admin)
        shift = ShiftType.objects.create(name="Pin day shift", start_time=time(8), end_time=time(20))
        RotaAssignment.objects.create(
            rota_week=week, work_date=self.day, site=self.site, employee=self.employee,
            shift_type=shift, created_by=self.admin,
        )
        operation = DailyOperation.objects.create(
            operation_date=self.day, site=self.site, employee=self.employee, shift_type=shift, created_by=self.admin,
        )

        self.client.force_authenticate(self.admin)
        edit = self.client.patch(f"/api/sites/{self.site.pk}/", {
            "latitude": 51.507462, "longitude": -0.127816, "address": "2 Example Road, London",
        }, format="json")
        self.assertEqual(edit.status_code, 200, edit.data)

        self.client.force_authenticate(self.guard)
        rota = self.client.get("/api/rota-weeks/my/?week_start=2026-11-02")
        attendance = self.client.get(f"/api/operations/{operation.pk}/")
        induction = self.client.get("/api/site-inductions/my/")
        for response in (rota, attendance, induction):
            self.assertEqual(response.status_code, 200, response.data)
        for row in (rota.data[0]["assignments"][0], attendance.data, induction.data[0]):
            self.assertEqual(row["site_address"], "2 Example Road, London")
            self.assertEqual(row["site_latitude"], 51.507462)
            self.assertEqual(row["site_longitude"], -0.127816)

    def test_induction_csv_uses_latest_saved_profile_phone(self):
        url = f"/api/site-inductions/{self.induction.pk}/download-csv/"
        self.employee.phone = "+447700900123"
        self.employee.whatsapp_number = "+447700900345"
        self.employee.save(update_fields=["phone", "whatsapp_number"])

        def download_phone():
            self.client.force_authenticate(self.admin)
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response["Cache-Control"], "private, no-store")
            rows = csv.DictReader(response.content.decode("utf-8-sig").splitlines())
            return next(row["Value"] for row in rows if row["Field"] == "Contact Number")

        self.assertEqual(download_phone(), "+447700900123")
        self.client.force_authenticate(self.guard)
        update = self.client.patch("/api/employees/me/", {"phone": "+447700900456"}, format="json")
        self.assertEqual(update.status_code, 200, update.data)
        self.assertEqual(update.data["phone"], "+447700900456")
        self.assertEqual(download_phone(), "+447700900456")

    def test_induction_status_updates_existing_guard_and_rota_eligibility(self):
        self.client.force_authenticate(self.admin)
        week = RotaWeek.objects.create(week_start=date(2026, 11, 2), created_by=self.admin)
        url = f"/api/site-inductions/{self.induction.pk}/"
        rota_url = f"/api/rota-weeks/{week.pk}/inducted_guards/"

        def inducted_ids():
            response = self.client.post(rota_url, {"site": self.site.pk}, format="json")
            self.assertEqual(response.status_code, 200, response.data)
            return [guard["id"] for guard in response.data]

        self.assertEqual(inducted_ids(), [])
        response = self.client.patch(url, {
            "status": "COMPLETED", "induction_date": "2026-11-07", "induction_time": None, "notes": "Induction attended.",
        }, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["id"], self.induction.pk)
        self.assertEqual(response.data["notes"], "Induction attended.")
        self.assertEqual(inducted_ids(), [self.employee.pk])

        self.client.force_authenticate(self.guard)
        visible = self.client.get("/api/site-inductions/my/").data[0]
        self.assertEqual(visible["status"], "COMPLETED")
        self.assertEqual(visible["induction_date"], "2026-11-07")
        self.assertIsNone(visible["induction_time"])

        self.client.force_authenticate(self.admin)
        for status in ("CANCELLED", "PLANNED"):
            response = self.client.patch(url, {"status": status}, format="json")
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data["status"], status)
            self.assertEqual(inducted_ids(), [])
