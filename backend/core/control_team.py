from datetime import date, datetime, time, timedelta, timezone as utc_timezone
from io import BytesIO
from math import ceil
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.db.models import Prefetch, Q
from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from django.urls import path, reverse
from django.utils import timezone
from PIL import Image, ImageOps
from rest_framework import serializers, status
from rest_framework.authtoken.models import Token
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from .control_attendance import (
    AUTO_CHECKOUT_GRACE, EARLY_CHECK_IN_WINDOW, LONDON, assignment_status, attendance_settings,
    close_expired_attendance, minutes_late, notify_control_attendance, worked_start_at,
    shift_window, weekly_conflict_for_assignment, weekly_occurrence, weekly_occurrences, weekly_rules, weekly_schedule_conflict,
)
from .geo import haversine_distance_m
from .location_tracking import valid_coordinates
from .models import (
    AuditLog, ControlAttendance, ControlAttendanceSettings, ControlLeaveRequest, ControlShiftAssignment,
    ControlTeamMember, ControlWeeklyAssignment, Employee, Notification, UserProfile,
)
from .notifications import publish_control_notification
from .permissions import is_admin, role_of
from .serializers import LoginSerializer
from .views import NotificationViewSet

User = get_user_model()


class IsControlMember(BasePermission):
    def has_permission(self, request, view):
        return role_of(request.user) == UserProfile.Role.CONTROL_TEAM


class IsControlAdmin(BasePermission):
    def has_permission(self, request, view):
        return is_admin(request.user)


class ControlNotificationViewSet(NotificationViewSet):
    permission_classes = [IsControlAdmin | IsControlMember]

    def get_queryset(self):
        user = self.request.user
        audience = Q(user=user) | Q(user__isnull=True) if is_admin(user) else Q(user=user)
        return Notification.objects.filter(audience, link="control-team").order_by("-created_at", "-pk")

    def inbox(self, request):
        categories = [
            ("ATTENDANCE", "Attendance"), ("ROTA_STAFFING", "Shifts"),
            ("LEAVE_REPLACEMENT", "Leave & Replacement"), ("SYSTEM", "Team & Profile"),
        ]
        return self._inbox_data(request, self.get_queryset(), categories)

    def mark_all_read(self, request):
        return Response({"updated": self.get_queryset().filter(is_read=False).update(is_read=True)})


class ControlLoginThrottle(AnonRateThrottle):
    scope = "control_login"
    rate = "12/minute"


class ControlLoginSerializer(LoginSerializer):
    password = serializers.CharField(write_only=True, trim_whitespace=False)


class NewMemberSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=160)
    email = serializers.EmailField(max_length=150)
    password = serializers.CharField(min_length=12, max_length=128, write_only=True, trim_whitespace=False)

    def validate_email(self, value):
        value = value.lower()
        if User.objects.filter(Q(username__iexact=value) | Q(email__iexact=value)).exists() or Employee.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("This email is already in use. Enter a separate email for the Control Team account.")
        return value

    def create(self, data):
        user = User(username=data["email"], email=data["email"], first_name=data["name"][:150])
        try:
            validate_password(data["password"], user)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"password": exc.messages}) from exc
        user.set_password(data["password"])
        try:
            with transaction.atomic():
                user.save()
                UserProfile.objects.create(user=user, role=UserProfile.Role.CONTROL_TEAM)
                return ControlTeamMember.objects.create(user=user, name=data["name"])
        except IntegrityError as exc:
            if User.objects.filter(username=data["email"]).exists():
                raise serializers.ValidationError({"email": "This email is already in use."}) from exc
            raise


class ControlPhotoField(serializers.ImageField):
    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        if value.size > 10 * 1024 * 1024:
            raise serializers.ValidationError("Choose a photo up to 10 MB.")
        try:
            with Image.open(value) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"} or image.width * image.height > 36_000_000:
                    raise serializers.ValidationError("Choose a JPG, PNG or WebP photo up to 36 megapixels.")
                photo = ImageOps.exif_transpose(image).convert("RGB")
                photo.thumbnail((1000, 1000))
                output = BytesIO()
                photo.save(output, format="JPEG", quality=88)
        except (OSError, ValueError, Image.DecompressionBombError) as exc:
            raise serializers.ValidationError("This photo could not be read. Choose another image.") from exc
        return ContentFile(output.getvalue(), name=f"{uuid4().hex}.jpg")


class ProfileSerializer(serializers.ModelSerializer):
    phone = serializers.CharField(max_length=40)
    photo = ControlPhotoField(required=False, write_only=True)

    class Meta:
        model = ControlTeamMember
        fields = ["name", "phone", "photo"]

    def validate(self, data):
        if not data.get("photo") and not self.instance.photo:
            raise serializers.ValidationError({"photo": "Upload a profile photo to complete your profile."})
        return data

    def update(self, instance, data):
        old_photo = instance.photo
        member = super().update(instance, data)
        if "photo" in data and old_photo:
            transaction.on_commit(lambda: old_photo.storage.delete(old_photo.name), robust=True)
        return member


