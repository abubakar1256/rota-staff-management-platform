from datetime import datetime, time, timedelta, timezone as utc_timezone
from io import BytesIO
from uuid import uuid4
from zoneinfo import ZoneInfo

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

from .models import AuditLog, ControlAttendance, ControlLeaveRequest, ControlTeamMember, Employee, UserProfile
from .permissions import is_admin, role_of
from .serializers import LoginSerializer

User = get_user_model()
LONDON = ZoneInfo("Europe/London")


class IsControlMember(BasePermission):
    def has_permission(self, request, view):
        return role_of(request.user) == UserProfile.Role.CONTROL_TEAM


class IsControlAdmin(BasePermission):
    def has_permission(self, request, view):
        return is_admin(request.user)


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


class ProfileSerializer(serializers.ModelSerializer):
    phone = serializers.CharField(max_length=40)
    photo = serializers.ImageField(required=False, write_only=True)

    class Meta:
        model = ControlTeamMember
        fields = ["name", "phone", "photo"]

    def validate_photo(self, value):
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
    class Meta:
        model = ControlAttendance
        fields = ["id", "checked_in_at", "checked_out_at", "closed_by_admin"]


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


def member_data(member, now, *, history=False):
    week_start, month_start = attendance_periods(now)
    attendance = getattr(member, "period_attendance", None)
    if attendance is None:
        attendance = period_attendance(now).filter(member=member)
    week_seconds = month_seconds = 0
    checked_in_at = None
    for entry in attendance:
        end = min(entry.checked_out_at or now, now)
        start = entry.checked_in_at
        week_seconds += max(0, (end - max(start, week_start)).total_seconds())
        month_seconds += max(0, (end - max(start, month_start)).total_seconds())
        if entry.checked_out_at is None:
            checked_in_at = start

    data = {
        "id": member.pk, "name": member.name, "email": member.user.email, "phone": member.phone,
        "is_active": member.user.is_active, "profile_complete": member.profile_complete,
        "photo_url": (
            reverse("control:photo", args=[member.pk]) + f"?v={member.photo.name.rsplit('/', 1)[-1]}"
            if member.photo else None
        ),
        "checked_in_at": checked_in_at, "weekly_seconds": int(week_seconds), "monthly_seconds": int(month_seconds),
    }
    if history:
        data["attendance"] = AttendanceSerializer(member.attendance.all()[:50], many=True).data
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
        serializer = ProfileSerializer(member, data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
    return Response(member_data(member, timezone.now(), history=True))


@api_view(["POST"])
@permission_classes([IsControlMember])
@transaction.atomic
def attendance(request):
    serializer = AttendanceActionSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    member = member_for(request.user, lock=True)
    current = member.attendance.filter(checked_out_at__isnull=True).first()
    now = timezone.now()
    if serializer.validated_data["action"] == "check_in":
        if not member.profile_complete:
            raise PermissionDenied("Complete your profile and upload a photo before checking in.")
        if not current:
            ControlAttendance.objects.create(member=member, checked_in_at=now)
    elif current:
        current.checked_out_at = now
        current.save(update_fields=["checked_out_at"])
    return Response(member_data(member, now, history=True))


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
    serializer.save(member=member)
    return Response(serializer.data, status=status.HTTP_201_CREATED)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def photo(request, pk):
    if not is_admin(request.user) and role_of(request.user) != UserProfile.Role.CONTROL_TEAM:
        raise PermissionDenied()
    members = ControlTeamMember.objects.all()
    if not is_admin(request.user):
        members = members.filter(user=request.user)
    member = get_object_or_404(members, pk=pk)
    try:
        file = member.photo.open("rb")
    except (ValueError, FileNotFoundError) as exc:
        raise Http404 from exc
    response = FileResponse(file, content_type="image/jpeg")
    response["Cache-Control"] = "private, no-store"
    return response


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
        return Response(member_data(member, now), status=status.HTTP_201_CREATED)
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
    if request.method == "PATCH":
        serializer = MemberStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        active = serializer.validated_data["is_active"]
        if member.user.is_active != active:
            member.user.is_active = active
            member.user.save(update_fields=["is_active"])
            if not active:
                member.attendance.filter(checked_out_at__isnull=True).update(checked_out_at=now, closed_by_admin=True)
                Token.objects.filter(user=member.user).delete()
            AuditLog.objects.create(
                user=request.user, action="UPDATE", model_name="ControlTeamMember", object_id=str(member.pk),
                summary="Reactivated Control Team member" if active else "Deactivated Control Team member",
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
    return Response(RequestSerializer(item).data)


urlpatterns = [
    path("login/", login, name="login"),
    path("logout/", logout, name="logout"),
    path("profile/", profile, name="profile"),
    path("attendance/", attendance, name="attendance"),
    path("requests/", member_requests, name="requests"),
    path("photos/<int:pk>/", photo, name="photo"),
    path("team/", team, name="team"),
    path("team/<int:pk>/", team_member, name="member"),
    path("team/requests/", team_requests, name="team-requests"),
    path("team/requests/<int:pk>/", review_request, name="review"),
]
