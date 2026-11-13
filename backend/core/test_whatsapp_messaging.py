from datetime import date, time
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import AuditLog, Employee, RotaAssignment, RotaWeek, ShiftType, Site, UserProfile
from .whatsapp import message_version, shift_key


class WhatsAppMessagingTests(APITestCase):
    def setUp(self):
        self.admin = self.user("office-admin", UserProfile.Role.ADMIN)
        self.client.force_authenticate(self.admin)
        self.guard = self.employee("A", "A Guard", "+447700900001")
        self.other_guard = self.employee("B", "B Guard", "+447700900002")
        self.no_number = self.employee("C", "C Guard", "")

    def user(self, username, role):
        user = get_user_model().objects.create_user(username)
        UserProfile.objects.create(user=user, role=role)
        return user

    def employee(self, code, name, number):
        return Employee.objects.create(employee_id=code, name=name, whatsapp_number=number)

    def make_week(self):
        week = RotaWeek.objects.create(week_start=date(2026, 11, 9), created_by=self.admin)
        shift = ShiftType.objects.create(name="Night shift", start_time=time(22), end_time=time(6))
        site = Site.objects.create(site_id="TEST", name="Test Site")
        return week, shift, site

    def assign(self, week, shift, site, guard, day):
        return RotaAssignment.objects.create(
            rota_week=week, shift_type=shift, site=site, employee=guard,
            work_date=day, created_by=self.admin,
        )

    def publish(self, week):
        response = self.client.post(f"/api/rota-weeks/{week.pk}/publish/", {}, format="json")
        self.assertEqual(response.status_code, 200, response.data)

    def rota_queue(self, week):
        response = self.client.get(f"/api/whatsapp/rota-weeks/{week.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "private, no-store")
        return {row["id"]: row for row in response.data["recipients"]}

    def mark(self, base, row, expected=200):
        response = self.client.post(
            f"{base}guards/{row['id']}/mark-sent/", {"version": row["version"]}, format="json",
        )
        self.assertEqual(response.status_code, expected, response.data)
        return response.data

    def test_whatsapp_number_is_optional_normalised_and_office_only(self):
        url = f"/api/employees/{self.guard.pk}/"
        updated = self.client.patch(url, {"whatsapp_number": "0044 (7700) 900012"}, format="json")
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["whatsapp_number"], "+447700900012")
        self.assertEqual(self.client.patch(url, {"whatsapp_number": "07700900012"}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(url, {"whatsapp_number": ""}, format="json").data["whatsapp_number"], "")
        user = self.user("my-guard-account", UserProfile.Role.EMPLOYEE)
        self.guard.user = user
        self.guard.save(update_fields=["user"])
        self.client.force_authenticate(user)
        self.assertNotIn("whatsapp_number", self.client.get("/api/employees/me/").data)
        self.assertEqual(self.client.patch("/api/employees/me/", {"whatsapp_number": "+447700900055"}, format="json").status_code, 400)

    def test_announcement_for_150_guards_preserves_exact_text_and_progress(self):
        extras = Employee.objects.bulk_create([
            Employee(employee_id=f"TEST-{i}", name=f"Test Guard {i:03}", whatsapp_number=f"+44770091{i:04}")
            for i in range(147)
        ])
        ids = [self.guard.pk, self.other_guard.pk, self.no_number.pk, *(guard.pk for guard in extras)]
        message = "Team briefing at 18:00.\nBring ID & radio. شکریہ"
        created = self.client.post("/api/whatsapp/announcements/", {
            "title": "Team briefing", "message": message, "employee_ids": [*ids, self.guard.pk],
        }, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        url = f"/api/whatsapp/announcements/{created.data['id']}/"
        queue = self.client.get(url)
        self.assertEqual(queue["Cache-Control"], "private, no-store")
        rows = {row["id"]: row for row in queue.data["recipients"]}
        self.assertEqual(len(rows), 150)
        self.assertIsNone(rows[self.no_number.pk]["whatsapp_url"])
        self.assertEqual(rows[self.no_number.pk]["status"], "NUMBER_MISSING")
        for guard, number in [(self.guard, "447700900001"), (self.other_guard, "447700900002")]:
            link = urlsplit(rows[guard.pk]["whatsapp_url"])
            self.assertEqual((link.scheme, link.netloc, link.path), ("https", "wa.me", "/" + number))
            self.assertEqual(parse_qs(link.query), {"text": [message]})
            self.assertEqual(rows[guard.pk]["status"], "PENDING")
        row = rows[self.guard.pk]
        first = self.mark(url, row)
        repeated = self.mark(url, row)
        self.assertEqual(first["sent_at"], repeated["sent_at"])
        self.assertEqual(first["sent_by"], self.admin.username)
        self.assertEqual(first["status"], "SENT")
        self.assertIsNone(first["whatsapp_url"])
        self.assertEqual(AuditLog.objects.filter(action="WHATSAPP_SENT").count(), 1)
        history = self.client.get("/api/whatsapp/announcements/").data
        self.assertEqual((history[0]["total"], history[0]["sent"]), (150, 1))
        self.assertEqual(sum(item["status"] == "PENDING" for item in self.client.get(url).data["recipients"]), 148)

    def test_stale_recipient_number_and_outside_selection_are_rejected(self):
        created = self.client.post("/api/whatsapp/announcements/", {
            "title": "Notice", "message": "Test notice", "employee_ids": [self.guard.pk],
        }, format="json")
        url = f"/api/whatsapp/announcements/{created.data['id']}/"
        row = self.client.get(url).data["recipients"][0]
        self.mark(url, {**row, "id": self.other_guard.pk}, expected=404)
        self.client.patch(f"/api/employees/{self.guard.pk}/", {"whatsapp_number": "+447700900090"}, format="json")
        self.mark(url, row, expected=409)
        self.assertEqual(self.client.get(url).data["recipients"][0]["status"], "PENDING")

    def test_only_admin_roles_can_access_whatsapp_endpoints(self):
        week, _, _ = self.make_week()
        for role in (UserProfile.Role.EMPLOYEE, UserProfile.Role.MANAGER, UserProfile.Role.CLIENT_ADMIN):
            self.client.force_authenticate(self.user(f"test-{role}", role))
            for path in ("/api/whatsapp/guards/", "/api/whatsapp/announcements/", f"/api/whatsapp/rota-weeks/{week.pk}/"):
                self.assertEqual(self.client.get(path).status_code, 403)
            self.assertEqual(self.client.post("/api/whatsapp/announcements/", {}, format="json").status_code, 403)

    @patch.dict("os.environ", {"FRONTEND_URL": "https://rota.example.com/"})
    def test_weekly_rota_message_matches_the_template_in_preview_and_whatsapp(self):
        week, _, site = self.make_week()
        shift, _ = ShiftType.objects.get_or_create(
            name="Day Shift", defaults={"start_time": time(7), "end_time": time(19)},
        )
        for day in (13, 9, 10):
            assignment = self.assign(week, shift, site, self.guard, date(2026, 11, day))
            assignment.scheduled_start, assignment.scheduled_end = time(6, 30), time(18, 30)
            assignment.save(update_fields=["scheduled_start", "scheduled_end"])
        self.publish(week)

        row = self.rota_queue(week)[self.guard.pk]
        expected = (
            "Hi A Guard,\n\n"
            "*Rota for the Week*\n*Week Commencing: 9th November 2026*\n\n"
            "*Site:* Test Site\n*Shift Hour:* 0630-1830 Day Shift\n*Days:* Monday, Tuesday, Friday\n\n"
            "Total Shifts: 3\nTotal Hours: 36\n\n"
            "Please open the Guard Portal and select *Confirm rota*.\n"
            "https://rota.example.com/guard?page=rota&week_start=2026-11-09\n\n"
            "Thank you.\nControl Room"
        )
        self.assertEqual(row["message"], expected)
        self.assertEqual(parse_qs(urlsplit(row["whatsapp_url"]).query), {"text": [expected]})
        confirm_url = urlsplit(next(line for line in row["message"].splitlines() if line.startswith("https://")))
        linked_week = parse_qs(confirm_url.query)["week_start"][0]
        guard_user = self.user("rota-link-guard", UserProfile.Role.EMPLOYEE)
        self.guard.user = guard_user
        self.guard.save(update_fields=["user"])
        self.client.force_authenticate(guard_user)
        schedule = self.client.get("/api/rota-weeks/my/", {"week_start": linked_week}).data
        self.assertEqual([result["rota_week"]["id"] for result in schedule], [week.pk])
        confirmation = self.client.post(f"/api/rota-weeks/{week.pk}/confirm/", {}, format="json")
        self.assertEqual(confirmation.data["status"], "CONFIRMED")

    @patch.dict("os.environ", {"FRONTEND_URL": "https://rota.example.com"})
    def test_rota_changes_only_flag_affected_guards_and_cancelled_shifts(self):
        week, shift, site = self.make_week()
        mon, tue = date(2026, 11, 9), date(2026, 11, 10)
        assignment = self.assign(week, shift, site, self.guard, mon)
        self.assign(week, shift, site, self.other_guard, tue)
        self.assertEqual(self.rota_queue(week), {})
        self.publish(week)
        rows = self.rota_queue(week)
        self.assertIn("*Shift Hour:* 2200-0600 Night shift (next day)\n*Days:* Monday", rows[self.guard.pk]["message"])
        self.assertNotIn("Tuesday", rows[self.guard.pk]["message"])
        base = f"/api/whatsapp/rota-weeks/{week.pk}/"
        for row in rows.values():
            self.mark(base, row)
        legacy_share = week.whatsapp_shares.get(employee=self.other_guard)
        for shift_record in legacy_share.shifts:
            shift_record.pop("shift_name")
        legacy_share.version = message_version(
            week.pk, week.week_start.isoformat(), self.other_guard.pk, self.other_guard.name,
            self.other_guard.whatsapp_number,
            [shift_key(record, include_name=False) for record in legacy_share.shifts],
        )
        legacy_share.save(update_fields=["shifts", "version"])
        self.assertEqual(self.client.post(f"/api/rota-weeks/{week.pk}/reopen/").status_code, 200)
        self.assertEqual(self.rota_queue(week), {})
        self.mark(base, rows[self.guard.pk], expected=409)
        assignment.scheduled_start = time(21, 30)
        assignment.save(update_fields=["scheduled_start"])
        self.publish(week)
        refreshed = self.rota_queue(week)
        updated = refreshed[self.guard.pk]
        self.assertEqual(refreshed[self.other_guard.pk]["status"], "SENT")
        self.assertEqual(updated["status"], "UPDATE_PENDING")
        self.assertIn("*Updated Rota for the Week*", updated["message"])
        self.assertIn("Changed: Mon 09 Nov | 22:00", updated["message"])
        self.assertIn("*Shift Hour:* 2130-0600 Night shift (next day)\n*Days:* Monday", updated["message"])
        self.assertIn("/guard?page=rota&week_start=2026-11-09", updated["message"])
        self.assertIn("Total Shifts: 1\nTotal Hours: 8.5", updated["message"])
        self.mark(base, rows[self.guard.pk], expected=409)
        self.mark(base, updated)
        self.assertEqual(self.client.post(f"/api/rota-weeks/{week.pk}/reopen/").status_code, 200)
        assignment.delete()
        self.publish(week)
        cancelled = self.rota_queue(week)[self.guard.pk]
        self.assertEqual(cancelled["status"], "UPDATE_PENDING")
        self.assertIn("Cancelled:", cancelled["message"])
        self.assertIn("You have no assigned shifts for this week.", cancelled["message"])
        self.assertIn("Total Shifts: 0\nTotal Hours: 0", cancelled["message"])
        self.assertNotIn("Confirm rota", cancelled["message"])

    def test_last_shift_can_be_published_as_a_cancellation_after_sharing(self):
        week, shift, site = self.make_week()
        self.assertEqual(self.client.post(f"/api/rota-weeks/{week.pk}/publish/").status_code, 400)
        assignment = self.assign(week, shift, site, self.guard, week.week_start)
        self.publish(week)
        self.mark(f"/api/whatsapp/rota-weeks/{week.pk}/", self.rota_queue(week)[self.guard.pk])
        self.assertEqual(self.client.post(f"/api/rota-weeks/{week.pk}/reopen/").status_code, 200)
        assignment.delete()
        self.publish(week)
        self.assertIn("Cancelled:", self.rota_queue(week)[self.guard.pk]["message"])
