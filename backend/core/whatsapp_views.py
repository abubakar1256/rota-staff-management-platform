from collections import defaultdict

from django.db import transaction
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from .models import AuditLog, Employee, RotaWeek, RotaWhatsAppShare, WhatsAppAnnouncement, WhatsAppAnnouncementRecipient
from .permissions import IsAdminOrSuperAdmin
from .whatsapp import message_version, rota_message, shift_key, shift_snapshot, whatsapp_link


class AnnouncementInput(serializers.Serializer):
    title = serializers.CharField(max_length=120)
    message = serializers.CharField(max_length=1500)
    employee_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1), min_length=1, max_length=1000,
    )


class MarkSentInput(serializers.Serializer):
    version = serializers.RegexField(r"\A[a-f0-9]{64}\Z")


def private_response(data, code=status.HTTP_200_OK):
    return Response(data, status=code, headers={"Cache-Control": "private, no-store"})


def user_name(user):
    return (user.get_full_name() or user.get_username()) if user else None


def guard_data(employee):
    return {
        "id": employee.pk,
        "name": employee.name,
        "code": employee.employee_id,
        "has_whatsapp": bool(employee.whatsapp_number),
    }


def pending_status(employee, default):
    if employee.status != Employee.Status.ACTIVE:
        return "INACTIVE"
    if not employee.whatsapp_number:
        return "NUMBER_MISSING"
    return default


def mark_input(request):
    data = MarkSentInput(data=request.data)
    data.is_valid(raise_exception=True)
    return data.validated_data["version"]


def stale_message():
    return private_response(
        {"detail": "This recipient or message changed. Refresh the list and open the current message before confirming."},
        status.HTTP_409_CONFLICT,
    )


def audit_sent(request, record, employee_id):
    AuditLog.objects.create(
        user=request.user, action="WHATSAPP_SENT", model_name=record._meta.object_name,
        object_id=str(record.pk), summary="Admin manually confirmed a WhatsApp message was sent.",
        after_data={"employee_id": employee_id},
    )


@api_view(["GET"])
@permission_classes([IsAdminOrSuperAdmin])
def whatsapp_guards(request):
    guards = Employee.objects.filter(status=Employee.Status.ACTIVE).only("name", "employee_id", "whatsapp_number")
    return private_response([guard_data(guard) for guard in guards])


@api_view(["GET", "POST"])
@permission_classes([IsAdminOrSuperAdmin])
def announcements(request):
    if request.method == "GET":
        rows = WhatsAppAnnouncement.objects.select_related("created_by").annotate(
            total=Count("recipients"),
            sent=Count("recipients", filter=Q(recipients__sent_at__isnull=False)),
        )
        return private_response([
            {
                "id": row.pk, "title": row.title, "created_at": row.created_at,
                "created_by": user_name(row.created_by), "total": row.total, "sent": row.sent,
            }
            for row in rows
        ])

    data = AnnouncementInput(data=request.data)
    data.is_valid(raise_exception=True)
    selected_ids = set(data.validated_data["employee_ids"])
    with transaction.atomic():
        active_ids = set(Employee.objects.filter(pk__in=selected_ids, status=Employee.Status.ACTIVE).values_list("pk", flat=True))
        if active_ids != selected_ids:
            return private_response(
                {"detail": "Some selected guards are no longer active. Refresh the list and choose active guards."},
                status.HTTP_409_CONFLICT,
            )
        announcement = WhatsAppAnnouncement.objects.create(
            title=data.validated_data["title"], message=data.validated_data["message"], created_by=request.user,
        )
        WhatsAppAnnouncementRecipient.objects.bulk_create([
            WhatsAppAnnouncementRecipient(announcement=announcement, employee_id=employee_id)
            for employee_id in active_ids
        ])
    return private_response({"id": announcement.pk}, status.HTTP_201_CREATED)


def announcement_recipient(announcement, employee, recipient):
    state = "SENT" if recipient.sent_at else pending_status(employee, "PENDING")
    ready = state == "PENDING"
    return {
        **guard_data(employee), "status": state,
        "sent_at": recipient.sent_at, "sent_by": user_name(recipient.sent_by),
        "version": message_version(announcement.pk, employee.pk, employee.whatsapp_number, announcement.message) if ready else None,
        "whatsapp_url": whatsapp_link(employee.whatsapp_number, announcement.message) if ready else None,
    }


@api_view(["GET"])
@permission_classes([IsAdminOrSuperAdmin])
def announcement_detail(request, pk):
    announcement = get_object_or_404(WhatsAppAnnouncement, pk=pk)
    recipients = announcement.recipients.select_related("employee", "sent_by").order_by("employee__name", "pk")
    return private_response({
        "id": announcement.pk, "title": announcement.title, "message": announcement.message,
        "recipients": [announcement_recipient(announcement, row.employee, row) for row in recipients],
    })


