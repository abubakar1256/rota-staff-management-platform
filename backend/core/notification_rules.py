"""Category inference for legacy alerts and producers without explicit metadata."""

CATEGORIES = [
    ("DOCUMENT_EXPIRY", "Documents Expiry"), ("DOCUMENT_REVIEW", "Documents Review"),
    ("REGISTRATION_SCREENING", "Registration & Screening"), ("ATTENDANCE", "Attendance"),
    ("ROTA_STAFFING", "Rota & Staffing"), ("LEAVE_REPLACEMENT", "Leave & Replacement"),
    ("TIMESHEETS", "Timesheets"), ("SYSTEM", "System & Integrations"),
]
GUARD_CATEGORIES = [
    ("ROTA_STAFFING", "My Rota"), ("ATTENDANCE", "Attendance"),
    ("DOCUMENT_EXPIRY", "Documents Expiry"), ("DOCUMENT_REVIEW", "Documents Updates"),
    ("REGISTRATION_SCREENING", "Registration & Screening"),
    ("LEAVE_REPLACEMENT", "Leave & Replacement"), ("TIMESHEETS", "Timesheets"),
]


def classify_notification(title, link="", message=""):
    text = str(title or "").casefold()
    route = str(link or "").split("?")[0]
    if any(word in text for word in ("email", "google drive", "connection", "integration")):
        category = "SYSTEM"
    elif "document" in text and any(word in text for word in ("expir", "renew")):
        category = "DOCUMENT_EXPIRY"
    elif route == "documents" or any(word in text for word in ("document", "certificate")):
        category = "DOCUMENT_REVIEW"
    elif route in {"compliance", "compliance-approvals", "security-screening", "diligent-registration"} or any(word in text for word in ("registration", "screening")):
        category = "REGISTRATION_SCREENING"
    elif route == "timesheets" or any(word in text for word in ("timesheet", "shift hours", "shift completed")):
        category = "TIMESHEETS"
    elif route == "leave" or "leave" in text or "replacement request" in text:
        category = "LEAVE_REPLACEMENT"
    elif route in {"attendance", "attendance-review", "operations"} or any(word in text for word in ("book on", "book off", "hourly", "attendance", "gps")):
        category = "ATTENDANCE"
    elif route in {"rota", "rota-confirmation", "coverage-staffing"} or any(word in text for word in ("rota", "unfilled", "staffing")):
        category = "ROTA_STAFFING"
    else:
        category = "SYSTEM"
    priority = "URGENT" if any(word in text for word in ("expired", "missed", "unfilled", "failed", "failure", "overdue", "late book", "location exception")) else "NORMAL"
    return category, priority