class AttendanceSerializer(serializers.ModelSerializer):
    check_in_photo_url = serializers.SerializerMethodField()
    check_out_photo_url = serializers.SerializerMethodField()
    shift_name = serializers.CharField(source="get_shift_display")
    late_minutes = serializers.SerializerMethodField()
    worked_start_at = serializers.SerializerMethodField()

    class Meta:
        model = ControlAttendance
        fields = [
            "id", "checked_in_at", "worked_start_at", "checked_out_at", "closed_by_admin",
            "check_in_photo_url", "check_out_photo_url", "check_in_location", "check_out_location",
            "shift", "shift_name", "scheduled_start_at", "scheduled_end_at", "auto_checkout_at", "auto_checked_out", "late_minutes",
        ]

    def get_late_minutes(self, entry):
        return minutes_late(entry)

    def get_worked_start_at(self, entry):
        return worked_start_at(entry)

    def get_check_in_photo_url(self, entry):
        if entry.check_in_photo:
            return reverse("control:attendance-photo", args=[entry.pk, "check_in"])

    def get_check_out_photo_url(self, entry):
        if entry.check_out_photo:
            return reverse("control:attendance-photo", args=[entry.pk, "check_out"])


class RequestSerializer(serializers.ModelSerializer):
    member_name = serializers.CharField(source="member.name", read_only=True)

    class Meta:
        model = ControlLeaveRequest
        fields = [
            "id", "member_name", "kind", "start_date", "end_date", "reason", "status",
            "review_note", "reviewed_at", "created_at",
        ]
        read_only_fields = ["status", "review_note", "reviewed_at", "created_at"]

    def validate(self, data):
        if data["end_date"] < data["start_date"]:
            raise serializers.ValidationError({"end_date": "End date must be on or after the start date."})
        return data


class AttendanceActionSerializer(serializers.Serializer):
    action = serializers.ChoiceField(choices=["check_in", "check_out"])
    photo = ControlPhotoField(error_messages={"required": "Take an attendance photo before submitting."})
    attendance_id = serializers.IntegerField(min_value=1, required=False)
    assignment_id = serializers.IntegerField(min_value=1, required=False)
    weekly_assignment_id = serializers.IntegerField(min_value=1, required=False)
    shift_date = serializers.DateField(required=False)

    def validate(self, data):
        if data["action"] == "check_out" and "attendance_id" not in data:
            raise serializers.ValidationError({"attendance_id": "Select the attendance entry to check out."})
        if data["action"] == "check_in":
            dated = "assignment_id" in data
            weekly = "weekly_assignment_id" in data
            if dated == weekly or weekly != ("shift_date" in data):
                raise serializers.ValidationError({"assignment_id": "Choose one of your assigned shifts before checking in."})
        return data


class AttendanceLocationSerializer(serializers.Serializer):
    latitude = serializers.FloatField()
    longitude = serializers.FloatField()
    accuracy_m = serializers.FloatField()

    def validate(self, data):
        if not valid_coordinates(data["latitude"], data["longitude"], data["accuracy_m"]):
            raise serializers.ValidationError("A valid GPS location and accuracy are required. Allow location access and try again.")
        return data


class ShiftTimingSerializer(serializers.Serializer):
    start = serializers.TimeField(input_formats=["%H:%M"])
    end = serializers.TimeField(input_formats=["%H:%M"])

    def validate(self, data):
        if data["start"] == data["end"]:
            raise serializers.ValidationError("Shift start and end must be different.")
        return {field: value.strftime("%H:%M") for field, value in data.items()}


class ControlSettingsSerializer(serializers.ModelSerializer):
    latitude = serializers.FloatField(allow_null=True)
    longitude = serializers.FloatField(allow_null=True)
    radius_m = serializers.IntegerField(min_value=1, max_value=2147483647)
    shifts = serializers.DictField(child=ShiftTimingSerializer())

    class Meta:
        model = ControlAttendanceSettings
        fields = ["address", "latitude", "longitude", "radius_m", "shifts"]

    def validate(self, data):
        latitude, longitude = data["latitude"], data["longitude"]
        if (latitude is not None or longitude is not None) and not valid_coordinates(latitude, longitude, 0):
            raise serializers.ValidationError("Enter valid latitude and longitude for the Control Team location.")
        if set(data["shifts"]) != set(ControlAttendance.Shift.values):
            raise serializers.ValidationError({"shifts": "Enter start and end times for all four shifts."})
        return data


