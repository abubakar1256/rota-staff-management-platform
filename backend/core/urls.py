from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import AuditLogViewSet, ClientViewSet, DailyArrivalReportViewSet, DailyOperationViewSet, EmployeeDocumentViewSet, EmployeeViewSet, LeaveRecordViewSet, NotificationViewSet, RotaAssignmentViewSet, RotaWeekViewSet, ShiftTypeViewSet, SiteInductionViewSet, SiteShiftRequirementViewSet, SiteViewSet, TimesheetViewSet, UserViewSet, activate_portal, approve_compliance, client_login, client_me, client_portal_summary, compliance_approvals, dashboard, employee_compliance, employee_compliance_pdf, google_drive_callback, google_drive_connect, google_drive_status, guard_login, guard_me, login, me, password_reset_confirm, password_reset_request, password_reset_verify, reject_compliance, report_print, reports_summary, rota_csv, secure_attendance_media, secure_client_report_media, secure_daily_report_media, secure_document_media, timesheets_csv


router = DefaultRouter()
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
    path("auth/login/", login, name="login"),
    path("auth/guard-login/", guard_login, name="guard-login"),
    path("auth/client-login/", client_login, name="client-login"),
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
