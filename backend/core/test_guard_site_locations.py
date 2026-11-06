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
