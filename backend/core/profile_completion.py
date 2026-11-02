PROFILE_FIELDS = (
    "name", "date_of_birth", "nationality", "phone", "email", "address",
    "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship",
)
PROFILE_DECLARATION = "I confirm that all information I have provided is true and correct. I accept responsibility for any incorrect information."
PROFILE_DECLARATION_VERSION = "v1"


def profile_photo(employee):
    return employee.documents.filter(document_type__iexact="Personal Photograph").exclude(file="").first()


def profile_completion(employee):
    completed = sum(bool(str(getattr(employee, field) or "").strip()) for field in PROFILE_FIELDS)
    completed += bool(profile_photo(employee))
    completed += bool(employee.profile_declaration_accepted_at)
    return round(completed / (len(PROFILE_FIELDS) + 2) * 100)
