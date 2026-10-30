"""Private guard screening forms and the office verification workflow."""
from datetime import date
from io import BytesIO
import re
from xml.sax.saxutils import escape

from django.contrib.auth import get_user_model
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import AuditLog, Employee, EmployeeDocument, Notification, SecurityScreening, ScreeningSubmission
from .permissions import role_of

PERSONAL_FIELDS = ["full_name", "previous_names", "date_of_birth", "national_insurance_number", "phone", "email", "job_title", "proposed_start_date", "current_address", "moved_in", "sia_held", "sia_type", "sia_number", "history_notes", "signature_name"]
ROW_FIELDS = {
    "addresses": ["address", "from_month", "to_month"],
    "activities": ["activity_type", "from_month", "to_month", "organisation", "duties", "location", "reason_ended"],
    "referees": ["employer", "name", "job_title", "phone", "email", "from_month", "to_month", "notes"],
    "gaps": ["from_month", "to_month", "reason", "evidence"],
    "education": ["provider", "course", "from_month", "to_month", "evidence"],
}
CHECKS = ["identity", "right_to_work", "history", "gaps", "references", "other_checks"]
DECLARATION = "I confirm that the information I have provided is complete and accurate to the best of my knowledge. I understand that the company may verify it, contact employers, referees and education providers, and request further information or supporting documents. Any additional checks will be carried out only where appropriate for the role and in accordance with applicable law and the company's screening procedure."


def admin_allowed(user):
    return role_of(user) in {"ADMIN", "SUPER_ADMIN"}


