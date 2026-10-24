"""Google Drive OAuth and approved-document synchronisation helpers."""

import base64
import hashlib
import mimetypes
import re

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.urls import reverse
from django.utils import timezone

from .models import GoogleDriveConnection


OAUTH_SALT = "rotaops-google-drive-oauth"
OAUTH_STATE_MAX_AGE = 15 * 60
DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"


def is_configured():
    return bool(settings.GOOGLE_DRIVE_CLIENT_ID and settings.GOOGLE_DRIVE_CLIENT_SECRET)


def redirect_uri(request):
    configured = settings.GOOGLE_DRIVE_REDIRECT_URI.strip()
    return configured or request.build_absolute_uri(reverse("google-drive-callback"))


def client_config():
    if not is_configured():
        raise RuntimeError("Google Drive OAuth is not configured on the backend.")
    return {
        "web": {
            "client_id": settings.GOOGLE_DRIVE_CLIENT_ID,
            "client_secret": settings.GOOGLE_DRIVE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }


def build_flow(redirect, state=None):
    from google_auth_oauthlib.flow import Flow

    flow = Flow.from_client_config(client_config(), scopes=settings.GOOGLE_DRIVE_SCOPES, state=state)
    flow.redirect_uri = redirect
    return flow


def encrypt_refresh_token(value):
    from cryptography.fernet import Fernet

    key = base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode("utf-8")).digest())
    return Fernet(key).encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_refresh_token(value):
    from cryptography.fernet import Fernet

    key = base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode("utf-8")).digest())
    return Fernet(key).decrypt(value.encode("utf-8")).decode("utf-8")


def connection():
    return GoogleDriveConnection.objects.filter(connection_key="default").first()


def save_oauth_connection(credentials, user):
    refresh_token = credentials.refresh_token
    if not refresh_token:
        existing = connection()
        if not existing:
            raise RuntimeError("Google did not return a refresh token. Reconnect and approve access again.")
        refresh_token = decrypt_refresh_token(existing.encrypted_refresh_token)

    with transaction.atomic():
        item, _ = GoogleDriveConnection.objects.get_or_create(connection_key="default", defaults={"encrypted_refresh_token": ""})
        item.encrypted_refresh_token = encrypt_refresh_token(refresh_token)
        item.scopes = list(credentials.scopes or settings.GOOGLE_DRIVE_SCOPES)
        item.connected_by = user
        item.save(update_fields=["encrypted_refresh_token", "scopes", "connected_by", "updated_at"])
    return item


def drive_service():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    item = connection()
    if not item or not item.encrypted_refresh_token:
        return None, None
    credentials = Credentials(
        token=None,
        refresh_token=decrypt_refresh_token(item.encrypted_refresh_token),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=settings.GOOGLE_DRIVE_CLIENT_ID,
        client_secret=settings.GOOGLE_DRIVE_CLIENT_SECRET,
        scopes=item.scopes or settings.GOOGLE_DRIVE_SCOPES,
    )
    return build("drive", "v3", credentials=credentials, cache_discovery=False), item


def _safe_name(value):
    cleaned = re.sub(r"[^A-Za-z0-9 ._()&—-]+", "", str(value or "")).strip()
    return cleaned or "Guard"


def _find_or_create_folder(service, name, parent_id=None):
    escaped_name = name.replace("'", "\\'")
    query = f"name = '{escaped_name}' and mimeType = '{DRIVE_FOLDER_MIME}' and trashed = false"
    if parent_id:
        query += f" and '{parent_id}' in parents"
    result = service.files().list(q=query, spaces="drive", fields="files(id,name)", pageSize=10).execute()
    if result.get("files"):
        return result["files"][0]["id"]
    body = {"name": name, "mimeType": DRIVE_FOLDER_MIME}
    if parent_id:
        body["parents"] = [parent_id]
    return service.files().create(body=body, fields="id").execute()["id"]


def sync_verified_document(document):
    """Upload one verified local document; failures stay visible on its record."""

    if not document.file:
        return None
    service, item = drive_service()
    if not service or not item:
        return None

    try:
        from googleapiclient.http import MediaIoBaseUpload

        root_id = item.root_folder_id or settings.GOOGLE_DRIVE_ROOT_FOLDER_ID.strip()
        if not root_id:
            root_id = _find_or_create_folder(service, "All Guards")
            item.root_folder_id = root_id
            item.save(update_fields=["root_folder_id", "updated_at"])
        guard_folder_id = _find_or_create_folder(service, f"{_safe_name(document.employee.name)} — {document.employee.employee_id}", root_id)
        filename = _safe_name(document.document_type)
        original_name = document.file.name.rsplit("/", 1)[-1]
        extension = original_name.rsplit(".", 1)[-1] if "." in original_name else ""
        if extension:
            filename = f"{filename}.{extension}"
        document.file.open("rb")
        media = MediaIoBaseUpload(document.file, mimetype=mimetypes.guess_type(original_name)[0] or "application/octet-stream", resumable=False)
        body = {"name": filename, "parents": [guard_folder_id]}
        if document.drive_file_id:
            uploaded = service.files().update(fileId=document.drive_file_id, body={"name": filename}, media_body=media, fields="id").execute()
        else:
            uploaded = service.files().create(body=body, media_body=media, fields="id").execute()
        document.drive_file_id = uploaded["id"]
        document.drive_folder_id = guard_folder_id
        document.drive_synced_at = timezone.now()
        document.drive_sync_error = ""
        document.save(update_fields=["drive_file_id", "drive_folder_id", "drive_synced_at", "drive_sync_error", "updated_at"])
        return uploaded["id"]
    except Exception as exc:  # Drive failure must not undo office verification.
        document.drive_sync_error = str(exc)[:2000]
        document.save(update_fields=["drive_sync_error", "updated_at"])
        raise
    finally:
        try:
            document.file.close()
        except Exception:
            pass