class AssignmentMemberSerializer(serializers.Serializer):
    member = serializers.PrimaryKeyRelatedField(
        queryset=ControlTeamMember.objects.filter(user__is_active=True, user__profile__role=UserProfile.Role.CONTROL_TEAM),
    )


class NewAssignmentSerializer(AssignmentMemberSerializer):
    shift_date = serializers.DateField()
    shift = serializers.ChoiceField(choices=ControlAttendance.Shift.choices)


class NewWeeklyAssignmentSerializer(AssignmentMemberSerializer):
    shift = serializers.ChoiceField(choices=ControlAttendance.Shift.choices)
    weekdays = serializers.ListField(child=serializers.IntegerField(min_value=0, max_value=6), min_length=1, max_length=7)

    def validate_weekdays(self, value):
        return sorted(set(value))


class WeeklyAssignmentSerializer(serializers.ModelSerializer):
    member_name = serializers.CharField(source="member.name")
    start_time = serializers.TimeField(format="%H:%M")
    end_time = serializers.TimeField(format="%H:%M")

    class Meta:
        model = ControlWeeklyAssignment
        fields = ["id", "member", "member_name", "shift", "weekdays", "start_time", "end_time", "starts_on"]


class ShiftAssignmentSerializer(serializers.ModelSerializer):
    member_name = serializers.CharField(source="member.name")
    shift_name = serializers.CharField(source="get_shift_display")
    status = serializers.SerializerMethodField()
    started = serializers.SerializerMethodField()

    class Meta:
        model = ControlShiftAssignment
        fields = [
            "id", "member", "member_name", "shift", "shift_date", "shift_name",
            "scheduled_start_at", "scheduled_end_at", "status", "started",
        ]

    def get_status(self, assignment):
        return assignment_status(assignment, self.context["now"])

    def get_started(self, assignment):
        return hasattr(assignment, "attendance")


def save_assignment(serializer, settings, assignment=None):
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    if assignment:
        shift_date, shift = assignment.shift_date, assignment.shift
        start, end = assignment.scheduled_start_at, assignment.scheduled_end_at
    else:
        shift_date, shift = data["shift_date"], data["shift"]
        start, end = shift_window(settings.shifts[shift], shift_date)
        if start >= end:
            raise serializers.ValidationError({"detail": "These shift times are unavailable on the selected UK clock-change date."})
    member = data["member"]
    conflicts = ControlShiftAssignment.objects.filter(member=member).filter(
        Q(scheduled_start_at__lt=end, scheduled_end_at__gt=start) | Q(shift_date=shift_date, shift=shift),
    )
    if assignment:
        conflicts = conflicts.exclude(pk=assignment.pk)
    conflict = conflicts.first()
    if not conflict:
        conflict = weekly_conflict_for_assignment(ControlShiftAssignment(
            member=member, shift_date=shift_date, shift=shift, scheduled_start_at=start, scheduled_end_at=end,
        ))
    if conflict:
        raise serializers.ValidationError({
            "detail": f"{member.name} already has a conflicting {conflict.get_shift_display()} shift on {conflict.shift_date:%d %b %Y}.",
        })
    if assignment:
        assignment.member = member
        assignment.save(update_fields=["member"])
        return assignment
    return ControlShiftAssignment.objects.create(
        member=member, shift=shift, shift_date=shift_date, scheduled_start_at=start, scheduled_end_at=end,
    )


def save_weekly_assignment(data, settings, today):
    serializer = NewWeeklyAssignmentSerializer(data=data)
    serializer.is_valid(raise_exception=True)
    timing = settings.shifts[serializer.validated_data["shift"]]
    rule = ControlWeeklyAssignment(
        **serializer.validated_data, starts_on=today,
        start_time=time.fromisoformat(timing["start"]), end_time=time.fromisoformat(timing["end"]),
    )
    conflict = weekly_schedule_conflict(rule)
    if conflict:
        raise serializers.ValidationError({
            "detail": f"{rule.member.name} already has a conflicting {conflict.get_shift_display()} shift on {conflict.shift_date:%a %d %b %Y}.",
        })
    rule.save()
    return rule


def notify_shift_assignment(assignment, action, audit_id, *, member=None):
    member = member or assignment.member
    shift = assignment.get_shift_display()
    if isinstance(assignment, ControlWeeklyAssignment):
        weekday_names = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
        days = ", ".join(weekday_names[day] for day in assignment.weekdays)
        details = f"weekly {shift} shift ({days}, {assignment.start_time:%H:%M}–{assignment.end_time:%H:%M} UK time)"
    else:
        start = assignment.scheduled_start_at.astimezone(LONDON)
        end = assignment.scheduled_end_at.astimezone(LONDON)
        details = f"{shift} shift ({start:%d %b %Y, %H:%M %Z} to {end:%d %b %Y, %H:%M %Z})"
    for office in (False, True):
        owner = f"{member.name}'s" if office else "Your"
        publish_control_notification(
            member, office=office, tab="settings", title=f"Control Team: Shift {action}" if office else f"Shift {action}",
            message=f"{owner} {details} was {action}.", event_key=f"schedule:{audit_id}:{member.pk}:{action}",
            category="ROTA_STAFFING",
        )


