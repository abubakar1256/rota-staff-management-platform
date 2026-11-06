from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import CortexITimeCredential, Employee, Site, UserProfile


class CortexITimeTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user("cortex-office")
        UserProfile.objects.create(user=self.admin, role=UserProfile.Role.ADMIN)
        self.guard = get_user_model().objects.create_user("cortex-guard", password="guard-login-only")
        UserProfile.objects.create(user=self.guard, role=UserProfile.Role.EMPLOYEE)
        self.employee = Employee.objects.create(employee_id="CORTEX-01", name="Example Guard", user=self.guard)
        self.first = Site.objects.create(site_id="CORTEX-A", name="First Site", cortex_itime_enabled=True)
        self.second = Site.objects.create(site_id="CORTEX-B", name="Second Site", cortex_itime_enabled=True)
        self.ordinary = Site.objects.create(site_id="OTHER", name="Ordinary Site")
        self.client.force_authenticate(self.admin)

    def grant(self, site, pin=None):
        data = {"cortex_itime_enabled": True, "cortex_itime_site": site.pk}
        if pin is not None:
            data["cortex_itime_pin"] = pin
        return self.client.patch(f"/api/employees/{self.employee.pk}/", data, format="json")

    def induct(self, site, status="PLANNED"):
        return self.client.post("/api/site-inductions/", {
            "site": site.pk, "employee": self.employee.pk, "induction_date": timezone.localdate(), "status": status,
        }, format="json")

    def test_admin_can_enable_site_and_set_pin_when_creating_employee(self):
        site = self.client.post("/api/sites/", {
            "site_id": "CORTEX-C", "name": "New Site", "cortex_itime_enabled": True,
        }, format="json")
        self.assertEqual(site.status_code, 201, site.data)
        self.assertTrue(site.data["cortex_itime_enabled"])
        employee = self.client.post("/api/employees/", {
            "name": "New Guard", "email": "newguard@example.test", "position": "Security Guard",
            "cortex_itime_enabled": True, "cortex_itime_site": site.data["id"], "cortex_itime_pin": "001234",
        }, format="json")
        self.assertEqual(employee.status_code, 201, employee.data)
        self.assertNotIn("cortex_itime_pin", employee.data)
        self.assertTrue(employee.data["cortex_itime_pin_saved"])
        self.assertEqual(employee.data["cortex_itime_sites"], [{"id": site.data["id"], "name": "New Site", "active": True}])
        entry = CortexITimeCredential.objects.get(employee_id=employee.data["id"])
        self.assertNotEqual(entry.encrypted_pin, "001234")

    def test_guard_reads_only_own_active_site_pins(self):
        self.assertEqual(self.grant(self.first, "0042").status_code, 200)
        self.assertEqual(self.grant(self.second).status_code, 200)
        self.assertEqual(self.client.get("/api/employees/cortex-itime/").status_code, 403)
        self.second.cortex_itime_enabled = False
        self.second.save(update_fields=["cortex_itime_enabled"])
        other = get_user_model().objects.create_user("other-guard")
        UserProfile.objects.create(user=other, role=UserProfile.Role.EMPLOYEE)
        Employee.objects.create(employee_id="CORTEX-02", name="Other Guard", user=other)
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get("/api/employees/cortex-itime/").status_code, 404)
        self.client.force_authenticate(self.guard)
        response = self.client.get("/api/employees/cortex-itime/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertEqual(response.data, {"pin": "0042", "sites": [{"name": "First Site", "site_id": "CORTEX-A"}]})
        self.assertEqual(self.client.get("/api/employees/me/").data["cortex_itime_sites"], [])
        self.assertEqual(self.client.patch("/api/employees/me/", {"cortex_itime_enabled": False}, format="json").status_code, 400)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.patch(f"/api/employees/{self.employee.pk}/", {"cortex_itime_enabled": False}, format="json").status_code, 200)
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get("/api/employees/cortex-itime/").status_code, 404)

    def test_induction_warning_tracks_activation_for_target_site(self):
        self.assertEqual(self.grant(self.first, "0042").status_code, 200)
        self.assertFalse(self.induct(self.first).data["cortex_activation_required"])
        self.assertFalse(self.induct(self.ordinary).data["cortex_activation_required"])
        result = self.induct(self.second)
        self.assertEqual(result.status_code, 201, result.data)
        self.assertTrue(result.data["cortex_activation_required"])
        activation = self.grant(self.second)
        self.assertEqual(activation.status_code, 200, activation.data)
        self.assertEqual(len(activation.data["cortex_itime_sites"]), 2)
        self.assertEqual(self.grant(self.second).status_code, 200)
        credential = CortexITimeCredential.objects.get(employee=self.employee)
        self.assertEqual(credential.sites.count(), 2)
        refreshed = self.client.get(f"/api/site-inductions/{result.data['id']}/")
        self.assertFalse(refreshed.data["cortex_activation_required"])
        self.client.force_authenticate(self.guard)
        self.assertEqual(self.client.get("/api/employees/cortex-itime/").data, {
            "pin": "0042", "sites": [{"name": "First Site", "site_id": "CORTEX-A"}, {"name": "Second Site", "site_id": "CORTEX-B"}],
        })

    def test_admin_can_edit_saved_pin_without_changing_site_activations(self):
        self.assertEqual(self.grant(self.first, "0042").status_code, 200)
        self.assertEqual(self.grant(self.second).status_code, 200)
        self.client.force_authenticate(self.guard)
        denied = self.client.patch("/api/employees/me/", {"cortex_itime_pin": "0069"}, format="json")
        self.assertEqual(denied.status_code, 400)

        self.client.force_authenticate(self.admin)
        updated = self.client.patch(f"/api/employees/{self.employee.pk}/", {"cortex_itime_pin": "0069"}, format="json")
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertNotIn("cortex_itime_pin", updated.data)
        self.assertEqual(len(updated.data["cortex_itime_sites"]), 2)
        credential = CortexITimeCredential.objects.get(employee=self.employee)
        self.assertNotEqual(credential.encrypted_pin, "0069")

        self.client.force_authenticate(self.guard)
        access = self.client.get("/api/employees/cortex-itime/").data
        self.assertEqual(access["pin"], "0069")
        self.assertEqual([site["site_id"] for site in access["sites"]], ["CORTEX-A", "CORTEX-B"])

    def test_invalid_site_or_incomplete_activation_is_rejected(self):
        self.assertEqual(self.grant(self.ordinary, "0042").status_code, 400)
        self.assertEqual(self.grant(self.first).status_code, 400)
        self.assertEqual(self.grant(self.first, "not-a-pin").status_code, 400)
        result = self.client.patch(f"/api/employees/{self.employee.pk}/", {"cortex_itime_enabled": True}, format="json")
        self.assertEqual(result.status_code, 400)
        self.assertFalse(CortexITimeCredential.objects.filter(employee=self.employee).exists())
