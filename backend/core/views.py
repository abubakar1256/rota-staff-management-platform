from datetime import date, datetime, timedelta
import csv
import hashlib
from math import asin, cos, radians, sin, sqrt
import os
import re
from io import BytesIO
from secrets import token_urlsafe

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.paginator import Paginator
from django.db import transaction
from django.db.models import Prefetch, Q
from django.http import HttpResponse
from rest_framework import status, viewsets
from rest_framework.authtoken.models import Token
from django.utils import timezone
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .models import AuditLog, Client, ClientArrivalReport, DailyArrivalReport, DailyOperation, Employee, EmployeeDocument, EmployeePortalInvite, LeaveRecord, Notification, RotaAssignment, RotaConfirmation, RotaWeek, ShiftAttendanceEvent, ShiftType, Site, SiteInduction, SiteShiftRequirement, Timesheet, UserProfile
from .permissions import IsAdminManagerOrEmployee, IsAdminManagerOrEmployeeDocument, IsAdminManagerOrEmployeeOperation, IsAdminManagerOrEmployeeRota, IsAdminOnly, IsAdminOrManager, IsAdminOrSuperAdmin, IsClientAdmin, IsInternalUser, role_of
from .serializers import AuditLogSerializer, ClientArrivalReportSerializer, ClientSerializer, DailyArrivalReportSerializer, DailyOperationSerializer, EmployeeDocumentSerializer, EmployeeSerializer, LeaveRecordSerializer, LoginSerializer, NotificationSerializer, RotaAssignmentSerializer, RotaConfirmationSerializer, RotaWeekSerializer, ShiftAttendanceEventSerializer, ShiftTypeSerializer, SiteInductionSerializer, SiteSerializer, SiteShiftRequirementSerializer, TimesheetSerializer, UserSerializer


User = get_user_model()


def haversine_distance_m(latitude_a, longitude_a, latitude_b, longitude_b):
    earth_radius_m = 6371000
    lat_delta = radians(latitude_b - latitude_a)
    lon_delta = radians(longitude_b - longitude_a)
    a = sin(lat_delta / 2) ** 2 + cos(radians(latitude_a)) * cos(radians(latitude_b)) * sin(lon_delta / 2) ** 2
    return earth_radius_m * 2 * asin(sqrt(a))


def arrival_snapshot(operation):
    if not operation.employee_id:
        return "NOT_ASSIGNED", None
    if not operation.reached_at:
        return "NOT_REACHED", None
    scheduled = timezone.make_aware(datetime.combine(operation.operation_date, operation.shift_type.start_time), timezone.get_current_timezone())
    delay_minutes = max(0, round((operation.reached_at - scheduled).total_seconds() / 60))
    return ("LATE" if delay_minutes else "REACHED"), delay_minutes


