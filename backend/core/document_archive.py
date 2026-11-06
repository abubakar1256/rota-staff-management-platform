import re
from pathlib import PurePosixPath
from tempfile import TemporaryFile
from zipfile import ZipFile

from rest_framework import serializers
from rest_framework.exceptions import ValidationError


MAX_ARCHIVE_FILES = 100
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024


class DocumentArchiveSerializer(serializers.Serializer):
    document_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1, max_value=2**63 - 1),
        min_length=1,
        max_length=MAX_ARCHIVE_FILES,
    )


def safe_name(value, fallback, length):
    name = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', "_", value).strip(" .")[:length].rstrip(" .")
    if re.fullmatch(r"CON|PRN|AUX|NUL|(?:COM|LPT)[0-9¹²³]", name.partition(".")[0].upper()):
        name = f"_{name}"
    return name or fallback


def archive_path(document):
    employee = document.employee
    name = safe_name(employee.name, "Guard", 60)
    employee_id = safe_name(employee.employee_id, "Employee", 40)
    kind = document.document_type
    if document.certificate_type:
        kind = f"Certificate - {document.certificate_name or document.get_certificate_type_display()}"
    title = safe_name(kind, "Document", 72)
    extension = PurePosixPath(document.file.name).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,12}", extension):
        extension = ""
    return f"{name} - {employee_id} ({employee.pk})/{title} - {document.pk}{extension}"


def build_document_archive(documents):
    archive_file = TemporaryFile()
    total_bytes = 0
    try:
        with ZipFile(archive_file, "w") as archive:
            for document in documents:
                try:
                    if not document.file:
                        raise FileNotFoundError
                    with document.file.open("rb") as source, archive.open(archive_path(document), "w") as target:
                        while chunk := source.read(1024 * 1024):
                            total_bytes += len(chunk)
                            if total_bytes > MAX_ARCHIVE_BYTES:
                                raise ValidationError({"detail": "The selected files exceed 100 MB. Select fewer files and try again."})
                            target.write(chunk)
                except OSError as exc:
                    raise ValidationError({
                        "detail": f"Could not include {document.document_type} for {document.employee.name}. "
                                  "Check that the uploaded file opens, or remove it from the selection.",
                    }) from exc
        archive_file.seek(0)
        return archive_file
    except BaseException:
        archive_file.close()
        raise
