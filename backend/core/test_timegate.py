from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import Employee, TimeGateCredential, UserProfile


class TimeGateTests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.admin = user_model.objects.create_user("timegate-admin")
        UserProfile.objects.create(user=self.admin, role=UserProfile.Role.ADMIN)
        self.guard = user_model.objects.create_user("timegate-guard")
        UserProfile.objects.create(user=self.guard, role=UserProfile.Role.EMPLOYEE)
        self.employee = Employee.objects.create(employee_id="TG-001", name="TimeGate Guard", user=self.guard)
        self.employee_url = f"/api/employees/{self.employee.pk}/"
        self.client.force_authenticate(self.admin)

    def test_admin_can_mark_a_site_and_add_a_pin_when_creating_an_employee(self):
        site = self.client.post("/api/sites/", {
            "site_id": "TG-SITE", "name": "TimeGate Site", "timegate_enabled": True,
        }, format="json")
        self.assertEqual(site.status_code, 201, site.data)
        self.assertTrue(site.data["timegate_enabled"])
        employee = self.client.post("/api/employees/", {
            "name": "New TimeGate Guard", "email": "timegate@example.test", "position": "Security Guard",
            "timegate_pin": "000735",
        }, format="json")
        self.assertEqual(employee.status_code, 201, employee.data)
        self.assertTrue(employee.data["timegate_pin_saved"])
        self.assertNotIn("timegate_pin", employee.data)
        self.assertNotEqual(TimeGateCredential.objects.get(employee_id=employee.data["id"]).encrypted_pin, "000735")

    def test_edit_pin_and_view_as_the_guard_without_site_activation(self):
        for pin in ["000735", "000809"]:
            updated = self.client.patch(self.employee_url, {"timegate_pin": pin}, format="json")
            self.assertEqual(updated.status_code, 200, updated.data)
            self.assertNotIn("timegate_pin", updated.data)
        self.assertEqual(TimeGateCredential.objects.filter(employee=self.employee).count(), 1)
        self.assertEqual(self.client.get("/api/employees/timegate/").status_code, 403)
        self.client.force_authenticate(self.guard)
        profile = self.client.get("/api/employees/me/").data
        self.assertTrue(profile["timegate_pin_saved"])
        self.assertNotIn("timegate_pin", profile)
        response = self.client.get("/api/employees/timegate/")
        self.assertEqual(response.data, {"pin": "000809"})
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertEqual(self.client.patch("/api/employees/me/", {"timegate_pin": "000001"}, format="json").status_code, 400)
        self.assertEqual(self.client.get("/api/employees/timegate/").data["pin"], "000809")
        self.employee.status = Employee.Status.INACTIVE
        self.employee.save(update_fields=["status"])
        self.assertEqual(self.client.get("/api/employees/timegate/").status_code, 404)

    def test_another_guard_cannot_read_the_pin(self):
        self.assertEqual(self.client.patch(self.employee_url, {"timegate_pin": "0071"}, format="json").status_code, 200)
        other = get_user_model().objects.create_user("another-timegate-guard")
        UserProfile.objects.create(user=other, role=UserProfile.Role.EMPLOYEE)
        Employee.objects.create(employee_id="TG-002", name="Other TimeGate Guard", user=other)
        self.client.force_authenticate(other)
        self.assertFalse(self.client.get("/api/employees/me/").data["timegate_pin_saved"])
        self.assertEqual(self.client.get("/api/employees/timegate/").status_code, 404)
