from datetime import date, datetime, time, timedelta
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import AuditLog, DailyArrivalReport, DailyOperation, Employee, ShiftType, Site, SiteShiftRequirement, UserProfile
from .views import generate_daily_arrival_reports


@override_settings(TIME_ZONE="Europe/London")
class SavedArrivalPDFTests(APITestCase):
    def setUp(self):
        temp = TemporaryDirectory(); self.addCleanup(temp.cleanup)
        media = override_settings(MEDIA_ROOT=temp.name); media.enable(); self.addCleanup(media.disable)
        self.now = timezone.make_aware(datetime(2026, 11, 4, 12))
        clock = patch("django.utils.timezone.now", side_effect=lambda: self.now); clock.start(); self.addCleanup(clock.stop)
        User = get_user_model()
        self.admin = User.objects.create_user(username="pdf-admin", is_superuser=True)
        self.guard = User.objects.create_user(username="pdf-guard")
        UserProfile.objects.update_or_create(user=self.guard, defaults={"role": "EMPLOYEE"})
        self.employee = Employee.objects.create(employee_id="PDF-1", name="Example Guard", user=self.guard)
        ShiftType.objects.all().update(is_active=False)
        self.day = ShiftType.objects.create(name="Day shift", start_time=time(7), end_time=time(19))
        self.night = ShiftType.objects.create(name="Night shift", start_time=time(19), end_time=time(7))
        self.site = Site.objects.create(site_id="PDF", name="London Office", required_guards=2)
        self.operation = DailyOperation.objects.create(operation_date=date(2026,11,4),site=self.site,
            employee=self.employee,shift_type=self.day,reached_at=self.now-timedelta(hours=2,minutes=12),created_by=self.admin)
        for _ in range(8):
            DailyOperation.objects.create(operation_date=date(2026,11,4),site=self.site,shift_type=self.day,created_by=self.admin)
        self.saved = DailyArrivalReport.objects.create(report_date=date(2026,11,4),shift_type=self.day,
            scheduled_count=9,reached_count=0,late_count=1,unassigned_count=8,generated_by=self.admin)
        self.saved.pdf_file.save("legacy.pdf",ContentFile(b"legacy snapshot"))
        self.other = DailyArrivalReport.objects.create(report_date=date(2026,11,4),shift_type=self.night,scheduled_count=9)
        self.other.pdf_file.save("night.pdf",ContentFile(b"night snapshot"))
        self.client.force_authenticate(self.admin)

    def regenerate(self):
        return self.client.post(f"/api/arrival-reports/{self.saved.pk}/regenerate/",{},format="json")

    def test_old_snapshot_is_rebuilt_in_place_with_current_counts_and_pdf_bytes(self):
        old_name = self.saved.pdf_file.name
        old_generated = self.saved.generated_at
        recorded_arrival = self.operation.reached_at
        self.now += timedelta(minutes=10)
        response = self.regenerate()
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response.data["id"],self.saved.pk)
        self.assertEqual(response.data["scheduled_count"],1)
        self.assertEqual(response.data["reached_count"],1)
        self.assertEqual(response.data["late_count"],1)
        self.assertEqual(response.data["unassigned_count"],1)
        self.saved.refresh_from_db()
        self.assertGreater(self.saved.generated_at,old_generated)
        with self.saved.pdf_file.open("rb") as stream:
            self.assertTrue(stream.read().startswith(b"%PDF"))
        self.assertFalse(self.saved.pdf_file.storage.exists(old_name))
        self.other.refresh_from_db()
        self.assertEqual(self.other.scheduled_count,9)
        with self.other.pdf_file.open("rb") as stream:
            self.assertEqual(stream.read(),b"night snapshot")
        self.operation.refresh_from_db();self.assertEqual(self.operation.reached_at,recorded_arrival)
        self.assertEqual(DailyOperation.objects.count(),9)
        self.assertEqual(DailyArrivalReport.objects.count(),2)
        self.assertTrue(AuditLog.objects.filter(model_name="DailyArrivalReport",object_id=str(self.saved.pk),summary__startswith="Regenerated").exists())
        media=self.client.get(f"/api/media/report/daily/{self.saved.pk}/")
        self.assertEqual(media.status_code,200)
        self.assertEqual(media["Cache-Control"],"private, no-store")
        self.assertTrue(b"".join(media.streaming_content).startswith(b"%PDF"))

    def test_zero_requirement_and_repeated_updates_do_not_duplicate_reports(self):
        SiteShiftRequirement.objects.create(site=self.site,shift_type=self.day,weekday=2,required_guards=0)
        for _ in range(2):
            response=self.regenerate();self.assertEqual(response.status_code,200,response.data)
            self.assertEqual(response.data["unassigned_count"],0)
            self.assertEqual(response.data["scheduled_count"],1)
        self.assertEqual(DailyArrivalReport.objects.count(),2)

    def test_only_admin_can_replace_a_saved_pdf(self):
        User=get_user_model()
        for role in ("EMPLOYEE","MANAGER","OPERATOR","CLIENT_ADMIN"):
            user=User.objects.create_user(username=f"pdf-{role}")
            UserProfile.objects.update_or_create(user=user,defaults={"role":role})
            self.client.force_authenticate(user)
            self.assertEqual(self.regenerate().status_code,403,role)
        admin=User.objects.create_user(username="pdf-office-admin")
        UserProfile.objects.update_or_create(user=admin,defaults={"role":"ADMIN"})
        self.client.force_authenticate(admin)
        self.assertEqual(self.regenerate().status_code,200)

    def test_storage_failure_keeps_the_previous_pdf_and_counts(self):
        previous=self.saved.pdf_file.name
        with patch.object(self.saved.pdf_file.storage,"save",side_effect=OSError("Synthetic storage unavailable")):
            with self.assertRaises(OSError):
                generate_daily_arrival_reports(self.saved.report_date,self.admin,[self.day])
        self.saved.refresh_from_db()
        self.assertEqual(self.saved.pdf_file.name,previous)
        self.assertEqual(self.saved.scheduled_count,9)
        with self.saved.pdf_file.open("rb") as stream:
            self.assertEqual(stream.read(),b"legacy snapshot")

    def test_missing_report_does_not_generate_a_new_one(self):
        self.assertEqual(self.client.post("/api/arrival-reports/999999/regenerate/",{},format="json").status_code,404)
        self.assertEqual(DailyArrivalReport.objects.count(),2)
