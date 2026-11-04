from django.urls import include, path
from rest_framework.routers import DefaultRouter
from .screening import SecurityScreeningViewSet
from . import admin_security_views
from . import location_views

from .views import AuditLogViewSet, ClientViewSet, DailyArrivalReportViewSet, DailyOperationViewSet, EmployeeDocumentViewSet, EmployeeViewSet, LeaveRecordViewSet, NotificationViewSet, RotaAssignmentViewSet, RotaWeekViewSet, ShiftTypeViewSet, SiteInductionViewSet, SiteShiftRequirementViewSet, SiteViewSet, TimesheetViewSet, UserViewSet, activate_portal, activation_details, approve_compliance, client_login, client_me, client_portal_summary, compliance_approvals, dashboard, employee_compliance, employee_compliance_pdf, google_drive_callback, google_drive_connect, google_drive_status, guard_login, guard_me, login, me, password_reset_confirm, password_reset_request, password_reset_verify, reject_compliance, report_print, reports_summary, request_compliance_resubmission, rota_csv, secure_attendance_media, secure_client_report_media, secure_daily_report_media, secure_document_media, timesheets_csv


router = DefaultRouter()
router.register("security-screenings", SecurityScreeningViewSet, basename="security-screening")
router.register("employees", EmployeeViewSet, basename="employee")
router.register("clients", ClientViewSet, basename="client")
router.register("sites", SiteViewSet, basename="site")
router.register("shift-types", ShiftTypeViewSet, basename="shift-type")
router.register("site-requirements", SiteShiftRequirementViewSet, basename="site-requirement")
router.register("site-inductions", SiteInductionViewSet, basename="site-induction")
router.register("rota-weeks", RotaWeekViewSet, basename="rota-week")
router.register("assignments", RotaAssignmentViewSet, basename="assignment")
router.register("leave", LeaveRecordViewSet, basename="leave")
router.register("documents", EmployeeDocumentViewSet, basename="document")
router.register("timesheets", TimesheetViewSet, basename="timesheet")
router.register("operations", DailyOperationViewSet, basename="operation")
router.register("arrival-reports", DailyArrivalReportViewSet, basename="arrival-report")
router.register("notifications", NotificationViewSet, basename="notification")
router.register("audit-logs", AuditLogViewSet, basename="audit-log")
router.register("users", UserViewSet, basename="user")

urlpatterns = [
    path("location-tracking/active/", location_views.active_tracking, name="location-tracking-active"),
    path("location-tracking/tracker/", location_views.tracking_tracker, name="location-tracking-tracker"),
    path("location-tracking/<int:pk>/report/", location_views.submit_location, name="location-tracking-report"),
    path("location-tracking/<int:pk>/geofence/", location_views.geofence_status, name="location-tracking-geofence"),
    path("location-tracking/<int:pk>/history/", location_views.tracking_history, name="location-tracking-history"),
    path("auth/admin-verify/", admin_security_views.verify_admin_login, name="admin-verify"),
    path("auth/admin-activity/", admin_security_views.activity, name="admin-activity"),
    path("auth/logout/", admin_security_views.logout, name="logout"),
    path("auth/admin-security/", admin_security_views.security, name="admin-security"),
    path("auth/login-history/", admin_security_views.login_history, name="login-history"),
    path("auth/revoke-other-sessions/", admin_security_views.revoke_others, name="revoke-other-sessions"),
    path("auth/login/", login, name="login"),
    path("auth/guard-login/", guard_login, name="guard-login"),
    path("auth/client-login/", client_login, name="client-login"),
    path("auth/activation-details/", activation_details, name="activation-details"),
    path("auth/activate/", activate_portal, name="activate-portal"),
    path("auth/password-reset/", password_reset_request, name="password-reset-request"),
    path("auth/password-reset-verify/", password_reset_verify, name="password-reset-verify"),
    path("auth/password-reset-confirm/", password_reset_confirm, name="password-reset-confirm"),
    path("auth/me/", me, name="me"),
    path("auth/guard-me/", guard_me, name="guard-me"),
    path("auth/client-me/", client_me, name="client-me"),
    path("integrations/google-drive/connect/", google_drive_connect, name="google-drive-connect"),
    path("integrations/google-drive/callback/", google_drive_callback, name="google-drive-callback"),
    path("integrations/google-drive/status/", google_drive_status, name="google-drive-status"),
    path("employees/me/compliance/", employee_compliance, name="employee-compliance"),
    path("employees/me/compliance/pdf/", employee_compliance_pdf, name="employee-compliance-pdf"),
    path("employees/<int:employee_id>/compliance/", employee_compliance, name="employee-compliance-admin"),
    path("employees/<int:employee_id>/compliance/pdf/", employee_compliance_pdf, name="employee-compliance-pdf-admin"),
    path("compliance-approvals/", compliance_approvals, name="compliance-approvals"),
    path("compliance-approvals/<int:pk>/approve/", approve_compliance, name="approve-compliance"),
    path("compliance-approvals/<int:pk>/reject/", reject_compliance, name="reject-compliance"),
    path("compliance-approvals/<int:pk>/request-resubmission/", request_compliance_resubmission, name="request-compliance-resubmission"),
    path("client-portal/summary/", client_portal_summary, name="client-portal-summary"),
    path("dashboard/", dashboard, name="dashboard"),
    path("reports/summary/", reports_summary, name="reports-summary"),
    path("exports/timesheets.csv", timesheets_csv, name="timesheets-csv"),
    path("exports/rota.csv", rota_csv, name="rota-csv"),
    path("exports/report-print/", report_print, name="report-print"),
    path("media/document/<int:pk>/", secure_document_media, name="secure-document-media"),
    path("media/attendance/<int:pk>/", secure_attendance_media, name="secure-attendance-media"),
    path("media/report/daily/<int:pk>/", secure_daily_report_media, name="secure-daily-report-media"),
    path("media/report/client/<int:pk>/", secure_client_report_media, name="secure-client-report-media"),
    path("", include(router.urls)),
]
