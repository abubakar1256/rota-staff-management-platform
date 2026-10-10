from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import AuditLogViewSet, ClientViewSet, DailyArrivalReportViewSet, DailyOperationViewSet, EmployeeDocumentViewSet, EmployeeViewSet, LeaveRecordViewSet, NotificationViewSet, RotaAssignmentViewSet, RotaWeekViewSet, ShiftTypeViewSet, SiteInductionViewSet, SiteShiftRequirementViewSet, SiteViewSet, TimesheetViewSet, UserViewSet, activate_portal, client_login, client_me, client_portal_summary, dashboard, guard_login, guard_me, login, me, report_print, reports_summary, rota_csv, timesheets_csv


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
    path("auth/me/", me, name="me"),
    path("auth/guard-me/", guard_me, name="guard-me"),
    path("auth/client-me/", client_me, name="client-me"),
    path("client-portal/summary/", client_portal_summary, name="client-portal-summary"),
    path("dashboard/", dashboard, name="dashboard"),
    path("reports/summary/", reports_summary, name="reports-summary"),
    path("exports/timesheets.csv", timesheets_csv, name="timesheets-csv"),
    path("exports/rota.csv", rota_csv, name="rota-csv"),
    path("exports/report-print/", report_print, name="report-print"),
    path("", include(router.urls)),
]
