from .whatsapp import normalise_whatsapp_number


PROFILE_FIELDS = (
    "name", "date_of_birth", "nationality", "phone", "email", "address",
    "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship",
)
REQUIRED_PROFILE_FIELDS = (*PROFILE_FIELDS, "whatsapp_number")
PROFILE_DECLARATION = "I confirm that all information I have provided is true and correct. I accept responsibility for any incorrect information."
PROFILE_DECLARATION_VERSION = "v1"


def profile_photo(employee):
    return employee.documents.filter(document_type__iexact="Personal Photograph").exclude(file="").first()


def profile_field_complete(field, value):
    if field == "whatsapp_number":
        try:
            normalise_whatsapp_number(value or "")
        except ValueError:
            return False
        return True
    return bool(str(value or "").strip())


def profile_completion(employee):
    completed = sum(profile_field_complete(field, getattr(employee, field)) for field in REQUIRED_PROFILE_FIELDS)
    completed += bool(profile_photo(employee))
    completed += bool(employee.profile_declaration_accepted_at)
    return round(completed / (len(REQUIRED_PROFILE_FIELDS) + 2) * 100)
