import math
from datetime import date, timedelta

from django.conf import settings
from django.core.paginator import Paginator
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .location_tracking import close_incident, ensure_state, incident_key, live_operations, next_due, open_incident, snapshot, tracking_info
from .models import DailyOperation, DutyLocationState, DutyLocationUpdate, Notification
from .notifications import publish_notification
from .permissions import role_of


def operations_for(user, *, guard_allowed=False):
    query = DailyOperation.objects.select_related("site", "shift_type", "employee__user__profile").prefetch_related("attendance_events")
    role = role_of(user)
    if role in {"SUPER_ADMIN", "ADMIN"}:
        return query
    if role == "MANAGER":
        return query.filter(site__manager_profiles__user=user)
    if guard_allowed and role == "EMPLOYEE":
        return query.filter(employee__user=user)
    raise PermissionDenied("Location evidence is restricted to the assigned guard and authorised office staff.")


def metadata():
    return {"server_time": timezone.now().isoformat(), "time_zone": settings.TIME_ZONE}


def geofence_session(operation, now):
    info = tracking_info(operation, now)
    if (not operation.site.is_active or not operation.employee_id or operation.employee.status != "ACTIVE"
            or not operation.employee.user_id or not operation.employee.user.is_active or not info["on"] or info["off"]
            or not info["on"].captured_at <= now < info["end"]):
        return None
    return {"operation_id": operation.pk, "site_name": operation.site.name, "site_address": operation.site.address,
        "site_latitude": operation.site.latitude, "site_longitude": operation.site.longitude,
        "site_geofence_radius_m": operation.site.geofence_radius_m, "stop_at": info["end"].isoformat()}


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def active_tracking(request):
    if role_of(request.user) != "EMPLOYEE":
        raise PermissionDenied("This endpoint is for the guard's own active tracking sessions.")
    now = timezone.now()
    results, geofences = [], []
    for operation in live_operations(now, tracking_only=False).filter(employee__user=request.user):
        session = geofence_session(operation, now)
        if session:
            geofences.append(session)
        info = tracking_info(operation, now)
        if info["active"]:
            state = ensure_state(operation, info)
            results.append(snapshot(operation, state, now))
    open_operations = set(Notification.objects.filter(user=request.user, category="ATTENDANCE",
        context__geofence_breach=True, context__resolved_at__isnull=True).values_list("context__operation_id", flat=True))
    for session in geofences:
        session["has_open_alert"] = session["operation_id"] in open_operations
    response = Response({"results": results, "geofences": geofences, **metadata()})
    response["Cache-Control"] = "private, no-store"
    return response


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@transaction.atomic
def geofence_status(request, pk):
    if role_of(request.user) != "EMPLOYEE":
        raise PermissionDenied("Only the assigned guard can report their geofence status.")
    operation = get_object_or_404(operations_for(request.user, guard_allowed=True).select_for_update(of=("self",)), pk=pk)
    now = timezone.now()
    session = geofence_session(operation, now)
    if not session:
        return Response({"detail": "This shift is no longer active.", "active": False}, status=409)
    def number(key, lower, upper):
        value = request.data.get(key)
        if value is None or isinstance(value, bool):
            raise ValidationError({key: "A valid GPS number is required."})
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise ValidationError({key: "A valid GPS number is required."})
        if not math.isfinite(value) or not lower <= value <= upper:
            raise ValidationError({key: "The GPS value is outside the valid range."})
        return value
    latitude, longitude = number("latitude", -90, 90), number("longitude", -180, 180)
    accuracy = number("accuracy_m", 0, 100000)
    try:
        captured = parse_datetime(request.data.get("captured_at"))
    except (TypeError, ValueError):
        captured = None
    if not captured or timezone.is_naive(captured) or not -60 <= (now - captured).total_seconds() <= 120:
        raise ValidationError({"captured_at": "Request a fresh GPS location."})
    site = operation.site
    if (site.latitude is None or site.longitude is None or not math.isfinite(site.latitude)
            or not math.isfinite(site.longitude) or not -90 <= site.latitude <= 90
            or not -180 <= site.longitude <= 180 or site.geofence_radius_m <= 0):
        raise ValidationError("This site's GPS configuration needs an office update.")
    if accuracy > site.geofence_radius_m:
        return Response({"status": "UNVERIFIED", "active": True})
    from .views import haversine_distance_m
    distance = haversine_distance_m(latitude, longitude, site.latitude, site.longitude)
    alerts = Notification.objects.filter(user=request.user, category="ATTENDANCE", context__geofence_breach=True,
        context__operation_id=operation.pk).order_by("-pk")
    opened = alerts.filter(context__resolved_at__isnull=True).first()
    if distance <= site.geofence_radius_m:
        for notice in alerts.filter(context__resolved_at__isnull=True):
            notice.context = {**notice.context, "resolved_at": now.isoformat()}
            notice.is_read, notice.priority = True, "NORMAL"
            notice.save(update_fields=["context", "is_read", "priority"])
        return Response({"status": "INSIDE", "active": True, "resolved": bool(opened)})
    created = False
    if not opened:
        previous = alerts.first()
        opened, created = publish_notification(user=request.user, title="Outside your site boundary",
            message=f"Please return to your assigned site location to continue. {site.name}. Address: {site.address or 'Contact the office for the site address.'} Allowed radius: {site.geofence_radius_m}m.",
            category="ATTENDANCE", priority="URGENT", notification_type="WARNING", link="attendance",
            employee=operation.employee, site=site, event_date=operation.operation_date,
            context={"operation_id": operation.pk, "geofence_breach": True, "site_address": site.address,
                     "radius_m": site.geofence_radius_m, "distance_m": round(distance, 2)},
            event_key=f"geofence:{operation.pk}:after:{previous.pk if previous else 0}")
    return Response({"status": "OUTSIDE", "active": True, "notification_id": opened.pk, "created": created,
                     "distance_m": round(distance, 2), **session})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@transaction.atomic