def schedule_rows(dated, rules, first, last, now, *, after=None):
    shifts = [(entry, None) for entry in dated]
    occupied = {(entry.member_id, entry.shift_date, entry.shift) for entry, _ in shifts}
    for rule in rules:
        shifts.extend(
            (entry, rule.pk) for entry in weekly_occurrences(rule, first, last)
            if (after is None or entry.scheduled_end_at > after)
            and (entry.member_id, entry.shift_date, entry.shift) not in occupied
        )

    data = []
    for entry, weekly_id in sorted(shifts, key=lambda slot: slot[0].scheduled_start_at):
        row = ShiftAssignmentSerializer(entry, context={"now": now}).data
        if weekly_id is not None:
            row.update(id=f"{weekly_id}:{entry.shift_date.isoformat()}", weekly_assignment_id=weekly_id)
        data.append(row)
    return data


def member_schedule(member, now, start):
    first, last = start - timedelta(days=1), start + timedelta(days=6)
    midnight = datetime.combine(start, time.min, LONDON)
    dated = member.shift_assignments.filter(
        shift_date__range=(first, last), scheduled_end_at__gt=midnight,
    ).select_related("member", "attendance")
    approved_leave = member.requests.filter(
        kind=ControlLeaveRequest.Kind.LEAVE, status=ControlLeaveRequest.Status.APPROVED,
        start_date__lte=last, end_date__gte=start,
    ).values_list("start_date", "end_date")
    days = [start + timedelta(days=offset) for offset in range(7)]
    leave_dates = {day.isoformat() for leave_start, leave_end in approved_leave for day in days if leave_start <= day <= leave_end}
    return {
        "schedule_start": start.isoformat(),
        "assigned_shifts": schedule_rows(dated, weekly_rules(member.pk, first), first, last, now, after=midnight),
        "approved_leave_dates": sorted(leave_dates),
    }


def check_in_assignment(member, data, now):
    assignments = member.shift_assignments.select_for_update()
    if "assignment_id" in data:
        return assignments.filter(pk=data["assignment_id"]).first()
    day = data["shift_date"]
    today = now.astimezone(LONDON).date()
    latest_start_date = (now + EARLY_CHECK_IN_WINDOW).astimezone(LONDON).date()
    if not today - timedelta(days=1) <= day <= latest_start_date:
        return None
    rule = weekly_rules(member.pk, day).filter(pk=data["weekly_assignment_id"]).first()
    occurrence = weekly_occurrence(rule, day) if rule else None
    if occurrence is None:
        return None
    return assignments.filter(shift_date=day, shift=rule.shift).first() or occurrence


def attendance_location(data, settings, shift):
    if shift == ControlAttendance.Shift.NIGHT:
        return None
    serializer = AttendanceLocationSerializer(data=data)
    serializer.is_valid(raise_exception=True)
    location = serializer.validated_data
    if settings.latitude is None or settings.longitude is None:
        raise serializers.ValidationError({"detail": "The Control Team location is not set. Contact the office."})
    latitude, longitude, accuracy = location["latitude"], location["longitude"], location["accuracy_m"]
    radius = settings.radius_m
    distance = haversine_distance_m(latitude, longitude, settings.latitude, settings.longitude)
    if distance > radius:
        raise serializers.ValidationError({
            "detail": f"You are outside the {radius} m attendance radius (about {ceil(distance)} m away). "
                      "Return to the Control Team location and try again.",
        })
    if accuracy > radius:
        raise serializers.ValidationError({
            "detail": f"GPS accuracy is too low for the {radius} m attendance radius. Enable precise location and try again.",
        })
    return {
        "latitude": latitude, "longitude": longitude, "accuracy_m": accuracy,
        "distance_m": round(distance, 1), "radius_m": radius,
    }


class MemberStatusSerializer(serializers.Serializer):
    is_active = serializers.BooleanField()


class RequestReviewSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=[ControlLeaveRequest.Status.APPROVED, ControlLeaveRequest.Status.REJECTED])
    review_note = serializers.CharField(max_length=1000, required=False, allow_blank=True)


def member_for(user, *, lock=False):
    queryset = ControlTeamMember.objects.select_for_update() if lock else ControlTeamMember.objects.select_related("user")
    member = get_object_or_404(queryset, user=user)
    if not member.user.is_active:
        raise AuthenticationFailed("Your Control Team account is inactive.")
    return member


