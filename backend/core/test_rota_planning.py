from datetime import date, time, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import DailyOperation, Employee, GuardUnavailability, LeaveRecord, Notification, RotaAssignment, RotaConfirmation, RotaWeek, ShiftType, Site, SiteInduction, SiteShiftRequirement, UserProfile


class RotaPlanningTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user(username="planner", is_superuser=True)
        self.client.force_authenticate(self.admin)
        self.monday = date(2026, 11, 16)
        self.week = RotaWeek.objects.create(week_start=self.monday, created_by=self.admin)
        self.site = Site.objects.create(site_id="PL-1", name="Century Court", required_guards=1)
        self.other_site = Site.objects.create(site_id="PL-2", name="West Gate", required_guards=1)
        self.day = ShiftType.objects.create(name="Planner Day", start_time=time(7), end_time=time(19))
        self.night = ShiftType.objects.create(name="Planner Night", start_time=time(19), end_time=time(8))
        self.guard = Employee.objects.create(employee_id="PL-G1", name="Riley Guard")
        self.cover = Employee.objects.create(employee_id="PL-G2", name="Casey Cover")
        for employee in (self.guard, self.cover):
            for site in (self.site, self.other_site):
                SiteInduction.objects.create(site=site, employee=employee, induction_date=self.monday,
                    status=SiteInduction.Status.COMPLETED, created_by=self.admin)
        for path in (
            "core.rota_planning.employee_compliance_issues", "core.views.employee_compliance_issues",
            "core.rota_replacement.employee_compliance_issues",
            "core.serializers.employee_compliance_issues", "core.views.generate_daily_arrival_reports",
        ):
            mock = patch(path, return_value=[])
            mock.start()
            self.addCleanup(mock.stop)

    def post(self, action, **payload):
        return self.client.post(f"/api/rota-weeks/{self.week.pk}/{action}/", payload, format="json")

    def add_shift(self, employee, day, *, week=None, site=None, shift=None):
        return RotaAssignment.objects.create(
            rota_week=week or self.week, site=site or self.site, shift_type=shift or self.day,
            employee=employee, work_date=day, created_by=self.admin,
        )

    def test_multi_day_preview_saves_only_eligible_dates_and_checks_overnight(self):
        tuesday = self.monday + timedelta(days=1)
        wednesday = tuesday + timedelta(days=1)
        self.add_shift(self.guard, self.monday, site=self.other_site, shift=self.night)
        GuardUnavailability.objects.create(employee=self.guard, work_date=wednesday)
        request = {"site": self.site.pk, "shift_type": self.day.pk, "employee": self.guard.pk,
                   "dates": [str(tuesday), str(wednesday), str(wednesday + timedelta(days=1))]}
        preview = self.post("assign_days", **request, preview=True)
        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data["ready"], 1)
        self.assertIn("West Gate", preview.data["rows"][0]["reason"])
        self.assertIn("unavailable", preview.data["rows"][1]["reason"])
        self.assertEqual(RotaAssignment.objects.count(), 1)
        saved = self.post("assign_days", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(saved.data["created"], 1)
        self.assertEqual(RotaAssignment.objects.get(site=self.site).work_date, wednesday + timedelta(days=1))

    def test_copy_selected_sites_preserves_target_and_skips_approved_leave(self):
        target_date = self.monday + timedelta(days=7)
        target = RotaWeek.objects.create(week_start=target_date, created_by=self.admin)
        existing = self.add_shift(self.cover, target_date, week=target)
        for offset in range(3):
            self.add_shift(self.guard, self.monday + timedelta(days=offset))
        self.add_shift(self.guard, self.monday, site=self.other_site, shift=self.night)
        LeaveRecord.objects.create(employee=self.guard, status=LeaveRecord.Status.APPROVED,
                                   start_date=target_date + timedelta(days=1),
                                   end_date=target_date + timedelta(days=1), created_by=self.admin)
        request = {"week_start": str(target_date), "site_ids": [self.site.pk]}
        preview = self.post("copy_to", **request, preview=True)
        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual([row["status"] for row in preview.data["rows"]], ["preserved", "skipped", "ready"])
        self.assertIn("approved leave", preview.data["rows"][1]["reason"])
        self.assertEqual(target.assignments.count(), 1)
        saved = self.post("copy_to", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(saved.data["created"], 1)
        self.assertTrue(target.assignments.filter(pk=existing.pk).exists())
        self.assertEqual(target.assignments.count(), 2)
        retry = self.post("copy_to", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(target.assignments.count(), 2)

    def test_copy_preview_does_not_create_a_week_and_commit_creates_draft(self):
        self.add_shift(self.guard, self.monday)
        next_week = str(self.monday + timedelta(days=7))
        preview = self.post("copy_to", week_start=next_week, preview=True)
        self.assertEqual(preview.data["ready"], 1)
        self.assertFalse(RotaWeek.objects.filter(week_start=next_week).exists())
        saved = self.post("copy_to", week_start=next_week, preview_key=preview.data["preview_key"])
        self.assertEqual(saved.data["created"], 1)
        self.assertEqual(RotaWeek.objects.get(week_start=next_week).status, RotaWeek.Status.DRAFT)

    def test_find_cover_filters_ineligible_guards_and_rechecks_open_position(self):
        GuardUnavailability.objects.create(employee=self.guard, work_date=self.monday)
        slot = {"site": self.site.pk, "shift_type": self.day.pk, "work_date": str(self.monday)}
        response = self.post("eligible_guards", **slot)
        self.assertEqual([row["id"] for row in response.data], [self.cover.pk])
        request = {"site": self.site.pk, "shift_type": self.day.pk, "dates": [str(self.monday)],
                   "employee": self.cover.pk, "cover_only": True}
        preview = self.post("assign_days", **request, preview=True)
        self.assertEqual(preview.data["ready"], 1)
        self.add_shift(self.guard, self.monday)
        changed = self.post("assign_days", **request, preview_key=preview.data["preview_key"])
        self.assertEqual(changed.status_code, 409)
        self.assertIn("already covered", changed.data["rows"][0]["reason"])
        self.assertEqual(RotaAssignment.objects.count(), 1)

    def test_bulk_guard_list_shows_only_active_inducted_guards_with_blockers(self):
        leave = Employee.objects.create(employee_id="PL-G3", name="On Leave")
        overlap = Employee.objects.create(employee_id="PL-G4", name="Already Booked")
        other_site_only = Employee.objects.create(employee_id="PL-G5", name="Other Site Guard")
        inactive = Employee.objects.create(employee_id="PL-G6", name="Inactive Guard", status=Employee.Status.INACTIVE)
        for employee, site, induction_status in (
            (leave, self.site, SiteInduction.Status.COMPLETED),
            (overlap, self.site, SiteInduction.Status.COMPLETED),
            (other_site_only, self.other_site, SiteInduction.Status.COMPLETED),
            (other_site_only, self.site, SiteInduction.Status.PLANNED),
            (inactive, self.site, SiteInduction.Status.COMPLETED),
        ):
            SiteInduction.objects.create(site=site, employee=employee, induction_date=self.monday,
                status=induction_status, created_by=self.admin)
        GuardUnavailability.objects.create(employee=self.guard, work_date=self.monday)
        LeaveRecord.objects.create(employee=leave, status=LeaveRecord.Status.APPROVED,
                                   start_date=self.monday, end_date=self.monday, created_by=self.admin)
        self.add_shift(overlap, self.monday, site=self.other_site)

        inducted = self.post("inducted_guards", site=self.site.pk)
        self.assertEqual(inducted.status_code, 200, inducted.data)
        self.assertEqual({row["id"] for row in inducted.data}, {self.guard.pk, self.cover.pk, leave.pk, overlap.pk})
        result = self.post("eligible_guards", site=self.site.pk, shift_type=self.day.pk,
                           work_date=str(self.monday), include_blocked=True)
        self.assertEqual(result.status_code, 200, result.data)
        rows = {row["id"]: row["blocked_reason"] for row in result.data}
        self.assertEqual(rows.keys(), {row["id"] for row in inducted.data})
        self.assertIn("unavailable", rows[self.guard.pk])
        self.assertIn("approved leave", rows[leave.pk])
        self.assertIn(self.other_site.name, rows[overlap.pk])
        self.assertEqual(rows[self.cover.pk], "")
        self.assertEqual(RotaAssignment.objects.count(), 1)

    def future_week(self):
        today = timezone.localdate()
        self.monday = today + timedelta(days=7 - today.weekday())
        self.week.week_start = self.monday
        self.week.save(update_fields=["week_start"])

    def extra_guard(self, name, *sites):
        guard = Employee.objects.create(employee_id=name.upper(), name=name,
                                        user=get_user_model().objects.create_user(username=name.lower()))
        for site in sites:
            SiteInduction.objects.create(site=site, employee=guard, induction_date=self.monday,
                status=SiteInduction.Status.COMPLETED, created_by=self.admin)
        return guard

    def test_replacement_preserves_published_rota_and_only_resets_affected_confirmations(self):
        self.future_week()
        leaving = self.extra_guard("Leaving", self.site)
        untouched = self.extra_guard("Untouched", self.site)
        self.cover.user = get_user_model().objects.create_user(username="cover")
        self.cover.save(update_fields=["user"])
        target = self.add_shift(leaving, self.monday)
        self.add_shift(untouched, self.monday + timedelta(days=1))
        self.week.status = RotaWeek.Status.PUBLISHED
        self.week.save(update_fields=["status"])
        for guard in (leaving, untouched):
            RotaConfirmation.objects.create(rota_week=self.week, employee=guard, status="CONFIRMED")
        DailyOperation.objects.create(operation_date=self.monday, site=self.site, shift_type=self.day,
                                      employee=leaving, created_by=self.admin)
        leave = LeaveRecord.objects.create(employee=leaving, start_date=self.monday, end_date=self.monday,
                                           status=LeaveRecord.Status.APPROVED, created_by=self.admin)
        queue = self.client.get(f"/api/rota-weeks/{self.week.pk}/leave_cover/")
        self.assertEqual([row["id"] for row in queue.data], [target.pk])
        preview = self.post("find_replacement", assignment=target.pk)
        self.assertEqual(preview.status_code, 200, preview.data)
        plan = next(row for row in preview.data["options"] if row["kind"] == "direct" and row["rows"][0]["guard_id"] == self.cover.pk)
        target.refresh_from_db()
        self.assertEqual(target.employee, leaving)
        saved = self.post("find_replacement", assignment=target.pk, plan=plan["id"])
        self.assertEqual(saved.status_code, 200, saved.data)
        self.week.refresh_from_db()
        target.refresh_from_db()
        leave.refresh_from_db()
        self.assertEqual(self.week.status, RotaWeek.Status.PUBLISHED)
        self.assertEqual(leave.status, LeaveRecord.Status.APPROVED)
        self.assertEqual(target.employee, self.cover)
        self.assertEqual(self.week.confirmations.get(employee=untouched).status, "CONFIRMED")
        self.assertEqual(self.week.confirmations.get(employee=self.cover).status, "PENDING")
        self.assertFalse(self.week.confirmations.filter(employee=leaving).exists())
        self.assertEqual(set(Notification.objects.values_list("user_id", flat=True)), {leaving.user_id, self.cover.user_id})
        self.assertFalse(DailyOperation.objects.filter(employee=leaving).exists())
        self.assertTrue(DailyOperation.objects.filter(employee=self.cover, site=self.site).exists())
        self.assertEqual(self.post("find_replacement", assignment=target.pk, plan=plan["id"]).status_code, 409)

    def test_guard_cannot_confirm_an_outdated_view_of_a_replaced_rota(self):
        self.future_week()
        leaving = self.extra_guard("Leaving", self.site)
        UserProfile.objects.create(user=leaving.user, role=UserProfile.Role.EMPLOYEE)
        target = self.add_shift(leaving, self.monday)
        self.add_shift(leaving, self.monday + timedelta(days=1))
        self.week.status = RotaWeek.Status.PUBLISHED
        self.week.save(update_fields=["status"])
        self.client.force_authenticate(leaving.user)
        old = self.client.get(f"/api/rota-weeks/my/?week_start={self.monday}").data[0]["schedule_version"]
        self.client.force_authenticate(self.admin)
        preview = self.post("find_replacement", assignment=target.pk)
        plan = preview.data["options"][0]
        self.assertEqual(self.post("find_replacement", assignment=target.pk, plan=plan["id"]).status_code, 200)
        self.client.force_authenticate(leaving.user)
        self.assertEqual(self.post("confirm", schedule_version=old).status_code, 409)
        current = self.client.get(f"/api/rota-weeks/my/?week_start={self.monday}").data[0]["schedule_version"]
        self.assertEqual(self.post("confirm", schedule_version=current).status_code, 200)

    def test_replacement_moves_a_guard_only_when_their_old_shift_is_covered(self):
        self.future_week()
        third = self.extra_guard("Third", self.other_site)
        target = self.add_shift(self.guard, self.monday)
        other = self.add_shift(self.cover, self.monday, site=self.other_site)
        preview = self.post("find_replacement", assignment=target.pk)
        self.assertEqual(preview.status_code, 200, preview.data)
        [plan] = [row for row in preview.data["options"] if row["kind"] == "move"]
        self.assertEqual([row["guard_id"] for row in plan["rows"]], [self.cover.pk, third.pk])
        blocker = GuardUnavailability.objects.create(employee=third, work_date=self.monday)
        self.assertEqual(self.post("find_replacement", assignment=target.pk, plan=plan["id"]).status_code, 409)
        target.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual((target.employee_id, other.employee_id), (self.guard.pk, self.cover.pk))
        blocker.delete()
        saved = self.post("find_replacement", assignment=target.pk, plan=plan["id"])
        self.assertEqual(saved.status_code, 200, saved.data)
        target.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual((target.employee_id, other.employee_id), (self.cover.pk, third.pk))

    def test_split_cover_counts_once_and_uses_segment_times_for_attendance(self):
        self.future_week()
        third = self.extra_guard("Third", self.site, self.other_site)
        morning = ShiftType.objects.create(name="Planner Morning", start_time=time(7), end_time=time(13))
        evening = ShiftType.objects.create(name="Planner Evening", start_time=time(13), end_time=time(19))
        self.add_shift(self.cover, self.monday, site=self.other_site, shift=evening)
        self.add_shift(third, self.monday, site=self.other_site, shift=morning)
        target = self.add_shift(self.guard, self.monday)
        SiteShiftRequirement.objects.create(site=self.site, shift_type=self.day, weekday=0, required_guards=2)
        preview = self.post("find_replacement", assignment=target.pk)
        self.assertEqual(preview.status_code, 200, preview.data)
        [plan] = [row for row in preview.data["options"] if row["kind"] == "split"]
        saved = self.post("find_replacement", assignment=target.pk, plan=plan["id"])
        self.assertEqual(saved.status_code, 200, saved.data)
        slots = self.client.get(f"/api/rota-weeks/{self.week.pk}/coverage/?date={self.monday}").data["slots"]
        slot = next(row for row in slots if row["site"] == self.site.pk and row["shift_type"] == self.day.pk)
        self.assertEqual((slot["assigned"], slot["unfilled"]), (1, 1))
        operations = DailyOperation.objects.filter(site=self.site, shift_type=self.day, employee__isnull=False).order_by("scheduled_start")
        self.assertEqual([(row.start_time, row.end_time) for row in operations],
                         [(time(7), time(13)), (time(13), time(19))])

    def test_replacement_checks_attendance_evidence_and_blocks_unauthorized_users(self):
        self.future_week()
        target = self.add_shift(self.guard, self.monday)
        DailyOperation.objects.create(operation_date=self.monday, site=self.site, shift_type=self.day,
                                      employee=self.guard, reached_at=timezone.now(), created_by=self.admin)
        result = self.post("find_replacement", assignment=target.pk)
        self.assertEqual(result.data["options"], [])
        self.assertIn("attendance evidence", result.data["detail"])
        manager = get_user_model().objects.create_user(username="replacement-manager")
        UserProfile.objects.create(user=manager, role=UserProfile.Role.MANAGER)
        self.client.force_authenticate(manager)
        self.assertEqual(self.post("find_replacement", assignment=target.pk).status_code, 403)

    def test_open_position_can_be_filled_without_replacing_office_notes(self):
        self.future_week()
        note = DailyOperation.objects.create(operation_date=self.monday, site=self.site, shift_type=self.day,
                                            notes="Contact site office", created_by=self.admin)
        slot = {"site": self.site.pk, "shift_type": self.day.pk, "work_date": str(self.monday)}
        preview = self.post("find_replacement", slot=slot)
        self.assertEqual(preview.status_code, 200, preview.data)
        plan = preview.data["options"][0]
        saved = self.post("find_replacement", slot=slot, plan=plan["id"])
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(self.week.assignments.count(), 1)
        note.refresh_from_db()
        self.assertEqual(note.notes, "Contact site office")
        self.assertEqual(self.post("find_replacement", slot=slot, plan=plan["id"]).status_code, 409)

    def test_overnight_leave_queue_covers_next_day_and_excludes_guards_with_pending_leave(self):
        self.future_week()
        target = self.add_shift(self.guard, self.monday, shift=self.night)
        for employee in (self.guard, self.cover):
            LeaveRecord.objects.create(employee=employee, start_date=self.monday + timedelta(days=1),
                                       end_date=self.monday + timedelta(days=1), created_by=self.admin)
        queue = self.client.get(f"/api/rota-weeks/{self.week.pk}/leave_cover/")
        self.assertEqual([(row["id"], row["leave_status"]) for row in queue.data], [(target.pk, "PENDING")])
        self.assertEqual(self.post("find_replacement", assignment=target.pk).data["options"], [])

    def test_manager_can_copy_only_managed_sites(self):
        manager = get_user_model().objects.create_user(username="planner-manager")
        profile, _ = UserProfile.objects.update_or_create(user=manager, defaults={"role": UserProfile.Role.MANAGER})
        profile.managed_sites.add(self.site)
        self.add_shift(self.guard, self.monday)
        self.add_shift(self.cover, self.monday, site=self.other_site)
        self.client.force_authenticate(manager)
        target = str(self.monday + timedelta(days=7))
        preview = self.post("copy_to", week_start=target, preview=True)
        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual([row["site_name"] for row in preview.data["rows"]], [self.site.name])
        restricted = self.post("copy_to", week_start=target, site_ids=[self.other_site.pk], preview=True)
        self.assertEqual(restricted.status_code, 403)

    def test_publish_review_reports_conflicts_without_publishing(self):
        self.add_shift(self.guard, self.monday)
        GuardUnavailability.objects.create(employee=self.guard, work_date=self.monday)
        review = self.post("publish", preview=True)
        self.assertEqual(review.status_code, 200)
        self.assertIn("unavailable", review.data["conflicts"][0])
        self.week.refresh_from_db()
        self.assertEqual(self.week.status, RotaWeek.Status.DRAFT)
