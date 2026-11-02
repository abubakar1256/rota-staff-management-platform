from datetime import timedelta

from django.utils import timezone


def is_british(nationality):
    return str(nationality or "").strip().casefold() in {
        "british", "united kingdom", "united kingdom of great britain and northern ireland",
        "uk", "gb", "gbr", "english", "scottish", "welsh", "northern irish",
    }


def document_requirements(nationality):
    items = [
        ("passport", ("Passport (First 2 pages)",), "expiry"),
        ("sia_front", ("SIA Card (Front)", "SIA Card (Front & Back)"), "card"),
        ("sia_back", ("SIA Card (Back)", "SIA Card (Front & Back)"), "file"),
        ("proof_address", ("Proof of Address (last 3 months)", "Proof of Address 1 (last 3 months)", "Proof of Address 2 (last 3 months)"), "address"),
    ]
    if not is_british(nationality):
        items.append(("share_code", ("Share Code",), "code_expiry"))
    items.extend([
        ("ni_number", ("National Insurance Number (NI)",), "code"),
        ("photograph", ("Personal Photograph",), "file"),
    ])
    return items


def document_is_complete(document, kind, today):
    if document.verification_status == "REJECTED":
        return False
    if document.expiry_date and document.expiry_date < today:
        return False
    file_present = bool(document.file or document.file_url)
    if kind in {"code", "code_expiry"}:
        if not (file_present or document.document_number.strip() or document.notes.strip()):
            return False
    elif not file_present:
        return False
    if kind in {"expiry", "card", "code_expiry"} and not document.expiry_date:
        return False
    if kind == "card" and not document.document_number.strip():
        return False
    if kind == "address" and not (document.issue_date and today - timedelta(days=92) <= document.issue_date <= today):
        return False
    return True


def documents_completion(employee):
    documents = list(employee.documents.all())
    requirements = document_requirements(employee.nationality)
    today = timezone.localdate()
    completed = sum(any(
        document.document_type.casefold() in {alias.casefold() for alias in aliases}
        and document_is_complete(document, kind, today)
        for document in documents
    ) for _, aliases, kind in requirements)
    return {"completed": completed, "required": len(requirements), "percentage": round(completed / len(requirements) * 100)}