def attendance_periods(now):
    today = now.astimezone(LONDON).date()
    monday = today - timedelta(days=today.weekday())
    month_start = today.replace(day=1)
    return (
        datetime.combine(monday, time.min, LONDON).astimezone(utc_timezone.utc),
        datetime.combine(month_start, time.min, LONDON).astimezone(utc_timezone.utc),
    )


def period_attendance(now):
    first_start = min(attendance_periods(now))
    return ControlAttendance.objects.filter(
        Q(checked_out_at__isnull=True) | Q(checked_out_at__gt=first_start), checked_in_at__lte=now,
    )


def member_data(member, now, *, history=False, include_assignments=False):
    week_start, month_start = attendance_periods(now)
    attendance = getattr(member, "period_attendance", None)
    if attendance is None:
        attendance = period_attendance(now).filter(member=member)
    week_seconds = month_seconds = 0
    current = None
    for entry in attendance:
        end = min(entry.checked_out_at or now, now)
        start = worked_start_at(entry)
        week_seconds += max(0, (end - max(start, week_start)).total_seconds())
        month_seconds += max(0, (end - max(start, month_start)).total_seconds())
        if entry.checked_out_at is None:
            current = entry

    data = {
        "id": member.pk, "name": member.name, "email": member.user.email, "phone": member.phone,
        "is_active": member.user.is_active, "profile_complete": member.profile_complete,
        "photo_url": (
            reverse("control:photo", args=[member.pk]) + f"?v={member.photo.name.rsplit('/', 1)[-1]}"
            if member.photo else None
        ),
        "checked_in_at": current.checked_in_at if current else None,
        "late_minutes": minutes_late(current) if current else None,
        "weekly_seconds": int(week_seconds), "monthly_seconds": int(month_seconds),
    }
    if history:
        data["attendance"] = AttendanceSerializer(member.attendance.all()[:50], many=True).data
    if include_assignments:
        data.update(member_schedule(member, now, now.astimezone(LONDON).date()))
    return data


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([ControlLoginThrottle])
@transaction.atomic
def login(request):
    serializer = ControlLoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = serializer.validated_data["user"]
    if role_of(user) != UserProfile.Role.CONTROL_TEAM:
        raise PermissionDenied("Only Control Team accounts can sign in here.")
    member_for(user, lock=True)
    token, _ = Token.objects.get_or_create(user=user)
    return Response({"token": token.key, "user": {"role": UserProfile.Role.CONTROL_TEAM}})


@api_view(["POST"])
@permission_classes([IsControlMember])
def logout(request):
    if isinstance(request.auth, Token):
        Token.objects.filter(pk=request.auth.pk, user=request.user).delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET", "PUT"])
