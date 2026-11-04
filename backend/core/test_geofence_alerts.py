from datetime import datetime, time, timedelta
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase
from .models import DailyOperation, DutyLocationState, Employee, Notification, ShiftAttendanceEvent, ShiftType, Site, UserProfile

@override_settings(TIME_ZONE="Europe/London")
class GuardGeofenceAlertsTests(APITestCase):
    def setUp(self):
        User=get_user_model()
        self.guard=User.objects.create_user(username="boundary-guard")
        self.other=User.objects.create_user(username="boundary-other")
        self.admin=User.objects.create_user(username="boundary-office",is_superuser=True)
        for user in (self.guard,self.other):
            UserProfile.objects.update_or_create(user=user,defaults={"role":"EMPLOYEE"})
        self.employee=Employee.objects.create(employee_id="BOUNDARY-1",name="Boundary Guard",user=self.guard)
        self.current=timezone.make_aware(datetime(2026,11,4,8))
        clock=patch("django.utils.timezone.now",side_effect=lambda:self.current);clock.start();self.addCleanup(clock.stop)
        self.site=Site.objects.create(site_id="BOUNDARY",name="Assigned Office",address="10 Example Road, London",latitude=51.5,longitude=-.12,geofence_radius_m=50)
        self.shift=ShiftType.objects.create(name="Boundary day",start_time=time(8),end_time=time(20))
        self.operation=DailyOperation.objects.create(employee=self.employee,site=self.site,shift_type=self.shift,operation_date=self.current.date(),created_by=self.admin)
        ShiftAttendanceEvent.objects.create(operation=self.operation,event_type="BOOK_ON",photo="fixture/on.jpg",created_by=self.guard)
        self.client.force_authenticate(self.guard)

    def report(self, **values):
        body={"latitude":51.5006,"longitude":-.12,"accuracy_m":8,"captured_at":self.current.isoformat(),**values}
        return self.client.post(f"/api/location-tracking/{self.operation.pk}/geofence/",body,format="json")

    def test_own_active_geofence_includes_address_even_when_30_minute_tracking_is_off(self):
        other=Employee.objects.create(employee_id="BOUNDARY-2",name="Other guard",user=self.other)
        operation=DailyOperation.objects.create(employee=other,site=self.site,shift_type=self.shift,operation_date=self.current.date(),created_by=self.admin)
        ShiftAttendanceEvent.objects.create(operation=operation,event_type="BOOK_ON",photo="fixture/other.jpg",created_by=self.other)
        response=self.client.get("/api/location-tracking/active/")
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response.data["results"],[])
        self.assertEqual([row["operation_id"] for row in response.data["geofences"]],[self.operation.pk])
        self.assertEqual(response.data["geofences"][0]["site_address"],self.site.address)
        self.assertEqual(response.data["geofences"][0]["site_geofence_radius_m"],50)
        self.assertFalse(DutyLocationState.objects.exists())

    def test_outside_notifies_only_guard_once_until_inside_then_a_new_exit_can_alert(self):
        first=self.report(site_address="Forged address")
        self.assertEqual(first.status_code,200,first.data);self.assertTrue(first.data["created"])
        notice=Notification.objects.get(context__geofence_breach=True)
        self.assertEqual(notice.user_id,self.guard.pk);self.assertEqual(notice.priority,"URGENT")
        self.assertIn(self.site.address,notice.message);self.assertNotIn("Forged",notice.message)
        self.assertEqual(self.report().data["created"],False)
        self.assertEqual(Notification.objects.filter(context__geofence_breach=True).count(),1)
        active=self.client.get("/api/location-tracking/active/").data["geofences"][0]
        self.assertTrue(active["has_open_alert"])
        recovered=self.report(latitude=51.5)
        self.assertTrue(recovered.data["resolved"])
        notice.refresh_from_db();self.assertTrue(notice.is_read);self.assertEqual(notice.priority,"NORMAL")
        self.assertIn("resolved_at",notice.context)
        self.assertTrue(self.report().data["created"])
        self.assertEqual(Notification.objects.filter(context__geofence_breach=True).count(),2)
        self.assertFalse(Notification.objects.filter(user__in=[self.admin,self.other]).exists())
        self.assertFalse(Notification.objects.filter(user=None).exists())

    def test_invalid_stale_or_inaccurate_positions_cannot_create_or_resolve_an_alert(self):
        for extra in ({"latitude":"nan"},{"longitude":181},{"accuracy_m":-1},{"latitude":True},
                {"captured_at":"bad"},{"captured_at":None},
                {"captured_at":(self.current-timedelta(minutes=5)).isoformat()}):
            self.assertEqual(self.report(**extra).status_code,400,extra)
        self.assertFalse(Notification.objects.exists())
        self.assertEqual(self.report(accuracy_m=100).data["status"],"UNVERIFIED")
        self.assertFalse(Notification.objects.exists())
        self.report()
        self.assertEqual(self.report(latitude=51.5,accuracy_m=100).data["status"],"UNVERIFIED")
        self.assertFalse(Notification.objects.get().is_read)

    def test_only_assigned_guard_can_report_and_notifications_are_private(self):
        self.client.force_authenticate(self.other)
        self.assertEqual(self.report().status_code,404)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.report().status_code,403)
        self.client.force_authenticate(None)
        self.assertIn(self.report().status_code,(401,403))
        self.assertFalse(Notification.objects.exists())

    def test_no_geofence_monitoring_before_book_on_after_book_off_or_at_shift_end(self):
        self.operation.attendance_events.all().delete()
        self.assertEqual(self.report().status_code,409)
        self.assertEqual(self.client.get("/api/location-tracking/active/").data["geofences"],[])
        ShiftAttendanceEvent.objects.create(operation=self.operation,event_type="BOOK_ON",photo="fixture/on.jpg",created_by=self.guard)
        off=ShiftAttendanceEvent.objects.create(operation=self.operation,event_type="BOOK_OFF",photo="fixture/off.jpg",created_by=self.guard)
        self.assertEqual(self.report().status_code,409)
        off.delete();self.current=self.current.replace(hour=20)
        self.assertEqual(self.report().status_code,409)
        self.assertEqual(self.client.get("/api/location-tracking/active/").data["geofences"],[])
        self.assertFalse(Notification.objects.exists())

    def test_radius_boundary_is_inclusive_and_site_changes_are_respected(self):
        with patch("core.views.haversine_distance_m",return_value=50):
            self.assertEqual(self.report().data["status"],"INSIDE")
        with patch("core.views.haversine_distance_m",return_value=50.004):
            self.assertEqual(self.report().data["status"],"OUTSIDE")
        self.site.geofence_radius_m=100;self.site.save()
        self.assertEqual(self.report().data["status"],"INSIDE")