def submit_location(request, pk):
    if role_of(request.user) != "EMPLOYEE":
        raise PermissionDenied("Only the assigned guard can submit location evidence.")
    operation = get_object_or_404(operations_for(request.user, guard_allowed=True).select_for_update(of=("self",)), pk=pk)
    now = timezone.now()
    info = tracking_info(operation, now)
    if not info["active"]:
        return Response({"detail": "Location tracking is no longer active for this shift.", "tracking_active": False}, status=409)
    state = ensure_state(operation, info)
    value = request.data.get("status")
    if not isinstance(value, str) or value not in {"HEARTBEAT", *DutyLocationUpdate.Status.values}:
        raise ValidationError({"status": "Choose a valid location status."})
    if value == "HEARTBEAT":
        if not state.last_contact_at or (now - state.last_contact_at).total_seconds() >= 60:
            state.last_contact_at = now
            state.save(update_fields=["last_contact_at"])
        return Response({"tracking": snapshot(operation, state, now), **metadata()})
    latitude = longitude = accuracy = captured_at = None
    if value == "UPDATED":
        def number(key, minimum, maximum):
            item = request.data.get(key)
            if isinstance(item, bool) or item is None:
                raise ValidationError({key: "A valid number is required."})
            try:
                item = float(item)
            except (ValueError, TypeError):
                raise ValidationError({key: "A valid number is required."})
            if not math.isfinite(item) or not minimum <= item <= maximum:
                raise ValidationError({key: "The value is outside the valid range."})
            return item
        latitude, longitude = number("latitude", -90, 90), number("longitude", -180, 180)
        accuracy = number("accuracy_m", 0, 100000)
        raw_captured = request.data.get("captured_at")
        try:
            captured_at = parse_datetime(raw_captured) if isinstance(raw_captured, str) else None
        except ValueError:
            captured_at = None
        if not captured_at or timezone.is_naive(captured_at) or not -60 <= (now - captured_at).total_seconds() <= 120:
            raise ValidationError({"captured_at": "Request a fresh GPS fix. The location timestamp is missing, old or in the future."})
    elif any(request.data.get(key) is not None for key in ("latitude", "longitude", "accuracy_m")):
        raise ValidationError("Error reports cannot contain location coordinates.")
    recent = DutyLocationUpdate.objects.filter(operation=operation, received_at__gte=now - timedelta(minutes=1))
    if recent.count() >= 10:
        return Response({"detail": "Too many location reports. Try again in a minute."}, status=429)
    last = recent.first()
    if last and last.status == value and state.last_status == value:
        return Response({"tracking": snapshot(operation, state, now), "duplicate": True, **metadata()})
    was_incident = state.incident_open
    previous_key = incident_key(state)
    DutyLocationUpdate.objects.create(operation=operation, status=value, latitude=latitude, longitude=longitude, accuracy_m=accuracy,
        captured_at=captured_at, received_at=now, created_by=request.user)
    state.last_contact_at = now
    state.last_status = value
    if value == "UPDATED":
        state.latitude, state.longitude, state.accuracy_m = latitude, longitude, accuracy
        state.last_location_at = now
    state.save()
    if value == "UPDATED":
        close_incident(state)
        if was_incident:
            publish_notification(title="Location restored", message=f"{operation.employee.name} · {operation.site.name}: fresh location received.",
                link="attendance-review", category="ATTENDANCE", notification_type="SUCCESS", priority="NORMAL",
                employee=operation.employee, site=operation.site, event_date=operation.operation_date,
                context={"operation_id": operation.pk, "location_tracking": True}, event_key=f"{previous_key}:restored")
    else:
        open_incident(operation, state, value)
    return Response({"tracking": snapshot(operation, state, now), **metadata()}, status=201)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def tracking_tracker(request):
    query = operations_for(request.user).filter(employee__isnull=False)
    raw = request.query_params.get("date", str(timezone.localdate()))
    try:
        selected = date.fromisoformat(raw)
    except (TypeError, ValueError):
        raise ValidationError({"date": "Use YYYY-MM-DD."})
    ids = set(query.filter(operation_date=selected).filter(Q(site__location_tracking_enabled=True) | Q(location_state__isnull=False)).values_list("pk", flat=True))
    if selected == timezone.localdate():
        ids.update(live_operations().filter(pk__in=query.values("pk")).values_list("pk", flat=True))
    rows = []
    for operation in query.filter(pk__in=ids).select_related("location_state"):
        info = tracking_info(operation)
        state = ensure_state(operation, info) if info["active"] else getattr(operation, "location_state", None)
        rows.append(snapshot(operation, state))
    response = Response({"results": rows, **metadata()})
    response["Cache-Control"] = "private, no-store"
    return response


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def tracking_history(request, pk):
    operation = get_object_or_404(operations_for(request.user, guard_allowed=True), pk=pk)
    page = Paginator(operation.location_updates.all(), 25).get_page(request.query_params.get("page", 1))
    response = Response({"tracking": snapshot(operation), "results": [{"id": item.pk, "status": item.status,
        "latitude": item.latitude, "longitude": item.longitude, "accuracy_m": item.accuracy_m, "captured_at": item.captured_at.isoformat() if item.captured_at else None,
        "received_at": item.received_at.isoformat(), "source": item.source} for item in page.object_list],
        "pagination": {"page": page.number, "total_pages": page.paginator.num_pages, "has_next": page.has_next(), "has_previous": page.has_previous()}, **metadata()})
    response["Cache-Control"] = "private, no-store"
    return response