def month_number(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", value):
        raise ValidationError("History dates must use YYYY-MM.")
    year, month = map(int, value.split("-"))
    if not 1900 <= year <= timezone.localdate().year + 1:
        raise ValidationError("History year is outside the supported range.")
    return year * 12 + month - 1


def month_label(number):
    return f"{number // 12:04d}-{number % 12 + 1:02d}"


def timeline_gaps(data, months):
    today = timezone.localdate()
    end = today.year * 12 + today.month - 1
    start = end - months + 1
    covered = set()
    for row in data.get("activities", []) + data.get("gaps", []):
        if not row.get("from_month"):
            continue
        left = month_number(row["from_month"])
        right = month_number(row["to_month"]) if row.get("to_month") else end
        covered.update(range(max(left, start), min(right, end) + 1))
    missing = []
    for number in range(start, end + 1):
        if number in covered:
            continue
        if missing and missing[-1][1] == number - 1:
            missing[-1][1] = number
        else:
            missing.append([number, number])
    return [{"from_month": month_label(left), "to_month": month_label(right)} for left, right in missing]


class ScreeningDataSerializer(serializers.Serializer):
    declaration_accepted = serializers.BooleanField(default=False)
    document_ids = serializers.ListField(child=serializers.IntegerField(min_value=1), max_length=100, default=list)

    def get_fields(self):
        fields = super().get_fields()
        for key in PERSONAL_FIELDS:
            fields[key] = serializers.CharField(required=False, allow_blank=True, max_length=4000 if key in {"history_notes", "previous_names", "current_address"} else 250)
        for key in ROW_FIELDS:
            fields[key] = serializers.ListField(child=serializers.DictField(), max_length=100, default=list)
        return fields

    def validate(self, attrs):
        for field in ("date_of_birth", "proposed_start_date"):
            if attrs.get(field):
                try:
                    parsed = date.fromisoformat(attrs[field])
                except ValueError:
                    raise ValidationError({field: "Use YYYY-MM-DD."})
                if field == "date_of_birth" and parsed > timezone.localdate():
                    raise ValidationError({field: "Date of birth cannot be in the future."})
        if attrs.get("email"):
            serializers.EmailField().run_validation(attrs["email"])
        if attrs.get("sia_held", "") not in {"", "Yes", "No", "N/A"}:
            raise ValidationError({"sia_held": "Select Yes, No or N/A."})
        if attrs.get("moved_in"):
            month_number(attrs["moved_in"])
        for key, allowed in ROW_FIELDS.items():
            cleaned = []
            for row in attrs.get(key, []):
                if any(not isinstance(v, str) or len(v) > 4000 for v in row.values()):
                    raise ValidationError({key: "Enter text values up to 4000 characters."})
                row = {name: row.get(name, "").strip() for name in allowed}
                if not any(row.values()):
                    continue
                for name in ("from_month", "to_month"):
                    if row.get(name):
                        month_number(row[name])
                if row.get("from_month") and row.get("to_month") and row["from_month"] > row["to_month"]:
                    raise ValidationError({key: "From date must be before the end date."})
                cleaned.append(row)
            attrs[key] = cleaned
        employee = self.context["employee"]
        ids = attrs.get("document_ids", [])
        if EmployeeDocument.objects.filter(employee=employee, pk__in=ids).count() != len(set(ids)):
            raise ValidationError({"document_ids": "Select only documents belonging to this guard."})
        return attrs


def response_data(case, user):
    data = {"id": case.pk, "form_id": case.form_id, "employee_id": case.employee.employee_id, "employee_name": case.employee.name,
            "status": case.status, "screening_months": case.screening_months, "form_data": case.form_data,
            "guard_message": case.guard_message, "submitted_at": case.submitted_at, "completed_at": case.completed_at,
            "updated_at": case.updated_at, "gaps": timeline_gaps(case.form_data, case.screening_months),
            "documents": [{"id": d.pk, "document_type": d.document_type, "verification_status": d.verification_status, "file_url": f"/api/media/document/{d.pk}/" if d.file or d.file_url else None} for d in case.employee.documents.all()]}
    if admin_allowed(user):
        data["office_data"] = case.office_data
        data["submissions"] = [{"id": s.pk, "submitted_at": s.submitted_at, "form_data": s.form_data} for s in case.submissions.order_by("-submitted_at")]
        data["completed_by"] = case.completed_by.get_username() if case.completed_by else None
    return data


def record(case, user, action_name, before):
    AuditLog.objects.create(user=user, action=action_name, model_name="SecurityScreening", object_id=str(case.pk),
                            summary=f"{action_name}: {case.form_id}", before_data=before,
                            after_data={"status": case.status, "office_data": case.office_data, "guard_message": case.guard_message})


class SecurityScreeningViewSet(viewsets.GenericViewSet):
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        query = SecurityScreening.objects.select_related("employee", "completed_by")
        if admin_allowed(self.request.user):
            return query
        if role_of(self.request.user) == "EMPLOYEE":
            return query.filter(employee__user=self.request.user)
        raise PermissionDenied("Only guards and screening administrators can access screening records.")

    def list(self, request):
        if not admin_allowed(request.user):
            raise PermissionDenied("Only administrators can view the screening queue.")
        query = self.get_queryset().order_by("-updated_at")
        if request.query_params.get("status") and request.query_params["status"] != "ALL":
            query = query.filter(status=request.query_params["status"])
        return Response([response_data(case, request.user) for case in query])

    def retrieve(self, request, pk=None):
        return Response(response_data(self.get_object(), request.user))

    @action(detail=False, methods=["get", "patch"], url_path="my")
    def my(self, request):
        if role_of(request.user) != "EMPLOYEE":
            raise PermissionDenied("This form is for guard accounts.")
        employee = get_object_or_404(Employee, user=request.user)
        with transaction.atomic():
            case, _ = SecurityScreening.objects.get_or_create(employee=employee)
            case = SecurityScreening.objects.select_for_update().get(pk=case.pk)
            if request.method == "PATCH":
                self.save_guard_data(case, request, employee)
            elif not case.form_data:
                registration = getattr(employee, "compliance_registration", None)
                case.form_data = {"full_name": employee.name, "date_of_birth": str(employee.date_of_birth or ""), "phone": employee.phone,
                                  "email": employee.email, "job_title": employee.position, "current_address": employee.address,
                                  "proposed_start_date": str(employee.joining_date or ""), "national_insurance_number": registration.national_insurance_number if registration else ""}
                case.save()
            return Response(response_data(case, request.user))

    def save_guard_data(self, case, request, employee):
        if case.status not in {"DRAFT", "CHANGES_REQUIRED", "REJECTED"}:
            raise ValidationError("The submitted form is locked. Ask the office to request changes.")
        validator = ScreeningDataSerializer(data=request.data.get("form_data", {}), context={"employee": employee})
        validator.is_valid(raise_exception=True)
        case.form_data = validator.validated_data
        case.save()

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        with transaction.atomic():
            case = self.get_queryset().select_for_update().get(pk=self.get_object().pk)
            if role_of(request.user) != "EMPLOYEE":
                raise PermissionDenied("Only the guard can submit their form.")
            self.save_guard_data(case, request, case.employee)
            data = case.form_data
            required = ["full_name", "date_of_birth", "phone", "email", "job_title", "current_address", "moved_in", "sia_held", "signature_name"]
            missing = [name.replace("_", " ") for name in required if not data.get(name, "").strip()]
            if missing or not data.get("declaration_accepted"):
                raise ValidationError("Complete the declaration and required details: " + ", ".join(missing))
            for key in ROW_FIELDS:
                for row in data.get(key, []):
                    needed = {"addresses": ["address", "from_month", "to_month"], "activities": ["activity_type", "from_month", "organisation"], "referees": ["employer", "name", "from_month"], "gaps": ["from_month", "to_month", "reason"], "education": ["provider", "course", "from_month"]}[key]
                    if any(not row.get(name) for name in needed):
                        raise ValidationError(f"Complete the required details and dates in {key}.")
                    if key == "referees" and not (row.get("email") or row.get("phone") or row.get("notes")):
                        raise ValidationError("Add referee contact details or explain why they are unavailable.")
            if not data.get("activities") or timeline_gaps(data, case.screening_months):
                raise ValidationError("Account for the complete screening period with activities or gap explanations.")
            if data["sia_held"] == "Yes" and not data.get("sia_number"):
                raise ValidationError("Enter your SIA licence number.")
            before = {"status": case.status}
            case.status = "SUBMITTED"
            case.submitted_at = timezone.now()
            case.completed_at = None
            case.completed_by = None
            case.guard_message = ""
            # Re-check the new submission; old review records remain in the audit log.
            case.office_data = {}
            case.save()
            ScreeningSubmission.objects.create(screening=case, form_data=data)
            record(case, request.user, "SUBMIT", before)
            for user in get_user_model().objects.filter(is_active=True).filter(profile__role__in=["ADMIN", "SUPER_ADMIN"]):
                Notification.objects.create(user=user, title="Security screening submitted", message=f"{case.employee.name} submitted {case.form_id}.", link="security-screening")
            return Response(response_data(case, request.user))

    @action(detail=True, methods=["post"])
    def review(self, request, pk=None):
        if not admin_allowed(request.user):
            raise PermissionDenied("Only administrators can record screening checks.")
        with transaction.atomic():
            case = self.get_queryset().select_for_update().get(pk=self.get_object().pk)
            months = serializers.IntegerField(min_value=1, max_value=120).run_validation(request.data.get("screening_months", case.screening_months))
            decision = serializers.ChoiceField(choices=SecurityScreening.Status.values).run_validation(request.data.get("status", case.status))
            message = serializers.CharField(allow_blank=True, max_length=4000).run_validation(request.data.get("guard_message", ""))
            before = {"status": case.status, "office_data": case.office_data, "screening_months": case.screening_months}
            office = request.data.get("office_data", {})
            if not isinstance(office, dict):
                raise ValidationError("Office checklist must be an object.")
            cleaned = {}
            for key in CHECKS + ["other_checks_required", "outstanding_actions", "internal_notes", "reference_records"]:
                cleaned[key] = serializers.CharField(allow_blank=True, max_length=8000).run_validation(office.get(key, ""))
                if key in CHECKS and cleaned[key] not in {"", "PENDING", "VERIFIED", "N/A"}:
                    raise ValidationError("Check results must be Pending, Verified or N/A.")
                if key in CHECKS and cleaned[key] in {"VERIFIED", "N/A"}:
                    cleaned[key + "_by"] = case.office_data.get(key + "_by") if case.office_data.get(key) == cleaned[key] else request.user.get_username()
                    cleaned[key + "_at"] = case.office_data.get(key + "_at") if case.office_data.get(key) == cleaned[key] else timezone.now().isoformat()
            if decision in {"CHANGES_REQUIRED", "REJECTED"} and not message.strip():
                raise ValidationError("Provide instructions for the guard.")
            if decision in {"IN_REVIEW", "COMPLETED", "REJECTED"} and not case.submissions.exists():
                raise ValidationError("Wait for the guard to submit their form first.")
            if decision == "COMPLETED" and (any(cleaned[key] not in {"VERIFIED", "N/A"} for key in CHECKS) or cleaned["outstanding_actions"].strip() or timeline_gaps(case.form_data, months)):
                raise ValidationError("Resolve all checks, outstanding actions and history gaps before completing screening.")
            if decision == "SUBMITTED" and case.status != "SUBMITTED":
                raise ValidationError("Only a guard submission can set the submitted status.")
            if case.status == "COMPLETED" and decision not in {"COMPLETED", "CHANGES_REQUIRED"}:
                raise ValidationError("Request changes to reopen a completed screening.")
            case.screening_months = months
            case.office_data = cleaned
            case.status = decision
            case.guard_message = message
            case.completed_at = (case.completed_at or timezone.now()) if decision == "COMPLETED" else None
            case.completed_by = (case.completed_by or request.user) if decision == "COMPLETED" else None
            case.save()
            record(case, request.user, "REVIEW", before)
            if before["status"] != decision and case.employee.user_id:
                Notification.objects.create(user=case.employee.user, title="Security screening update", message=f"{case.get_status_display()}. {message}", link="security-screening")
            return Response(response_data(case, request.user))

    @action(detail=True, methods=["get"])
    def pdf(self, request, pk=None):
        case = self.get_object()
        if case.status != "COMPLETED":
            raise ValidationError("PDF download is available after screening is completed.")
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
        stream = BytesIO()
        doc = SimpleDocTemplate(stream, pagesize=A4, title="Employee Security Screening Form")
        styles = getSampleStyleSheet()
        story = [Paragraph("Employee Security Screening Form", styles["Title"]), Paragraph(escape(f"{case.form_id} | {case.employee.name} | Completed"), styles["Normal"])]
        def entry(label, text):
            story.append(Paragraph(escape(f"{label}: {text if text not in ('', None) else 'N/A'}").replace("\n", "<br/>"), styles["Normal"]))
            story.append(Spacer(1, 5))
        for key in PERSONAL_FIELDS:
            entry(key.replace("_", " ").title(), case.form_data.get(key, ""))
        for key, fields in ROW_FIELDS.items():
            story.append(Paragraph(key.title(), styles["Heading2"]))
            for number, row in enumerate(case.form_data.get(key, []), 1):
                for name in fields:
                    entry(f"{number}. {name.replace('_', ' ').title()}", row.get(name, ""))
        entry("Declaration", DECLARATION)
        entry("Accepted", "Yes" if case.form_data.get("declaration_accepted") else "No")
        entry("Submitted", case.submitted_at)
        entry("Screening completed", case.completed_at)
        if admin_allowed(request.user):
            story.append(Paragraph("For office use only", styles["Heading2"]))
            for key, value in case.office_data.items():
                entry(key.replace("_", " ").title(), value)
        doc.build(story)
        filename = re.sub(r"[^A-Za-z0-9 ._-]", "", case.employee.name) or case.form_id
        result = HttpResponse(stream.getvalue(), content_type="application/pdf")
        result["Content-Disposition"] = f'attachment; filename="Security Screening - {filename}.pdf"'
        return result