@permission_classes([IsControlMember])
@transaction.atomic
def profile(request):
    member = member_for(request.user, lock=request.method == "PUT")
    if request.method == "PUT":
        was_complete = member.profile_complete
        serializer = ProfileSerializer(member, data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        if not was_complete and member.profile_complete:
            publish_control_notification(
                member, office=True, tab="team", title="Control Team: Profile completed",
                message=f"{member.name} completed their staff profile.", category="SYSTEM",
                event_key=f"profile:{member.pk}:completed",
            )
    now = timezone.now()
    close_expired_attendance(now, member_id=member.pk)
    return Response(member_data(member, now, history=True, include_assignments=True))


@api_view(["GET"])
@permission_classes([IsControlMember])
def schedule(request):
    member = member_for(request.user)
    now = timezone.now()
    start = serializers.DateField().run_validation(request.query_params.get("start", now.astimezone(LONDON).date().isoformat()))
    if start <= date.min or start > date.max - timedelta(days=7):
        raise serializers.ValidationError({"start": "Choose a valid schedule start date."})
    return Response(member_schedule(member, now, start))


@api_view(["GET", "PUT"])
@permission_classes([IsControlAdmin | IsControlMember])
@transaction.atomic
def team_attendance_settings(request):
    if request.method == "GET":
        return Response(ControlSettingsSerializer(attendance_settings()).data)
    if not is_admin(request.user):
        raise PermissionDenied("Only the office can change attendance settings.")
    settings, _ = ControlAttendanceSettings.objects.select_for_update().get_or_create(pk=1)
    serializer = ControlSettingsSerializer(settings, data=request.data)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    AuditLog.objects.create(
        user=request.user, action="UPDATE", model_name="ControlAttendanceSettings", object_id=str(settings.pk),
        summary="Updated Control Team location and shift timings",
    )
    return Response(serializer.data)


@api_view(["GET", "POST"])
@permission_classes([IsControlAdmin])
@transaction.atomic
def team_assignments(request):
    now = timezone.now()
    if request.method == "GET":
        raw_date = request.query_params.get("date")
        selected_date = serializers.DateField().run_validation(raw_date) if raw_date else now.astimezone(LONDON).date()
        assignments = ControlShiftAssignment.objects.filter(shift_date=selected_date).select_related("member", "attendance")
        rules = ControlWeeklyAssignment.objects.filter(starts_on__lte=selected_date, member__user__is_active=True).filter(
            Q(ends_before__isnull=True) | Q(ends_before__gt=selected_date),
        ).select_related("member")
        return Response(schedule_rows(assignments, rules, selected_date, selected_date, now))

    # Serialize roster edits with timing updates and other assignments, including overlapping shifts.
    settings, _ = ControlAttendanceSettings.objects.select_for_update().get_or_create(pk=1)
    assignment = save_assignment(NewAssignmentSerializer(data=request.data), settings)
    audit = AuditLog.objects.create(
        user=request.user, action="CREATE", model_name="ControlShiftAssignment", object_id=str(assignment.pk),
        summary="Assigned a Control Team shift",
    )
    notify_shift_assignment(assignment, "assigned", audit.pk)
    return Response(ShiftAssignmentSerializer(assignment, context={"now": now}).data, status=status.HTTP_201_CREATED)


@api_view(["PATCH", "DELETE"])
@permission_classes([IsControlAdmin])
@transaction.atomic
def team_assignment(request, pk):
    settings, _ = ControlAttendanceSettings.objects.select_for_update().get_or_create(pk=1)
    assignment = get_object_or_404(ControlShiftAssignment.objects.select_for_update(), pk=pk)
    if hasattr(assignment, "attendance"):
        return Response({"detail": "This shift already has attendance recorded."}, status=status.HTTP_409_CONFLICT)
    if request.method == "DELETE":
        assignment.delete()
        audit = AuditLog.objects.create(
            user=request.user, action="DELETE", model_name="ControlShiftAssignment", object_id=str(pk),
            summary="Removed a Control Team shift assignment",
        )
        notify_shift_assignment(assignment, "removed", audit.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)
    previous_member = assignment.member
    assignment = save_assignment(AssignmentMemberSerializer(data=request.data), settings, assignment)
    audit = AuditLog.objects.create(
        user=request.user, action="UPDATE", model_name="ControlShiftAssignment", object_id=str(pk),
        summary="Reassigned a Control Team shift",
    )
    if previous_member.pk != assignment.member_id:
        notify_shift_assignment(assignment, "removed", audit.pk, member=previous_member)
        notify_shift_assignment(assignment, "assigned", audit.pk)
    return Response(ShiftAssignmentSerializer(assignment, context={"now": timezone.now()}).data)


@api_view(["GET", "POST"])
@permission_classes([IsControlAdmin])
@transaction.atomic
def team_weekly_assignments(request):
    if request.method == "GET":
        rules = ControlWeeklyAssignment.objects.filter(ends_before__isnull=True).select_related("member")
        return Response(WeeklyAssignmentSerializer(rules, many=True).data)
    settings, _ = ControlAttendanceSettings.objects.select_for_update().get_or_create(pk=1)
    rule = save_weekly_assignment(request.data, settings, timezone.localdate(timezone=LONDON))
    audit = AuditLog.objects.create(
        user=request.user, action="CREATE", model_name="ControlWeeklyAssignment", object_id=str(rule.pk),
        summary="Assigned repeating Control Team shifts",
    )
    notify_shift_assignment(rule, "assigned", audit.pk)
    return Response(WeeklyAssignmentSerializer(rule).data, status=status.HTTP_201_CREATED)


@api_view(["PATCH", "DELETE"])
@permission_classes([IsControlAdmin])
@transaction.atomic
def team_weekly_assignment(request, pk):
    settings, _ = ControlAttendanceSettings.objects.select_for_update().get_or_create(pk=1)
    rule = get_object_or_404(ControlWeeklyAssignment, pk=pk, ends_before__isnull=True)
    today = timezone.localdate(timezone=LONDON)
    rule.ends_before = today
    rule.save(update_fields=["ends_before"])
    editing = request.method == "PATCH"
    updated = save_weekly_assignment(request.data, settings, today) if editing else None
    audit = AuditLog.objects.create(
        user=request.user, action="UPDATE" if editing else "DELETE",
        model_name="ControlWeeklyAssignment", object_id=str(pk),
        summary="Updated repeating Control Team shifts" if editing else "Ended repeating Control Team shifts",
    )
    if not updated:
        notify_shift_assignment(rule, "removed", audit.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)
    if rule.member_id != updated.member_id:
        notify_shift_assignment(rule, "removed", audit.pk)
        notify_shift_assignment(updated, "assigned", audit.pk)
    else:
        notify_shift_assignment(updated, "updated", audit.pk)
    return Response(WeeklyAssignmentSerializer(updated).data)


@api_view(["POST"])
@permission_classes([IsControlMember])
@transaction.atomic
def attendance(request):
    serializer = AttendanceActionSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    checking_in = data["action"] == "check_in"
    if checking_in:
        settings, _ = ControlAttendanceSettings.objects.select_for_update().get_or_create(pk=1)
    else:
        settings = attendance_settings()
    member = member_for(request.user, lock=True)
    current = member.attendance.select_for_update().filter(checked_out_at__isnull=True).first()
    now = timezone.now()
    if current and current.auto_checkout_at and current.auto_checkout_at <= now:
        close_expired_attendance(now, member_id=member.pk)
        current = None

    if checking_in:
        if not member.profile_complete:
            raise PermissionDenied("Complete your profile and upload a photo before checking in.")
        assignment = check_in_assignment(member, data, now)
        if current and (not assignment or not assignment.pk or current.assignment_id != assignment.pk):
            return Response({"detail": "You are already checked in. Check out before starting another shift."}, status=status.HTTP_409_CONFLICT)
        if not current:
            now = timezone.now()
            shift_status = assignment_status(assignment, now) if assignment else None
            if shift_status != "Available":
                detail = "This shift is unavailable for check-in. Check your assigned shifts."
                if shift_status == "Upcoming":
                    detail = "Check In opens 30 minutes before your assigned shift."
                return Response({"detail": detail}, status=status.HTTP_409_CONFLICT)
        location = attendance_location(request.data, settings, assignment.shift)
        if not current:
            if not assignment.pk:
                assignment.save()
            entry = ControlAttendance.objects.create(
                member=member, checked_in_at=now, check_in_photo=data["photo"], check_in_location=location,
                assignment=assignment, shift=assignment.shift,
                scheduled_start_at=assignment.scheduled_start_at, scheduled_end_at=assignment.scheduled_end_at,
                auto_checkout_at=assignment.scheduled_end_at + AUTO_CHECKOUT_GRACE,
            )
            notify_control_attendance(entry, "check_in")
    elif current:
        if current.pk != data["attendance_id"]:
            return Response(
                {"detail": "Your attendance changed. Open Check Out again to take a new photo."},
                status=status.HTTP_409_CONFLICT,
            )
        location = attendance_location(request.data, settings, current.shift)
        current.checked_out_at = now
        current.check_out_photo = data["photo"]
        current.check_out_location = location
        current.save(update_fields=["checked_out_at", "check_out_photo", "check_out_location"])
        notify_control_attendance(current, "check_out")
    return Response(member_data(member, now, history=True, include_assignments=True))


def notify_control_request(item, action):
    kind = item.get_kind_display()
    for office in (False, True):
        owner = f"{item.member.name}'s" if office else "Your"
        title = f"{kind} request {action}"
        publish_control_notification(
            item.member, office=office, tab="requests", title=f"Control Team: {title}" if office else title,
            message=f"{owner} request for {item.start_date:%d %b %Y} to {item.end_date:%d %b %Y} was {action}.",
            event_key=f"request:{item.pk}:{action}", category="LEAVE_REPLACEMENT",
            notification_type={"approved": "SUCCESS", "rejected": "WARNING"}.get(action, "INFO"),
        )


@api_view(["GET", "POST"])
@permission_classes([IsControlMember])
@transaction.atomic
def member_requests(request):
    member = member_for(request.user, lock=request.method == "POST")
    if request.method == "GET":
        return Response(RequestSerializer(member.requests.all(), many=True).data)
    if not member.profile_complete:
        raise PermissionDenied("Complete your profile before sending a request.")
    serializer = RequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    item = serializer.save(member=member)
    notify_control_request(item, "submitted")
    return Response(serializer.data, status=status.HTTP_201_CREATED)


def accessible_members(user):
    if is_admin(user):
        return ControlTeamMember.objects.all()
    if role_of(user) == UserProfile.Role.CONTROL_TEAM and user.is_active:
        return ControlTeamMember.objects.filter(user=user)
    raise PermissionDenied()


def photo_response(photo_file):
    try:
        file = photo_file.open("rb")
    except (ValueError, FileNotFoundError) as exc:
        raise Http404 from exc
    response = FileResponse(file, content_type="image/jpeg")
    response["Cache-Control"] = "private, no-store"
    return response


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def photo(request, pk):
    member = get_object_or_404(accessible_members(request.user), pk=pk)
    return photo_response(member.photo)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def attendance_photo(request, pk, action):
    entry = get_object_or_404(ControlAttendance, pk=pk, member__in=accessible_members(request.user))
    if action == "check_in":
        return photo_response(entry.check_in_photo)
    if action == "check_out":
        return photo_response(entry.check_out_photo)
    raise Http404


@api_view(["GET", "POST"])
@permission_classes([IsControlAdmin])
def team(request):
    now = timezone.now()
    if request.method == "POST":
        serializer = NewMemberSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            member = serializer.save()
            AuditLog.objects.create(
                user=request.user, action="CREATE", model_name="ControlTeamMember", object_id=str(member.pk),
                summary="Created Control Team account",
            )
            publish_control_notification(
                member, office=True, tab="team", title="Control Team member added",
                message=f"{member.name} was added to the Control Team.", category="SYSTEM",
                event_key=f"member:{member.pk}:created",
            )
        return Response(member_data(member, now), status=status.HTTP_201_CREATED)
    close_expired_attendance(now)
    members = ControlTeamMember.objects.select_related("user").prefetch_related(
        Prefetch("attendance", queryset=period_attendance(now), to_attr="period_attendance"),
    ).order_by("name", "pk")
    return Response([member_data(member, now) for member in members])


@api_view(["GET", "PATCH"])
@permission_classes([IsControlAdmin])
@transaction.atomic
def team_member(request, pk):
    members = ControlTeamMember.objects.select_for_update() if request.method == "PATCH" else ControlTeamMember.objects.select_related("user")
    member = get_object_or_404(members, pk=pk)
    now = timezone.now()
    close_expired_attendance(now, member_id=member.pk)
    if request.method == "PATCH":
        serializer = MemberStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        active = serializer.validated_data["is_active"]
        if member.user.is_active != active:
            member.user.is_active = active
            member.user.save(update_fields=["is_active"])
            closed = 0
            if not active:
                closed = member.attendance.filter(checked_out_at__isnull=True).update(checked_out_at=now, closed_by_admin=True)
                Token.objects.filter(user=member.user).delete()
            audit = AuditLog.objects.create(
                user=request.user, action="UPDATE", model_name="ControlTeamMember", object_id=str(member.pk),
                summary="Reactivated Control Team member" if active else "Deactivated Control Team member",
            )
            action = "reactivated" if active else "deactivated"
            message = f"{member.name}'s Control Team access was {action}."
            if closed:
                message += " Their open attendance was checked out by the office."
            publish_control_notification(
                member, office=True, tab="team", title=f"Control Team member {action}", message=message,
                category="SYSTEM", event_key=f"member:{audit.pk}:{action}",
            )
    return Response(member_data(member, now, history=True))


@api_view(["GET"])
@permission_classes([IsControlAdmin])
def team_requests(request):
    return Response(RequestSerializer(ControlLeaveRequest.objects.select_related("member"), many=True).data)


@api_view(["PATCH"])
@permission_classes([IsControlAdmin])
@transaction.atomic
def review_request(request, pk):
    item = get_object_or_404(ControlLeaveRequest.objects.select_for_update(), pk=pk)
    if item.status != ControlLeaveRequest.Status.PENDING:
        return Response({"detail": "This request has already been reviewed."}, status=status.HTTP_409_CONFLICT)
    serializer = RequestReviewSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    item.status = serializer.validated_data["status"]
    item.review_note = serializer.validated_data.get("review_note", "")
    item.reviewed_by = request.user
    item.reviewed_at = timezone.now()
    item.save(update_fields=["status", "review_note", "reviewed_by", "reviewed_at"])
    notify_control_request(item, item.status.lower())
    return Response(RequestSerializer(item).data)


urlpatterns = [
    path("login/", login, name="login"),
    path("logout/", logout, name="logout"),
    path("profile/", profile, name="profile"),
    path("schedule/", schedule, name="schedule"),
    path("attendance/", attendance, name="attendance"),
    path("attendance/settings/", team_attendance_settings, name="attendance-settings"),
    path("attendance/<int:pk>/photos/<str:action>/", attendance_photo, name="attendance-photo"),
    path("requests/", member_requests, name="requests"),
    path("notifications/", ControlNotificationViewSet.as_view({"get": "list"}), name="notifications"),
    path("notifications/inbox/", ControlNotificationViewSet.as_view({"get": "inbox"}), name="notification-inbox"),
    path("notifications/mark-all-read/", ControlNotificationViewSet.as_view({"post": "mark_all_read"}), name="notifications-read"),
    path("notifications/<int:pk>/mark_read/", ControlNotificationViewSet.as_view({"post": "mark_read"}), name="notification-read"),
    path("photos/<int:pk>/", photo, name="photo"),
    path("team/", team, name="team"),
    path("team/assignments/", team_assignments, name="team-assignments"),
    path("team/assignments/<int:pk>/", team_assignment, name="team-assignment"),
    path("team/weekly-assignments/", team_weekly_assignments, name="team-weekly-assignments"),
    path("team/weekly-assignments/<int:pk>/", team_weekly_assignment, name="team-weekly-assignment"),
    path("team/<int:pk>/", team_member, name="member"),
    path("team/requests/", team_requests, name="team-requests"),
    path("team/requests/<int:pk>/", review_request, name="review"),
]
