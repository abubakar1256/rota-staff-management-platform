from datetime import date, timedelta

from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Employee, GuardUnavailability
from .permissions import is_admin, is_manager


class AvailabilityUpdate(serializers.Serializer):
    employee = serializers.PrimaryKeyRelatedField(queryset=Employee.objects.all())
    work_date = serializers.DateField()
    unavailable = serializers.BooleanField()


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def guard_availability(request):
    admin = is_admin(request.user)
    if not admin and (request.method != "GET" or not is_manager(request.user)):
        raise PermissionDenied("Only office staff can view guard availability. An admin must make changes.")

    if request.method == "PUT":
        serializer = AvailabilityUpdate(data=request.data)
        serializer.is_valid(raise_exception=True)
        employee = serializer.validated_data["employee"]
        work_date = serializer.validated_data["work_date"]
        unavailable = serializer.validated_data["unavailable"]
        if unavailable:
            GuardUnavailability.objects.get_or_create(employee=employee, work_date=work_date)
        else:
            GuardUnavailability.objects.filter(employee=employee, work_date=work_date).delete()
        return Response({"employee": employee.pk, "work_date": work_date, "unavailable": unavailable})

    try:
        week_start = date.fromisoformat(request.query_params.get("week_start", ""))
        # Include the following Monday for Sunday night shifts.
        through = week_start + timedelta(days=7)
        if week_start.weekday() != 0:
            raise ValueError
    except (ValueError, OverflowError):
        raise ValidationError({"week_start": "Choose a Monday in YYYY-MM-DD format."})

    rows = GuardUnavailability.objects.filter(work_date__range=(week_start, through))
    if not admin:
        employees = Employee.objects.filter(rota_assignments__site__manager_profiles__user=request.user)
        rows = rows.filter(employee__in=employees)
    response = Response(list(rows.order_by("work_date", "employee_id").values("employee", "work_date")))
    response["Cache-Control"] = "private, no-store"
    return response