def build_arrival_pdf(report_date, shift, operations):
    buffer = BytesIO()
    document = SimpleDocTemplate(buffer, pagesize=landscape(A4), rightMargin=12 * mm, leftMargin=12 * mm, topMargin=12 * mm, bottomMargin=12 * mm)
    styles = getSampleStyleSheet()
    title_style = styles["Title"]
    title_style.fontName = "Helvetica-Bold"
    body_style = styles["BodyText"]
    body_style.fontName = "Helvetica"
    body_style.fontSize = 8
    story = [Paragraph("Daily site arrival report", title_style), Paragraph(f"{report_date} | {shift.name} ({shift.start_time.strftime('%H:%M')}-{shift.end_time.strftime('%H:%M')})", body_style), Spacer(1, 7 * mm)]
    rows = [["Employee", "Employee ID", "Site", "Scheduled", "Reached at", "Delay", "Status", "Verified by"]]
    counts = {"scheduled": len(operations), "reached": 0, "late": 0, "not_reached": 0, "unassigned": 0}
    for operation in operations:
        arrival_status, delay_minutes = arrival_snapshot(operation)
        if arrival_status == "REACHED":
            counts["reached"] += 1
        elif arrival_status == "LATE":
            counts["late"] += 1
        elif arrival_status == "NOT_REACHED":
            counts["not_reached"] += 1
        else:
            counts["unassigned"] += 1
        status_label = {"REACHED": "Reached", "LATE": "Late", "NOT_REACHED": "Not reached", "NOT_ASSIGNED": "Not assigned"}[arrival_status]
        reached_at = timezone.localtime(operation.reached_at).strftime("%d %b %Y %H:%M") if operation.reached_at else "-"
        verified_by = operation.reached_by.get_full_name() or operation.reached_by.get_username() if operation.reached_by else "-"
        rows.append([
            operation.employee.name if operation.employee else "Unassigned",
            operation.employee.employee_id if operation.employee else "-",
            operation.site.name,
            operation.shift_type.start_time.strftime("%H:%M"),
            reached_at,
            f"{delay_minutes} min" if delay_minutes else ("On time" if arrival_status in {"REACHED", "LATE"} else "-"),
            status_label,
            verified_by,
        ])
    if len(rows) == 1:
        rows.append(["No scheduled employees", "-", "-", "-", "-", "-", "-", "-"])
    table = Table(rows, repeatRows=1, colWidths=[38 * mm, 26 * mm, 40 * mm, 24 * mm, 34 * mm, 20 * mm, 25 * mm, 35 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#182137")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#dbe2ec")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f8fc")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.extend([Paragraph(f"Scheduled: {counts['scheduled']} | Reached: {counts['reached']} | Late: {counts['late']} | Not reached: {counts['not_reached']} | Unassigned: {counts['unassigned']}", body_style), Spacer(1, 4 * mm), table])
    document.build(story)
    return buffer.getvalue(), counts


def generate_daily_arrival_reports(report_date, user, shift_types=None):
    shifts = list(shift_types or ShiftType.objects.filter(is_active=True).order_by("start_time", "name"))
    generated = []
    for shift in shifts:
        operations = list(DailyOperation.objects.filter(operation_date=report_date, shift_type=shift).select_related("employee", "site", "shift_type", "reached_by").order_by("site__name", "employee__name"))
        pdf_bytes, counts = build_arrival_pdf(report_date, shift, operations)
        report, _ = DailyArrivalReport.objects.get_or_create(report_date=report_date, shift_type=shift)
        if report.pdf_file:
            report.pdf_file.delete(save=False)
        filename = f"arrival-report-{report_date}-{re.sub(r'[^a-z0-9]+', '-', shift.name.lower()).strip('-')}.pdf"
        report.pdf_file.save(filename, ContentFile(pdf_bytes), save=False)
        report.scheduled_count = counts["scheduled"]
        report.reached_count = counts["reached"]
        report.late_count = counts["late"]
        report.not_reached_count = counts["not_reached"]
        report.unassigned_count = counts["unassigned"]
        report.generated_by = user
        report.save()
        generated.append(report)
    generate_client_arrival_reports(report_date, user, shifts)
    return generated


def generate_client_arrival_reports(report_date, user, shift_types=None):
    """Generate one private day/night PDF per client, without cross-client data."""
    shifts = list(shift_types or ShiftType.objects.filter(is_active=True).order_by("start_time", "name"))
    clients = Client.objects.filter(status=Client.Status.ACTIVE, sites__daily_operations__operation_date=report_date).distinct()
    for client in clients:
        for shift in shifts:
            operations = list(DailyOperation.objects.filter(operation_date=report_date, shift_type=shift, site__client=client).select_related("employee", "site", "shift_type", "reached_by").order_by("site__name", "employee__name"))
            if not operations:
                continue
            pdf_bytes, counts = build_arrival_pdf(report_date, shift, operations)
            report, _ = ClientArrivalReport.objects.get_or_create(client=client, report_date=report_date, shift_type=shift)
            if report.pdf_file:
                report.pdf_file.delete(save=False)
            filename = f"client-{client.client_id}-{report_date}-{re.sub(r'[^a-z0-9]+', '-', shift.name.lower()).strip('-')}.pdf"
            report.pdf_file.save(filename, ContentFile(pdf_bytes), save=False)
            report.scheduled_count = counts["scheduled"]
            report.reached_count = counts["reached"]
            report.late_count = counts["late"]
            report.not_reached_count = counts["not_reached"]
            report.unassigned_count = counts["unassigned"]
            report.generated_by = user
            report.save()


def sync_rota_date_operations(rota_week, selected_date, user):
    assignments = list(rota_week.assignments.filter(work_date=selected_date).select_related("employee", "site", "shift_type"))
    assignments_by_slot = {}
    for assignment in assignments:
        assignments_by_slot.setdefault((assignment.site_id, assignment.shift_type_id), []).append(assignment)
    created = 0
    updated = 0
    sites = Site.objects.filter(is_active=True)
    shifts = list(ShiftType.objects.filter(is_active=True))
    requirements = {(item.site_id, item.shift_type_id): item.required_guards for item in SiteShiftRequirement.objects.filter(site__in=sites, weekday=selected_date.weekday())}
    for site in sites:
        for shift in shifts:
            slot_assignments = assignments_by_slot.get((site.id, shift.id), [])
            assigned = [item for item in slot_assignments if item.employee_id]
            operations = list(DailyOperation.objects.filter(operation_date=selected_date, site=site, shift_type=shift).order_by("id"))
            for assignment in assigned:
                operation = next((item for item in operations if item.employee_id == assignment.employee_id), None)
                if operation:
                    operation.status = DailyOperation.Status.PRESENT if operation.reached_at else DailyOperation.Status.UNCONFIRMED
                    operation.follow_up = ""
                    operation.save(update_fields=["status", "follow_up", "updated_at"])
                    updated += 1
                else:
                    DailyOperation.objects.create(operation_date=selected_date, site=site, shift_type=shift, employee=assignment.employee, status=DailyOperation.Status.UNCONFIRMED, created_by=user)
                    created += 1
            required = requirements.get((site.id, shift.id), site.required_guards)
            missing = max(required - len(assigned), 0)
            unfilled_operations = [item for item in operations if item.employee_id is None]
            for index in range(missing):
                if index < len(unfilled_operations):
                    operation = unfilled_operations[index]
                    operation.status = DailyOperation.Status.REPLACEMENT_NEEDED
                    operation.follow_up = "Replacement needed"
                    operation.save(update_fields=["status", "follow_up", "updated_at"])
                    updated += 1
                else:
                    DailyOperation.objects.create(operation_date=selected_date, site=site, shift_type=shift, employee=None, status=DailyOperation.Status.REPLACEMENT_NEEDED, follow_up="Replacement needed", created_by=user)
                    created += 1
    return created, updated, shifts


def reset_rota_confirmations(rota_week):
    employee_ids = set(rota_week.assignments.filter(employee__isnull=False).values_list("employee_id", flat=True))
    RotaConfirmation.objects.filter(rota_week=rota_week).exclude(employee_id__in=employee_ids).delete()
    for employee_id in employee_ids:
        RotaConfirmation.objects.update_or_create(
            rota_week=rota_week,
            employee_id=employee_id,
            defaults={"status": RotaConfirmation.Status.PENDING, "confirmed_at": None},
        )
    return len(employee_ids)


@api_view(["POST"])
@permission_classes([AllowAny])
def login(request):
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = serializer.validated_data["user"]
    if request.data.get("guard_portal") and getattr(getattr(user, "profile", None), "role", None) != UserProfile.Role.EMPLOYEE:
        return Response({"detail": "Only guard accounts can sign in to the guard portal."}, status=status.HTTP_403_FORBIDDEN)
    token, _ = Token.objects.get_or_create(user=user)
    return Response({"token": token.key, "user": UserSerializer(user).data})


@api_view(["POST"])
@permission_classes([AllowAny])
def guard_login(request):
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = serializer.validated_data["user"]
    if getattr(getattr(user, "profile", None), "role", None) != UserProfile.Role.EMPLOYEE:
        return Response({"detail": "Only guard accounts can sign in to the guard portal."}, status=status.HTTP_403_FORBIDDEN)
    token, _ = Token.objects.get_or_create(user=user)
    return Response({"token": token.key, "user": UserSerializer(user).data})


@api_view(["POST"])
@permission_classes([AllowAny])
def client_login(request):
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = serializer.validated_data["user"]
    if role_of(user) != UserProfile.Role.CLIENT_ADMIN or not getattr(getattr(user, "profile", None), "client_id", None):
        return Response({"detail": "Only linked Client Admin accounts can sign in to the client portal."}, status=status.HTTP_403_FORBIDDEN)
    token, _ = Token.objects.get_or_create(user=user)
    return Response({"token": token.key, "user": UserSerializer(user).data})


@api_view(["POST"])
@permission_classes([AllowAny])
def activate_portal(request):
    raw_token = (request.data.get("token") or "").strip()
    password = request.data.get("password") or ""
    confirmation = request.data.get("password_confirmation") or ""
    if len(password) < 8:
        return Response({"detail": "Password must be at least 8 characters."}, status=status.HTTP_400_BAD_REQUEST)
    if password != confirmation:
        return Response({"detail": "Passwords do not match."}, status=status.HTTP_400_BAD_REQUEST)
    invite = EmployeePortalInvite.objects.select_related("employee", "employee__user").filter(token_hash=hashlib.sha256(raw_token.encode()).hexdigest(), used_at__isnull=True, expires_at__gt=timezone.now()).first()
    if not raw_token or not invite or not invite.employee.user_id:
        return Response({"detail": "This activation link is invalid or has expired. Ask the office to send a new invite."}, status=status.HTTP_400_BAD_REQUEST)
    user = invite.employee.user
    user.set_password(password)
    user.is_active = True
    user.save(update_fields=["password", "is_active"])
    invite.used_at = timezone.now()
    invite.save(update_fields=["used_at"])
    AuditLog.objects.create(user=user, action="ACTIVATE", model_name="EmployeePortal", object_id=str(invite.employee_id), summary=f"Employee portal activated for {invite.employee.name}")
    token, _ = Token.objects.get_or_create(user=user)
    return Response({"token": token.key, "user": UserSerializer(user).data, "message": "Portal activated successfully."})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def me(request):
    return Response(UserSerializer(request.user).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def guard_me(request):
    if getattr(getattr(request.user, "profile", None), "role", None) != UserProfile.Role.EMPLOYEE:
        return Response({"detail": "Guard portal access is restricted to guard accounts."}, status=status.HTTP_403_FORBIDDEN)
    return Response(UserSerializer(request.user).data)


@api_view(["GET"])
@permission_classes([IsClientAdmin])
def client_me(request):
    if not getattr(getattr(request.user, "profile", None), "client_id", None):
        return Response({"detail": "This Client Admin account is not linked to a client."}, status=status.HTTP_403_FORBIDDEN)
    return Response(UserSerializer(request.user).data)


@api_view(["GET"])
@permission_classes([IsClientAdmin])
def client_portal_summary(request):
    profile = getattr(request.user, "profile", None)
    client = getattr(profile, "client", None)
    if not client or client.status != Client.Status.ACTIVE:
        return Response({"detail": "This Client Admin account is not linked to an active client."}, status=status.HTTP_403_FORBIDDEN)

    today = timezone.localdate()
    sites = client.sites.filter(is_active=True).order_by("name")
    weeks = RotaWeek.objects.filter(status=RotaWeek.Status.PUBLISHED, assignments__site__client=client).distinct().order_by("-week_start")[:12]
    published_rotas = []
    for week in weeks:
        assignments = week.assignments.filter(site__client=client).select_related("employee", "site", "shift_type").order_by("work_date", "site__name", "shift_type__start_time")
        published_rotas.append({
            "rota_week": RotaWeekSerializer(week, context={"request": request}).data,
            "assignments": RotaAssignmentSerializer(assignments, many=True, context={"request": request}).data,
        })

    operations = DailyOperation.objects.filter(site__client=client, operation_date__gte=today - timedelta(days=7), operation_date__lte=today + timedelta(days=7)).select_related("employee", "site", "shift_type").prefetch_related("attendance_events").order_by("-operation_date", "site__name", "shift_type__start_time")[:300]
    reports = ClientArrivalReport.objects.filter(client=client, report_date__gte=today - timedelta(days=30)).select_related("shift_type").order_by("-report_date", "shift_type__start_time")[:100]
    return Response({
        "client": ClientSerializer(client, context={"request": request}).data,
        "sites": SiteSerializer(sites, many=True, context={"request": request}).data,
        "published_rotas": published_rotas,
        "operations": DailyOperationSerializer(operations, many=True, context={"request": request}).data,
        "reports": ClientArrivalReportSerializer(reports, many=True, context={"request": request}).data,
    })


@api_view(["GET"])
@permission_classes([IsInternalUser])
def dashboard(request):
    today = timezone.localdate()
    create_expiry_notifications(request.user)
    week_start = today - timedelta(days=today.weekday())
    current_rota = RotaWeek.objects.filter(week_start=week_start).first()
    today_assignments = []
    if current_rota:
        today_assignments = list(current_rota.assignments.filter(work_date=today).select_related("site", "employee"))
    assigned_by_site = {}
    for assignment in today_assignments:
        if assignment.employee_id:
            assigned_by_site[assignment.site_id] = assigned_by_site.get(assignment.site_id, 0) + 1
    active_sites = list(Site.objects.filter(is_active=True).values("id", "required_guards"))
    active_shift_count = ShiftType.objects.filter(is_active=True).count()
    required_total = sum(site["required_guards"] for site in active_sites) * active_shift_count
    assigned_total = sum(assigned_by_site.values())
    unfilled_total = max(required_total - assigned_total, 0)
    return Response(
        {
            "active_employees": Employee.objects.filter(status=Employee.Status.ACTIVE).count(),
            "active_sites": len(active_sites),
            "employees_on_leave": LeaveRecord.objects.filter(status=LeaveRecord.Status.APPROVED, start_date__lte=today, end_date__gte=today).values("employee_id").distinct().count(),
            "unfilled_shifts": unfilled_total,
            "documents_expiring_soon": EmployeeDocument.objects.filter(expiry_date__gte=today, expiry_date__lte=today + timedelta(days=30)).count(),
            "todays_shifts": len(today_assignments),
        }
    )


class EmployeeViewSet(viewsets.ModelViewSet):
    serializer_class = EmployeeSerializer
    permission_classes = [IsAdminManagerOrEmployee]

    def get_queryset(self):
        queryset = Employee.objects.all()
        role = role_of(self.request.user)
        if role == "EMPLOYEE":
            queryset = queryset.filter(user=self.request.user)
        elif role == "MANAGER":
            queryset = queryset.filter(rota_assignments__site__manager_profiles__user=self.request.user).distinct()
        query = self.request.query_params.get("search")
        status_filter = self.request.query_params.get("status")
        if query:
            queryset = queryset.filter(Q(name__icontains=query) | Q(employee_id__icontains=query))
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        return queryset

    @action(detail=False, methods=["get", "patch"], url_path="me")
    def me(self, request):
        employee = self.get_queryset().first()
        if not employee:
            return Response({"detail": "No employee profile is linked to this account."}, status=status.HTTP_404_NOT_FOUND)
        if request.method == "PATCH":
            blocked = set(request.data) - {"name", "position", "phone", "email", "address", "emergency_contact", "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship", "joining_date"}
            if blocked:
                return Response({"detail": f"These fields cannot be changed from your profile: {', '.join(sorted(blocked))}."}, status=status.HTTP_400_BAD_REQUEST)
            serializer = self.get_serializer(employee, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            serializer.save()
        return Response(self.get_serializer(employee).data)

    @action(detail=False, methods=["post"], url_path="change-password")
    def change_password(self, request):
        user = request.user
        current_password = request.data.get("current_password") or ""
        new_password = request.data.get("new_password") or ""
        confirmation = request.data.get("new_password_confirmation") or ""
        if not user.check_password(current_password):
            return Response({"detail": "Current password is incorrect."}, status=status.HTTP_400_BAD_REQUEST)
        if len(new_password) < 8:
            return Response({"detail": "New password must be at least 8 characters."}, status=status.HTTP_400_BAD_REQUEST)
        if new_password != confirmation:
            return Response({"detail": "New passwords do not match."}, status=status.HTTP_400_BAD_REQUEST)
        user.set_password(new_password)
        user.save(update_fields=["password"])
        AuditLog.objects.create(user=user, action="PASSWORD", model_name="EmployeePortal", object_id=str(user.id), summary="Employee portal password changed")
        return Response({"message": "Password changed successfully."})

    @action(detail=True, methods=["post"])
    def create_portal_account(self, request, pk=None):
        employee = self.get_object()
        role = getattr(getattr(request.user, "profile", None), "role", None)
        if not request.user.is_superuser and role not in {"ADMIN", "MANAGER"}:
            return Response({"detail": "Only Admin or Manager users can create employee portal accounts."}, status=status.HTTP_403_FORBIDDEN)
        if employee.user_id and employee.user.has_usable_password():
            return Response({"detail": "This employee already has an active portal account."}, status=status.HTTP_400_BAD_REQUEST)
        username = (request.data.get("username") or employee.employee_id).strip().lower()
        user = employee.user
        if not user:
            if User.objects.filter(username=username).exists():
                return Response({"detail": "This username already exists. Provide another username."}, status=status.HTTP_400_BAD_REQUEST)
            user = User(username=username, email=employee.email, first_name=employee.name)
            user.set_unusable_password()
            user.save()
        else:
            user.email = employee.email
            user.first_name = employee.name
            user.set_unusable_password()
            user.save(update_fields=["email", "first_name", "password"])
        UserProfile.objects.update_or_create(user=user, defaults={"role": UserProfile.Role.EMPLOYEE})
        if not employee.user_id:
            employee.user = user
            employee.save(update_fields=["user", "updated_at"])
        now = timezone.now()
        EmployeePortalInvite.objects.filter(employee=employee, used_at__isnull=True).update(used_at=now)
        raw_token = token_urlsafe(32)
        invite = EmployeePortalInvite.objects.create(employee=employee, token_hash=hashlib.sha256(raw_token.encode()).hexdigest(), expires_at=now + timedelta(hours=48), created_by=request.user)
        AuditLog.objects.create(user=request.user, action="INVITE", model_name="EmployeePortal", object_id=str(invite.employee_id), summary=f"Secure portal invite created for {employee.name}")
        frontend_url = (request.data.get("frontend_url") or os.getenv("FRONTEND_URL", "http://127.0.0.1:5173")).rstrip("/")
        return Response({"employee": employee.id, "username": user.username, "activation_url": f"{frontend_url}/guard?activate={raw_token}", "expires_at": now + timedelta(hours=48), "message": "Secure employee activation invite created."}, status=status.HTTP_201_CREATED)


class ClientViewSet(viewsets.ModelViewSet):
    serializer_class = ClientSerializer
    permission_classes = [IsAdminOrSuperAdmin]

    def get_queryset(self):
        queryset = Client.objects.all().prefetch_related("sites")
        query = self.request.query_params.get("search")
        if query:
            queryset = queryset.filter(Q(name__icontains=query) | Q(client_id__icontains=query) | Q(email__icontains=query))
        return queryset


class SiteViewSet(viewsets.ModelViewSet):
    serializer_class = SiteSerializer
    permission_classes = [IsAdminOrManager]

    def get_queryset(self):
        queryset = Site.objects.all()
        if role_of(self.request.user) == "MANAGER":
            queryset = queryset.filter(manager_profiles__user=self.request.user)
        query = self.request.query_params.get("search")
        if query:
            queryset = queryset.filter(Q(name__icontains=query) | Q(site_id__icontains=query))
        return queryset

    def perform_create(self, serializer):
        if role_of(self.request.user) == "MANAGER":
            raise PermissionDenied("Managers can use assigned sites but cannot create site records.")
        serializer.save()

    def perform_update(self, serializer):
        if role_of(self.request.user) == "MANAGER":
            raise PermissionDenied("Managers can use assigned sites but cannot edit site records.")
        serializer.save()

    def perform_destroy(self, instance):
        if role_of(self.request.user) == "MANAGER":
            raise PermissionDenied("Managers can use assigned sites but cannot delete site records.")
        instance.delete()


class ShiftTypeViewSet(viewsets.ModelViewSet):
    queryset = ShiftType.objects.all()
    serializer_class = ShiftTypeSerializer
    permission_classes = [IsAdminOrManager]

    def perform_create(self, serializer):
        if role_of(self.request.user) == "MANAGER":
            raise PermissionDenied("Managers can use shift types but cannot change system settings.")
        serializer.save()

    def perform_update(self, serializer):
        if role_of(self.request.user) == "MANAGER":
            raise PermissionDenied("Managers can use shift types but cannot change system settings.")
        serializer.save()

    def perform_destroy(self, instance):
        if role_of(self.request.user) == "MANAGER":
            raise PermissionDenied("Managers can use shift types but cannot change system settings.")
        instance.delete()


class SiteShiftRequirementViewSet(viewsets.ModelViewSet):
    serializer_class = SiteShiftRequirementSerializer
    permission_classes = [IsAdminOrManager]

    def get_queryset(self):
        queryset = SiteShiftRequirement.objects.select_related("site", "shift_type")
        site_id = self.request.query_params.get("site")
        if site_id:
            queryset = queryset.filter(site_id=site_id)
        if role_of(self.request.user) == "MANAGER":
            queryset = queryset.filter(site__manager_profiles__user=self.request.user)
        return queryset

    def _check_site(self, site):
        if role_of(self.request.user) == "MANAGER" and not self.request.user.profile.managed_sites.filter(pk=site.pk).exists():
            raise PermissionDenied("This site is outside your assigned management scope.")

    def perform_create(self, serializer):
        self._check_site(serializer.validated_data["site"])
        serializer.save()

    def perform_update(self, serializer):
        self._check_site(serializer.validated_data.get("site", serializer.instance.site))
        serializer.save()

    def perform_destroy(self, instance):
        self._check_site(instance.site)
        instance.delete()


class SiteInductionViewSet(viewsets.ModelViewSet):
    serializer_class = SiteInductionSerializer
    permission_classes = [IsAdminOrManager]

    def get_queryset(self):
        queryset = SiteInduction.objects.select_related("site", "employee", "created_by")
        site_id = self.request.query_params.get("site")
        if site_id:
            queryset = queryset.filter(site_id=site_id)
        if role_of(self.request.user) == "MANAGER":
            queryset = queryset.filter(site__manager_profiles__user=self.request.user)
        return queryset

    def _check_site(self, site):
        if role_of(self.request.user) == "MANAGER" and not self.request.user.profile.managed_sites.filter(pk=site.pk).exists():
            raise PermissionDenied("This site is outside your assigned management scope.")

    def perform_create(self, serializer):
        self._check_site(serializer.validated_data["site"])
        serializer.save(created_by=self.request.user)

    def perform_update(self, serializer):
        self._check_site(serializer.validated_data.get("site", serializer.instance.site))
        serializer.save()

    def perform_destroy(self, instance):
        self._check_site(instance.site)
        instance.delete()


class RotaWeekViewSet(viewsets.ModelViewSet):
    serializer_class = RotaWeekSerializer
    permission_classes = [IsAdminManagerOrEmployeeRota]

    def get_queryset(self):
        queryset = RotaWeek.objects.select_related("created_by")
        week_start = self.request.query_params.get("week_start")
        if week_start:
            queryset = queryset.filter(week_start=week_start)
        if role_of(self.request.user) == "MANAGER":
            queryset = queryset.filter(assignments__site__manager_profiles__user=self.request.user).distinct()
        return queryset

    @action(detail=False, methods=["get"], url_path="my")
    def my_schedule(self, request):
        """Return only published rota data belonging to the signed-in guard."""
        profile = getattr(request.user, "profile", None)
        employee = getattr(request.user, "employee_record", None)
        if not profile or profile.role != UserProfile.Role.EMPLOYEE or not employee:
            return Response({"detail": "This endpoint is for guard accounts only."}, status=status.HTTP_403_FORBIDDEN)
        queryset = RotaWeek.objects.filter(status=RotaWeek.Status.PUBLISHED, assignments__employee=employee).distinct().order_by("-week_start")
        week_start = request.query_params.get("week_start")
        if week_start:
            queryset = queryset.filter(week_start=week_start)
        result = []
        for rota_week in queryset:
            assignments = rota_week.assignments.filter(employee=employee).select_related("site", "shift_type")
            confirmation = rota_week.confirmations.filter(employee=employee).first()
            result.append({
                "rota_week": RotaWeekSerializer(rota_week).data,
                "assignments": RotaAssignmentSerializer(assignments, many=True).data,
                "confirmation": RotaConfirmationSerializer(confirmation).data if confirmation else None,
            })
        return Response(result)

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=["post"])
    def publish(self, request, pk=None):
        rota_week = self.get_object()
        if not rota_week.assignments.exists():
            return Response({"detail": "Add at least one assignment before publishing this rota."}, status=status.HTTP_400_BAD_REQUEST)
        confirmation_count = reset_rota_confirmations(rota_week)
        rota_week.status = RotaWeek.Status.PUBLISHED
        rota_week.published_at = timezone.now()
        rota_week.save(update_fields=["status", "published_at", "updated_at"])
        response = self.get_serializer(rota_week).data
        response["confirmation_count"] = confirmation_count
        return Response(response)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        rota_week = self.get_object()
        if rota_week.status == RotaWeek.Status.DRAFT:
            return Response(self.get_serializer(rota_week).data)
        reset_rota_confirmations(rota_week)
        rota_week.status = RotaWeek.Status.DRAFT
        rota_week.published_at = None
        rota_week.save(update_fields=["status", "published_at", "updated_at"])
        return Response(self.get_serializer(rota_week).data)

    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        rota_week = self.get_object()
        assignments = rota_week.assignments.select_related("employee", "site", "shift_type")
        confirmations = rota_week.confirmations.select_related("employee")
        if getattr(getattr(request.user, "profile", None), "role", None) == UserProfile.Role.EMPLOYEE:
            assignments = assignments.filter(employee=request.user.employee_record)
            confirmations = confirmations.filter(employee=request.user.employee_record)
        return Response({
            "rota_week": self.get_serializer(rota_week).data,
            "assignments": RotaAssignmentSerializer(assignments, many=True).data,
            "unfilled_assignments": assignments.filter(employee__isnull=True).count(),
            "confirmations": RotaConfirmationSerializer(confirmations, many=True).data,
            "confirmation_summary": {
                "total": confirmations.count(),
                "confirmed": confirmations.filter(status=RotaConfirmation.Status.CONFIRMED).count(),
                "pending": confirmations.filter(status=RotaConfirmation.Status.PENDING).count(),
            },
        })

    @action(detail=True, methods=["post"])
    def confirm(self, request, pk=None):
        rota_week = self.get_object()
        employee_id = request.data.get("employee")
        profile = getattr(request.user, "profile", None)
        employee = getattr(request.user, "employee_record", None)
        if profile and profile.role == UserProfile.Role.EMPLOYEE:
            if not employee:
                return Response({"detail": "Your employee profile is not linked to this account."}, status=status.HTTP_403_FORBIDDEN)
            employee_id = employee.id
        if not employee_id:
            return Response({"detail": "employee is required."}, status=status.HTTP_400_BAD_REQUEST)
        if rota_week.status != RotaWeek.Status.PUBLISHED:
            return Response({"detail": "Only a published rota can be confirmed."}, status=status.HTTP_400_BAD_REQUEST)
        if not rota_week.assignments.filter(employee_id=employee_id).exists():
            return Response({"detail": "This employee is not assigned on this rota."}, status=status.HTTP_400_BAD_REQUEST)
        confirmation, _ = RotaConfirmation.objects.update_or_create(
            rota_week=rota_week,
            employee_id=employee_id,
            defaults={"status": RotaConfirmation.Status.CONFIRMED, "confirmed_at": timezone.now()},
        )
        return Response(RotaConfirmationSerializer(confirmation).data)

    @action(detail=True, methods=["get"])
    def coverage(self, request, pk=None):
        rota_week = self.get_object()
        selected_date = request.query_params.get("date") or str(timezone.localdate())
        try:
            selected_date = date.fromisoformat(selected_date)
        except ValueError:
            return Response({"detail": "date must be YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        assignments = list(rota_week.assignments.filter(work_date=selected_date).select_related("employee", "site", "shift_type"))
        by_slot = {}
        for assignment in assignments:
            key = (assignment.site_id, assignment.shift_type_id)
            by_slot.setdefault(key, []).append(assignment)
        sites = Site.objects.filter(is_active=True).order_by("name")
        if role_of(request.user) == "MANAGER":
            sites = sites.filter(manager_profiles__user=request.user)
        shifts = ShiftType.objects.filter(is_active=True).order_by("start_time", "name")
        requirements = {(item.site_id, item.shift_type_id): item.required_guards for item in SiteShiftRequirement.objects.filter(site__in=sites, weekday=selected_date.weekday())}
        slots = []
        for site in sites:
            for shift in shifts:
                slot_assignments = by_slot.get((site.id, shift.id), [])
                assigned = [assignment for assignment in slot_assignments if assignment.employee_id]
                required = requirements.get((site.id, shift.id), site.required_guards)
                slots.append({
                    "site": site.id,
                    "site_code": site.site_id,
                    "site_name": site.name,
                    "shift_type": shift.id,
                    "shift_name": shift.name,
                    "required": required,
                    "assigned": len(assigned),
                    "unfilled": max(required - len(assigned), 0),
                    "status": "FULL" if len(assigned) >= required else "PARTIAL" if assigned else "EMPTY",
                    "employees": [{"assignment": item.id, "employee": item.employee_id, "employee_name": item.employee.name, "employee_id": item.employee.employee_id} for item in assigned],
                })
        site_totals = []
        for site in sites:
            site_slots = [slot for slot in slots if slot["site"] == site.id]
            site_totals.append({
                "site": site.id,
                "site_code": site.site_id,
                "site_name": site.name,
                "required": sum(slot["required"] for slot in site_slots),
                "assigned": sum(slot["assigned"] for slot in site_slots),
                "unfilled": sum(slot["unfilled"] for slot in site_slots),
            })
        return Response({"date": selected_date, "rota_week": self.get_serializer(rota_week).data, "sites": site_totals, "slots": slots})

    @action(detail=True, methods=["post"])
    def generate_operations(self, request, pk=None):
        rota_week = self.get_object()
        selected_date = request.data.get("date") or str(timezone.localdate())
        try:
            selected_date = date.fromisoformat(selected_date)
        except ValueError:
            return Response({"detail": "date must be YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        created, updated, shifts = sync_rota_date_operations(rota_week, selected_date, request.user)
        reports = generate_daily_arrival_reports(selected_date, request.user, shifts)
        return Response({"date": selected_date, "created": created, "updated": updated, "total": created + updated, "reports": [{"id": report.id, "shift": report.shift_type.name, "pdf": report.pdf_file.url} for report in reports]})

    @action(detail=True, methods=["post"])
    def copy_to(self, request, pk=None):
        source = self.get_object()
        target_start = request.data.get("week_start")
        if not target_start:
            return Response({"detail": "week_start is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            target_date = date.fromisoformat(target_start)
        except ValueError:
            return Response({"detail": "week_start must be YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        target, _ = RotaWeek.objects.get_or_create(week_start=target_date, defaults={"created_by": request.user})
        if target.status == RotaWeek.Status.PUBLISHED:
            return Response({"detail": "The target rota is already published."}, status=status.HTTP_400_BAD_REQUEST)
        target.assignments.all().delete()
        offset = (target_date - source.week_start).days
        for assignment in source.assignments.all():
            RotaAssignment.objects.create(
                rota_week=target,
                work_date=assignment.work_date + timedelta(days=offset),
                shift_type=assignment.shift_type,
                scheduled_start=assignment.scheduled_start,
                scheduled_end=assignment.scheduled_end,
                employee=assignment.employee,
                site=assignment.site,
                notes=assignment.notes,
                created_by=request.user,
            )
        return Response(self.get_serializer(target).data)

    @action(detail=True, methods=["post"])
    def bulk_assign(self, request, pk=None):
        rota_week = self.get_object()
        if rota_week.status == RotaWeek.Status.PUBLISHED:
            return Response({"detail": "Published rotas cannot be changed. Reopen the rota before bulk assigning."}, status=status.HTTP_400_BAD_REQUEST)

        work_date = request.data.get("work_date")
        shift_type = request.data.get("shift_type")
        site = request.data.get("site")
        employee_ids = list(dict.fromkeys(request.data.get("employee_ids") or []))
        if not work_date or not shift_type or not site:
            return Response({"detail": "Date, shift and site are required."}, status=status.HTTP_400_BAD_REQUEST)
        if not employee_ids:
            return Response({"detail": "Select at least one employee."}, status=status.HTTP_400_BAD_REQUEST)
        if role_of(request.user) == "MANAGER" and not request.user.profile.managed_sites.filter(pk=site).exists():
            return Response({"detail": "This site is outside your assigned management scope."}, status=status.HTTP_403_FORBIDDEN)

        employees = []
        for employee_id in employee_ids:
            try:
                employee = Employee.objects.get(pk=employee_id)
            except (Employee.DoesNotExist, TypeError, ValueError):
                return Response({"detail": f"Employee {employee_id} was not found."}, status=status.HTTP_400_BAD_REQUEST)
            employees.append(employee)

        payloads = [
            {
                "rota_week": rota_week.id,
                "work_date": work_date,
                "shift_type": shift_type,
                "site": site,
                "employee": employee.id,
                "notes": request.data.get("notes", ""),
            }
            for employee in employees
        ]
        serializers = [RotaAssignmentSerializer(data=payload, context={"request": request}) for payload in payloads]
        errors = []
        for employee, assignment_serializer in zip(employees, serializers):
            if not assignment_serializer.is_valid():
                errors.append({"employee": employee.name, "errors": assignment_serializer.errors})
        if errors:
            return Response({"detail": "Some employees could not be assigned.", "errors": errors}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            created = [assignment_serializer.save(created_by=request.user) for assignment_serializer in serializers]
        sync_rota_date_operations(rota_week, created[0].work_date, request.user)
        generate_daily_arrival_reports(created[0].work_date, request.user)
        return Response({"created": len(created), "assignment_ids": [assignment.id for assignment in created]}, status=status.HTTP_201_CREATED)


class RotaAssignmentViewSet(viewsets.ModelViewSet):
    serializer_class = RotaAssignmentSerializer
    permission_classes = [IsAdminOrManager]

    def get_queryset(self):
        queryset = RotaAssignment.objects.select_related("employee", "site", "shift_type")
        rota_week = self.request.query_params.get("rota_week")
        if rota_week:
            queryset = queryset.filter(rota_week_id=rota_week)
        if role_of(self.request.user) == "MANAGER":
            queryset = queryset.filter(site__manager_profiles__user=self.request.user)
        return queryset

    def perform_create(self, serializer):
        if role_of(self.request.user) == "MANAGER" and not self.request.user.profile.managed_sites.filter(pk=serializer.validated_data["site"].pk).exists():
            raise PermissionDenied("This site is outside your assigned management scope.")
        assignment = serializer.save(created_by=self.request.user)
        sync_rota_date_operations(assignment.rota_week, assignment.work_date, self.request.user)
        generate_daily_arrival_reports(assignment.work_date, self.request.user)

    def perform_update(self, serializer):
        if role_of(self.request.user) == "MANAGER" and not self.request.user.profile.managed_sites.filter(pk=serializer.validated_data.get("site", serializer.instance.site).pk).exists():
            raise PermissionDenied("This site is outside your assigned management scope.")
        previous = self.get_object()
        previous_date = previous.work_date
        previous_site = previous.site_id
        previous_shift = previous.shift_type_id
        previous_employee = previous.employee_id
        assignment = serializer.save()
        if (previous_site, previous_shift, previous_employee) != (assignment.site_id, assignment.shift_type_id, assignment.employee_id):
            DailyOperation.objects.filter(operation_date=previous_date, site_id=previous_site, shift_type_id=previous_shift, employee_id=previous_employee).delete()
        sync_rota_date_operations(assignment.rota_week, assignment.work_date, self.request.user)
        generate_daily_arrival_reports(assignment.work_date, self.request.user)

    def perform_destroy(self, instance):
        report_date = instance.work_date
        site_id = instance.site_id
        shift_id = instance.shift_type_id
        employee_id = instance.employee_id
        rota_week = instance.rota_week
        instance.delete()
        DailyOperation.objects.filter(operation_date=report_date, site_id=site_id, shift_type_id=shift_id, employee_id=employee_id).delete()
        sync_rota_date_operations(rota_week, report_date, self.request.user)
        generate_daily_arrival_reports(report_date, self.request.user)


class LeaveRecordViewSet(viewsets.ModelViewSet):
    serializer_class = LeaveRecordSerializer
    permission_classes = [IsAdminOrManager]

    def get_queryset(self):
        queryset = LeaveRecord.objects.select_related("employee", "approved_by")
        status_filter = self.request.query_params.get("status")
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        if role_of(self.request.user) == "MANAGER":
            queryset = queryset.filter(employee__rota_assignments__site__manager_profiles__user=self.request.user).distinct()
        return queryset

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        leave = self.get_object()
        leave.status = LeaveRecord.Status.APPROVED
        leave.approved_by = request.user
        leave.approved_at = timezone.now()
        leave.save(update_fields=["status", "approved_by", "approved_at", "updated_at"])
        Notification.objects.create(user=request.user, notification_type=Notification.Type.SUCCESS, title="Leave approved", message=f"Leave for {leave.employee.name} was approved.", link="leave")
        AuditLog.objects.create(user=request.user, action="APPROVE", model_name="LeaveRecord", object_id=leave.pk, summary=f"Approved leave for {leave.employee.name}")
        return Response(self.get_serializer(leave).data)

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        leave = self.get_object()
        leave.status = LeaveRecord.Status.REJECTED
        leave.approved_by = request.user
        leave.approved_at = timezone.now()
        leave.save(update_fields=["status", "approved_by", "approved_at", "updated_at"])
        Notification.objects.create(user=request.user, notification_type=Notification.Type.WARNING, title="Leave rejected", message=f"Leave for {leave.employee.name} was rejected.", link="leave")
        AuditLog.objects.create(user=request.user, action="REJECT", model_name="LeaveRecord", object_id=leave.pk, summary=f"Rejected leave for {leave.employee.name}")
        return Response(self.get_serializer(leave).data)


class EmployeeDocumentViewSet(viewsets.ModelViewSet):
    serializer_class = EmployeeDocumentSerializer
    permission_classes = [IsAdminManagerOrEmployeeDocument]

    def get_queryset(self):
        queryset = EmployeeDocument.objects.select_related("employee")
        role = role_of(self.request.user)
        if role == "EMPLOYEE":
            queryset = queryset.filter(employee__user=self.request.user)
        elif role == "MANAGER":
            queryset = queryset.filter(employee__rota_assignments__site__manager_profiles__user=self.request.user).distinct()
        status_filter = self.request.query_params.get("status")
        if status_filter:
            today = timezone.localdate()
            if status_filter == "EXPIRED":
                queryset = queryset.filter(expiry_date__lt=today)
            elif status_filter == "EXPIRING_SOON":
                queryset = queryset.filter(expiry_date__gte=today, expiry_date__lte=today + timedelta(days=30))
            elif status_filter == "VALID":
                queryset = queryset.filter(Q(expiry_date__isnull=True) | Q(expiry_date__gt=today + timedelta(days=30)))
        return queryset

    def perform_update(self, serializer):
        role = getattr(getattr(self.request.user, "profile", None), "role", None)
        if role == "EMPLOYEE":
            own_employee = Employee.objects.filter(user=self.request.user).first()
            next_employee = serializer.validated_data.get("employee", serializer.instance.employee)
            next_type = serializer.validated_data.get("document_type", serializer.instance.document_type)
            if not own_employee or serializer.instance.employee.user_id != self.request.user.id or next_employee.pk != own_employee.pk or next_type != serializer.instance.document_type:
                raise PermissionDenied("You can only update the file or notes of your own document.")
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        if getattr(getattr(request.user, "profile", None), "role", None) == "EMPLOYEE":
            raise PermissionDenied("Employees cannot delete documents. Ask the office to remove one.")
        return super().destroy(request, *args, **kwargs)

    @action(detail=False, methods=["get"], url_path="employee-summary")
    def employee_summary(self, request):
        query = request.query_params.get("q", "").strip()
        status_filter = request.query_params.get("status", "ALL").upper()
        try:
            page_size = min(max(int(request.query_params.get("page_size", 25)), 1), 100)
        except ValueError:
            page_size = 25

        employees = Employee.objects.all().order_by("name", "employee_id")
        if role_of(request.user) == "MANAGER":
            employees = employees.filter(rota_assignments__site__manager_profiles__user=request.user).distinct()
        if query:
            employees = employees.filter(Q(name__icontains=query) | Q(employee_id__icontains=query))
        document_queryset = EmployeeDocument.objects.select_related("employee").order_by("expiry_date", "document_type")
        employees = employees.prefetch_related(Prefetch("documents", queryset=document_queryset, to_attr="summary_documents"))

        summaries = []
        today = timezone.localdate()
        soon_limit = today + timedelta(days=30)
        for employee in employees:
            documents = list(getattr(employee, "summary_documents", []))
            expired = [document for document in documents if document.expiry_date and document.expiry_date < today]
            expiring = [document for document in documents if document.expiry_date and today <= document.expiry_date <= soon_limit]
            valid = len(documents) - len(expired) - len(expiring)
            if not documents:
                compliance_status = "NO_DOCUMENTS"
            elif expired:
                compliance_status = "EXPIRED"
            elif expiring:
                compliance_status = "EXPIRING_SOON"
            else:
                compliance_status = "VALID"
            if status_filter != "ALL" and compliance_status != status_filter:
                continue
            summaries.append({
                "employee": employee.id,
                "employee_id": employee.employee_id,
                "employee_name": employee.name,
                "employee_status": employee.status,
                "documents_count": len(documents),
                "valid_documents": valid,
                "expired_documents": len(expired),
                "expiring_documents": len(expiring),
                "compliance_status": compliance_status,
                "nearest_expiry": min((document.expiry_date for document in documents if document.expiry_date), default=None),
                "documents": EmployeeDocumentSerializer(documents, many=True, context={"request": request}).data,
            })

        paginator = Paginator(summaries, page_size)
        try:
            page_number = max(int(request.query_params.get("page", 1)), 1)
        except ValueError:
            page_number = 1
        page = paginator.get_page(page_number)
        return Response({
            "results": list(page.object_list),
            "pagination": {
                "page": page.number,
                "page_size": page_size,
                "total_pages": paginator.num_pages,
                "total_employees": paginator.count,
                "has_next": page.has_next(),
                "has_previous": page.has_previous(),
            },
        })

    def perform_create(self, serializer):
        role = getattr(getattr(self.request.user, "profile", None), "role", None)
        employee = serializer.validated_data.get("employee")
        if role == "EMPLOYEE":
            own_employee = Employee.objects.filter(user=self.request.user).first()
            if not own_employee or employee.pk != own_employee.pk:
                raise PermissionDenied("You can only add documents to your own profile.")
        serializer.save(created_by=self.request.user)


class TimesheetViewSet(viewsets.ModelViewSet):
    serializer_class = TimesheetSerializer
    permission_classes = [IsAdminOrManager]

    def get_queryset(self):
        queryset = Timesheet.objects.select_related("employee", "site")
        start_date = self.request.query_params.get("start_date")
        end_date = self.request.query_params.get("end_date")
        if start_date:
            queryset = queryset.filter(work_date__gte=start_date)
        if end_date:
            queryset = queryset.filter(work_date__lte=end_date)
        if role_of(self.request.user) == "MANAGER":
            queryset = queryset.filter(site__manager_profiles__user=self.request.user)
        return queryset

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)


class DailyOperationViewSet(viewsets.ModelViewSet):
    serializer_class = DailyOperationSerializer
    permission_classes = [IsAdminManagerOrEmployeeOperation]

    def get_queryset(self):
        queryset = DailyOperation.objects.select_related("employee", "site", "shift_type").prefetch_related("attendance_events")
        role = role_of(self.request.user)
        if role == "EMPLOYEE":
            queryset = queryset.filter(employee__user=self.request.user)
        elif role == "MANAGER":
            queryset = queryset.filter(site__manager_profiles__user=self.request.user)
        operation_date = self.request.query_params.get("operation_date")
        if operation_date:
            queryset = queryset.filter(operation_date=operation_date)
        return queryset

    @action(detail=True, methods=["post"])
    def attendance(self, request, pk=None):
        operation = self.get_object()
        if not operation.employee_id:
            return Response({"detail": "This shift has no assigned guard."}, status=status.HTTP_400_BAD_REQUEST)
        event_type = (request.data.get("event_type") or "").upper()
        valid_types = {choice.value for choice in ShiftAttendanceEvent.EventType}
        if event_type not in valid_types:
            return Response({"detail": "event_type must be BOOK_ON, HOURLY or BOOK_OFF."}, status=status.HTTP_400_BAD_REQUEST)
        photo = request.FILES.get("photo")
        if not photo or not (photo.content_type or "").startswith("image/"):
            return Response({"detail": "A live image file is required for every attendance event."}, status=status.HTTP_400_BAD_REQUEST)
        if event_type in {ShiftAttendanceEvent.EventType.BOOK_ON, ShiftAttendanceEvent.EventType.BOOK_OFF} and operation.attendance_events.filter(event_type=event_type).exists():
            return Response({"detail": f"{event_type.replace('_', ' ').title()} has already been recorded for this shift."}, status=status.HTTP_400_BAD_REQUEST)
        if event_type in {ShiftAttendanceEvent.EventType.HOURLY, ShiftAttendanceEvent.EventType.BOOK_OFF} and not operation.attendance_events.filter(event_type=ShiftAttendanceEvent.EventType.BOOK_ON).exists():
            return Response({"detail": "Book On must be completed before this attendance event."}, status=status.HTTP_400_BAD_REQUEST)
        if event_type == ShiftAttendanceEvent.EventType.HOURLY and operation.attendance_events.filter(event_type=ShiftAttendanceEvent.EventType.BOOK_OFF).exists():
            return Response({"detail": "This shift is already booked off."}, status=status.HTTP_400_BAD_REQUEST)
        if event_type == ShiftAttendanceEvent.EventType.HOURLY:
            last_checkpoint = operation.attendance_events.filter(event_type__in=[ShiftAttendanceEvent.EventType.BOOK_ON, ShiftAttendanceEvent.EventType.HOURLY]).order_by("-captured_at").first()
            if last_checkpoint and timezone.now() - last_checkpoint.captured_at < timedelta(minutes=50):
                return Response({"detail": "Hourly check-in is only available once per hour."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            latitude = float(request.data.get("latitude")) if request.data.get("latitude") not in (None, "") else None
            longitude = float(request.data.get("longitude")) if request.data.get("longitude") not in (None, "") else None
            accuracy_m = float(request.data.get("accuracy_m")) if request.data.get("accuracy_m") not in (None, "") else None
        except (TypeError, ValueError):
            return Response({"detail": "Location coordinates must be valid numbers."}, status=status.HTTP_400_BAD_REQUEST)
        if (latitude is None) != (longitude is None):
            return Response({"detail": "Both latitude and longitude are required together."}, status=status.HTTP_400_BAD_REQUEST)
        distance_m = None
        if latitude is not None and operation.site.latitude is not None and operation.site.longitude is not None:
            distance_m = round(haversine_distance_m(latitude, longitude, operation.site.latitude, operation.site.longitude), 2)
            if accuracy_m is not None and accuracy_m > max(operation.site.geofence_radius_m, 200):
                location_status = ShiftAttendanceEvent.LocationStatus.LOCATION_UNVERIFIED
            elif distance_m > operation.site.geofence_radius_m:
                location_status = ShiftAttendanceEvent.LocationStatus.OUTSIDE_SITE
            else:
                location_status = ShiftAttendanceEvent.LocationStatus.VERIFIED
        else:
            location_status = ShiftAttendanceEvent.LocationStatus.LOCATION_UNVERIFIED
        sequence = 0
        if event_type == ShiftAttendanceEvent.EventType.HOURLY:
            last_sequence = operation.attendance_events.filter(event_type=event_type).order_by("-sequence").values_list("sequence", flat=True).first()
            sequence = (last_sequence or 0) + 1
        event = ShiftAttendanceEvent.objects.create(operation=operation, event_type=event_type, sequence=sequence, photo=photo, latitude=latitude, longitude=longitude, accuracy_m=accuracy_m, distance_m=distance_m, location_status=location_status, notes=(request.data.get("notes") or "")[:250], created_by=request.user)
        if event_type == ShiftAttendanceEvent.EventType.BOOK_ON and location_status == ShiftAttendanceEvent.LocationStatus.VERIFIED:
            operation.reached_at = event.captured_at
            operation.reached_by = request.user
            operation.status = DailyOperation.Status.PRESENT
            operation.save(update_fields=["reached_at", "reached_by", "status", "updated_at"])
            generate_daily_arrival_reports(operation.operation_date, request.user)
        AuditLog.objects.create(user=request.user, action="ATTENDANCE", model_name="ShiftAttendanceEvent", object_id=str(event.pk), summary=f"{operation.employee.name} submitted {event.get_event_type_display()} at {operation.site.name} ({event.location_status})")
        operation = self.get_queryset().get(pk=operation.pk)
        return Response({"event": ShiftAttendanceEventSerializer(event, context={"request": request}).data, "operation": self.get_serializer(operation).data}, status=status.HTTP_201_CREATED)

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=["post"], url_path="mark-reached")
    def mark_reached(self, request, pk=None):
        operation = self.get_object()
        if not operation.employee_id:
            return Response({"detail": "An employee must be assigned before marking reached."}, status=status.HTTP_400_BAD_REQUEST)
        operation.reached_at = timezone.now()
        operation.reached_by = request.user
        operation.status = DailyOperation.Status.PRESENT
        operation.save(update_fields=["reached_at", "reached_by", "status", "updated_at"])
        generate_daily_arrival_reports(operation.operation_date, request.user)
        AuditLog.objects.create(user=request.user, action="UPDATE", model_name="DailyOperation", object_id=operation.pk, summary=f"Marked {operation.employee.name} reached at {operation.site.name}")
        return Response(self.get_serializer(operation).data)


class DailyArrivalReportViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = DailyArrivalReportSerializer
    permission_classes = [IsAdminOrManager]

    def get_queryset(self):
        queryset = DailyArrivalReport.objects.select_related("shift_type", "generated_by")
        start_date = self.request.query_params.get("start_date")
        end_date = self.request.query_params.get("end_date")
        if start_date:
            queryset = queryset.filter(report_date__gte=start_date)
        if end_date:
            queryset = queryset.filter(report_date__lte=end_date)
        return queryset

    @action(detail=False, methods=["post"])
    def generate(self, request):
        report_date = request.data.get("date") or str(timezone.localdate())
        try:
            report_date = date.fromisoformat(report_date)
        except ValueError:
            return Response({"detail": "date must be YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        reports = generate_daily_arrival_reports(report_date, request.user)
        return Response(self.get_serializer(reports, many=True).data)


class NotificationViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [IsInternalUser]

    def get_queryset(self):
        create_expiry_notifications(self.request.user)
        return Notification.objects.filter(Q(user=self.request.user) | Q(user__isnull=True))

    @action(detail=False, methods=["post"])
    def check_expiry(self, request):
        created = create_expiry_notifications(request.user)
        return Response({"created": created})

    @action(detail=True, methods=["post"])
    def mark_read(self, request, pk=None):
        notification = self.get_object()
        notification.is_read = True
        notification.save(update_fields=["is_read"])
        return Response(self.get_serializer(notification).data)


class UserViewSet(viewsets.ModelViewSet):
    serializer_class = UserSerializer
    permission_classes = [IsAdminOnly]

    def get_queryset(self):
        return User.objects.select_related("profile").order_by("username")


class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = AuditLog.objects.select_related("user")
    serializer_class = AuditLogSerializer
    permission_classes = [IsAdminOnly]


@api_view(["GET"])
@permission_classes([IsInternalUser])
def reports_summary(request):
    today = timezone.localdate()
    start_date = request.query_params.get("start_date")
    end_date = request.query_params.get("end_date")
    if not start_date:
        start_date = today - timedelta(days=today.weekday())
    else:
        start_date = date.fromisoformat(start_date)
    if not end_date:
        end_date = start_date + timedelta(days=6)
    else:
        end_date = date.fromisoformat(end_date)

    timesheets = Timesheet.objects.filter(work_date__range=(start_date, end_date)).select_related("employee", "site")
    employee_totals = {}
    site_totals = {}
    total_hours = 0
    total_overtime = 0
    for sheet in timesheets:
        hours = sheet.actual_hours
        total_hours += hours
        total_overtime += sheet.overtime_minutes
        employee_totals[sheet.employee.name] = round(employee_totals.get(sheet.employee.name, 0) + hours, 2)
        site_name = sheet.site.name if sheet.site else "Unassigned"
        site_totals[site_name] = round(site_totals.get(site_name, 0) + hours, 2)

    leave_count = LeaveRecord.objects.filter(status=LeaveRecord.Status.APPROVED, start_date__lte=end_date, end_date__gte=start_date).count()
    expiring_documents = EmployeeDocument.objects.filter(expiry_date__gte=today, expiry_date__lte=today + timedelta(days=30)).count()
    operations = DailyOperation.objects.filter(operation_date__range=(start_date, end_date)).select_related("employee", "site", "shift_type", "reached_by").order_by("operation_date", "site__name", "shift_type__start_time", "employee__name")
    arrival_rows = []
    arrival_counts = {"scheduled": 0, "reached": 0, "late": 0, "not_reached": 0, "not_assigned": 0}
    current_timezone = timezone.get_current_timezone()
    from datetime import datetime
    for operation in operations:
        arrival_counts["scheduled"] += 1
        if not operation.employee_id:
            arrival_status = "NOT_ASSIGNED"
            arrival_counts["not_assigned"] += 1
            delay_minutes = None
        elif not operation.reached_at:
            arrival_status = "NOT_REACHED"
            arrival_counts["not_reached"] += 1
            delay_minutes = None
        else:
            scheduled_at = timezone.make_aware(datetime.combine(operation.operation_date, operation.shift_type.start_time), current_timezone)
            delay_minutes = max(0, round((operation.reached_at - scheduled_at).total_seconds() / 60))
            arrival_status = "LATE" if delay_minutes > 0 else "REACHED"
            arrival_counts["late" if arrival_status == "LATE" else "reached"] += 1
        arrival_rows.append({
            "id": operation.id,
            "date": operation.operation_date,
            "employee": operation.employee_id,
            "employee_id": operation.employee.employee_id if operation.employee else None,
            "employee_name": operation.employee.name if operation.employee else "Unassigned",
            "site": operation.site_id,
            "site_name": operation.site.name,
            "shift_name": operation.shift_type.name,
            "scheduled_start": operation.shift_type.start_time,
            "reached_at": operation.reached_at,
            "reached_by_name": operation.reached_by.get_full_name() or operation.reached_by.get_username() if operation.reached_by else None,
            "delay_minutes": delay_minutes,
            "status": operation.status,
            "arrival_status": arrival_status,
        })
    return Response({
        "start_date": start_date,
        "end_date": end_date,
        "timesheet_count": timesheets.count(),
        "total_hours": round(total_hours, 2),
        "overtime_minutes": total_overtime,
        "approved_leave_records": leave_count,
        "documents_expiring_soon": expiring_documents,
        "employee_hours": [{"name": name, "hours": hours} for name, hours in sorted(employee_totals.items())],
        "site_hours": [{"name": name, "hours": hours} for name, hours in sorted(site_totals.items())],
        "arrival_summary": arrival_counts,
        "arrival_rows": arrival_rows,
    })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def timesheets_csv(request):
    start_date = request.query_params.get("start_date")
    end_date = request.query_params.get("end_date")
    queryset = Timesheet.objects.select_related("employee", "site")
    if start_date:
        queryset = queryset.filter(work_date__gte=start_date)
    if end_date:
        queryset = queryset.filter(work_date__lte=end_date)
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = 'attachment; filename="timesheets.csv"'
    writer = csv.writer(response)
    writer.writerow(["Date", "Employee", "Site", "Scheduled Hours", "Actual Hours", "Overtime Minutes", "Approved", "Notes"])
    for sheet in queryset:
        writer.writerow([sheet.work_date, sheet.employee.name, sheet.site.name if sheet.site else "", sheet.scheduled_hours, sheet.actual_hours, sheet.overtime_minutes, sheet.approved, sheet.notes])
    return response


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def rota_csv(request):
    queryset = RotaAssignment.objects.select_related("rota_week", "employee", "site", "shift_type")
    rota_week = request.query_params.get("rota_week")
    if rota_week:
        queryset = queryset.filter(rota_week_id=rota_week)
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = 'attachment; filename="weekly-rota.csv"'
    writer = csv.writer(response)
    writer.writerow(["Week Starting", "Date", "Shift", "Site", "Employee", "Notes"])
    for assignment in queryset:
        writer.writerow([assignment.rota_week.week_start, assignment.work_date, assignment.shift_type.name, assignment.site.name, assignment.employee.name if assignment.employee else "Unfilled", assignment.notes])
    return response


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def report_print(request):
    today = timezone.localdate()
    start_date = date.fromisoformat(request.query_params["start_date"]) if request.query_params.get("start_date") else today - timedelta(days=today.weekday())
    end_date = date.fromisoformat(request.query_params["end_date"]) if request.query_params.get("end_date") else start_date + timedelta(days=6)
    timesheets = Timesheet.objects.filter(work_date__range=(start_date, end_date)).select_related("employee", "site")
    rows = "".join(f"<tr><td>{sheet.work_date}</td><td>{sheet.employee.name}</td><td>{sheet.site.name if sheet.site else 'Unassigned'}</td><td>{sheet.actual_hours}h</td><td>{sheet.overtime_minutes} min</td></tr>" for sheet in timesheets)
    html = f"""<!doctype html><html><head><meta charset='utf-8'><title>Rota Report</title><style>body{{font-family:Arial,sans-serif;color:#182137;margin:36px}}h1{{margin-bottom:4px}}p{{color:#6e7d93}}table{{border-collapse:collapse;width:100%;margin-top:24px}}th,td{{border:1px solid #dbe2ec;padding:9px;text-align:left;font-size:12px}}th{{background:#eef2f8}}@media print{{button{{display:none}}}}</style></head><body><button onclick='window.print()'>Print / Save as PDF</button><h1>Working Hours Report</h1><p>{start_date} to {end_date}</p><table><thead><tr><th>Date</th><th>Employee</th><th>Site</th><th>Actual Hours</th><th>Overtime</th></tr></thead><tbody>{rows or '<tr><td colspan="5">No timesheets in this period.</td></tr>'}</tbody></table></body></html>"""
    return HttpResponse(html)


def create_expiry_notifications(user):
    today = timezone.localdate()
    window_end = today + timedelta(days=30)
    documents = EmployeeDocument.objects.filter(expiry_date__isnull=False, expiry_date__lte=window_end).select_related("employee")
    created = 0
    for document in documents:
        state = "expired" if document.expiry_date < today else "expires soon"
        title = f"Document {state}"
        message = f"{document.employee.name}: {document.document_type} expires on {document.expiry_date}."
        already_exists = Notification.objects.filter(user__isnull=True, title=title, message=message, created_at__date=today).exists()
        if not already_exists:
            Notification.objects.create(user=None, notification_type=Notification.Type.WARNING, title=title, message=message, link="documents")
            created += 1
    return created