@api_view(["POST"])
@permission_classes([IsAdminOrSuperAdmin])
@transaction.atomic
def mark_announcement_sent(request, pk, employee_id):
    expected = mark_input(request)
    announcement = get_object_or_404(WhatsAppAnnouncement, pk=pk)
    recipient = get_object_or_404(
        WhatsAppAnnouncementRecipient.objects.select_for_update(),
        announcement=announcement, employee_id=employee_id,
    )
    employee = Employee.objects.select_for_update().get(pk=employee_id)
    row = announcement_recipient(announcement, employee, recipient)
    if recipient.sent_at:
        return private_response(row)
    if row["version"] != expected:
        return stale_message()
    recipient.sent_by = request.user
    recipient.sent_at = timezone.now()
    recipient.save(update_fields=["sent_by", "sent_at"])
    audit_sent(request, recipient, employee_id)
    return private_response(announcement_recipient(announcement, employee, recipient))


def rota_shifts(assignments):
    return sorted(map(shift_snapshot, assignments), key=shift_key)


def rota_recipient(week, employee, shifts, previous):
    version_fields = (week.pk, week.week_start.isoformat(), employee.pk, employee.name, employee.whatsapp_number)
    version = message_version(*version_fields, list(map(shift_key, shifts)))
    already_sent = previous is not None and previous.version == version
    if previous and any("shift_name" not in shift for shift in previous.shifts):
        legacy_keys = [shift_key(shift, include_name=False) for shift in shifts]
        already_sent = previous.version == message_version(*version_fields, legacy_keys)
    state = "SENT" if already_sent else pending_status(employee, "UPDATE_PENDING" if previous else "PENDING")
    ready = state in {"PENDING", "UPDATE_PENDING"}
    message = rota_message(week.week_start, employee.name, shifts, previous.shifts if previous else None) if ready else None
    return {
        **guard_data(employee), "status": state,
        "sent_at": previous.sent_at if previous else None,
        "sent_by": user_name(previous.sent_by) if previous else None,
        "version": version if ready else None,
        "whatsapp_url": whatsapp_link(employee.whatsapp_number, message) if ready else None,
        "message": message,
    }


@api_view(["GET"])
@permission_classes([IsAdminOrSuperAdmin])
def rota_recipients(request, pk):
    week = get_object_or_404(RotaWeek, pk=pk)
    if week.status != RotaWeek.Status.PUBLISHED:
        return private_response({"published": False, "recipients": []})
    grouped = defaultdict(list)
    employees = {}
    for assignment in week.assignments.filter(employee__isnull=False).select_related("employee", "site", "shift_type"):
        employees[assignment.employee_id] = assignment.employee
        grouped[assignment.employee_id].append(assignment)
    previous = {
        share.employee_id: share
        for share in week.whatsapp_shares.select_related("employee", "sent_by")
    }
    for employee_id, share in previous.items():
        employees.setdefault(employee_id, share.employee)
    return private_response({
        "published": True,
        "recipients": [
            rota_recipient(week, employee, rota_shifts(grouped[employee.pk]), previous.get(employee.pk))
            for employee in sorted(employees.values(), key=lambda guard: (guard.name.casefold(), guard.pk))
        ],
    })


@api_view(["POST"])
@permission_classes([IsAdminOrSuperAdmin])
@transaction.atomic
def mark_rota_sent(request, pk, employee_id):
    expected = mark_input(request)
    week = get_object_or_404(RotaWeek.objects.select_for_update(), pk=pk)
    if week.status != RotaWeek.Status.PUBLISHED:
        return stale_message()
    employee = get_object_or_404(Employee.objects.select_for_update(), pk=employee_id)
    shifts = rota_shifts(week.assignments.filter(employee=employee).select_related("site", "shift_type"))
    previous = week.whatsapp_shares.select_related("sent_by").filter(employee=employee).first()
    if not shifts and not previous:
        return private_response({"detail": "This guard has no rota to share for the selected week."}, status.HTTP_404_NOT_FOUND)
    row = rota_recipient(week, employee, shifts, previous)
    if row["status"] == "SENT" and previous.version == expected:
        return private_response(row)
    if row["version"] != expected:
        return stale_message()
    record, _ = RotaWhatsAppShare.objects.update_or_create(
        rota_week=week, employee=employee,
        defaults={"shifts": shifts, "version": expected, "sent_at": timezone.now(), "sent_by": request.user},
    )
    audit_sent(request, record, employee_id)
    return private_response(rota_recipient(week, employee, shifts, record))
