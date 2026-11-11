"""Google Drive OAuth and approved-document synchronisation helpers."""

import base64
import hashlib
import mimetypes
import re

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.urls import reverse
from django.utils.crypto import salted_hmac
from django.utils import timezone

from .models import AuditLog, GoogleDriveConnection


OAUTH_SALT = "rotaops-google-drive-oauth"
OAUTH_STATE_MAX_AGE = 15 * 60
DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"


class DriveConnectionError(Exception):
    pass


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

    verifier = salted_hmac(f"{OAUTH_SALT}-pkce", state, algorithm="sha256").hexdigest()
    flow = Flow.from_client_config(
        client_config(), scopes=settings.GOOGLE_DRIVE_SCOPES, state=state,
        code_verifier=verifier, autogenerate_code_verifier=False,
    )
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


def connection_version(item):
    if not item:
        return ""
    state = f"{item.encrypted_refresh_token}:{item.root_folder_id}"
    return hashlib.sha256(state.encode("utf-8")).hexdigest()


def save_oauth_connection(credentials, user, expected_version):
    from googleapiclient.errors import HttpError

    if not credentials.refresh_token:
        raise DriveConnectionError("Google did not grant offline access. Choose the Google account again and approve Drive access.")

    existing = connection()
    if connection_version(existing) != expected_version:
        raise DriveConnectionError("The Drive connection changed. Reopen Documents and try again.")

    service = build_drive_service(credentials)
    email = service.about().get(fields="user(emailAddress)").execute().get("user", {}).get("emailAddress", "")
    if not email:
        raise DriveConnectionError("Google did not identify the Drive account. Try connecting again.")

    root_id = ""
    if not existing:
        root_id = settings.GOOGLE_DRIVE_ROOT_FOLDER_ID.strip()
    elif not existing.authorized_email or existing.authorized_email.casefold() == email.casefold():
        root_id = existing.root_folder_id or settings.GOOGLE_DRIVE_ROOT_FOLDER_ID.strip()

    if root_id:
        try:
            folder = service.files().get(
                fileId=root_id, fields="mimeType,trashed,ownedByMe,capabilities(canAddChildren)",
            ).execute()
        except HttpError as exc:
            if not existing or exc.resp.status not in {403, 404}:
                raise
            folder = {}
        writable = (
            folder.get("mimeType") == DRIVE_FOLDER_MIME and not folder.get("trashed")
            and folder.get("capabilities", {}).get("canAddChildren")
        )
        known_account = existing and existing.authorized_email
        if not writable or (existing and not known_account and not folder.get("ownedByMe")):
            if not existing:
                raise DriveConnectionError("The configured Drive folder is unavailable or cannot accept files.")
            root_id = ""

    if not root_id:
        root_id = _find_or_create_folder(service, "All Guards", "root", private_only=True)

    with transaction.atomic():
        item, created = GoogleDriveConnection.objects.select_for_update().get_or_create(connection_key="default")
        if connection_version(None if created else item) != expected_version:
            raise DriveConnectionError("The Drive connection changed. Reopen Documents and try again.")
        item.encrypted_refresh_token = encrypt_refresh_token(credentials.refresh_token)
        item.scopes = list(credentials.scopes or settings.GOOGLE_DRIVE_SCOPES)
        item.connected_by = user
        item.authorized_email = email
        item.root_folder_id = root_id
        item.save(update_fields=["encrypted_refresh_token", "scopes", "connected_by", "authorized_email", "root_folder_id", "updated_at"])
        AuditLog.objects.create(
            user=user, action="CONNECT" if created else "RECONNECT", model_name="GoogleDriveConnection",
            object_id=item.pk, summary=f"Connected Google Drive as {email}",
        )
    return item


def build_drive_service(credentials):
    from googleapiclient.discovery import build

    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def drive_service():
    from google.oauth2.credentials import Credentials

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
    return build_drive_service(credentials), item


def _safe_name(value):
    cleaned = re.sub(r"[^A-Za-z0-9 ._()&—-]+", "", str(value or "")).strip()
    return cleaned or "Guard"


def _find_or_create_folder(service, name, parent_id=None, *, private_only=False):
    escaped_name = name.replace("'", "\\'")
    query = f"name = '{escaped_name}' and mimeType = '{DRIVE_FOLDER_MIME}' and trashed = false"
    if parent_id:
        query += f" and '{parent_id}' in parents"
    fields = "files(id,ownedByMe,shared,capabilities(canAddChildren))" if private_only else "files(id)"
    result = service.files().list(q=query, spaces="drive", fields=fields, pageSize=100).execute()
    for folder in result.get("files", []):
        if not private_only or (folder.get("ownedByMe") and not folder.get("shared") and folder.get("capabilities", {}).get("canAddChildren")):
            return folder["id"]
    body = {"name": name, "mimeType": DRIVE_FOLDER_MIME}
    if parent_id:
        body["parents"] = [parent_id]
    return service.files().create(body=body, fields="id").execute()["id"]


def sync_verified_document(document):
    """Upload one verified local document; failures stay visible on its record."""

    if not document.file:
        return None
    try:
        service, item = drive_service()
        if not service or not item:
            return None
        from googleapiclient.http import MediaIoBaseUpload

        root_id = item.root_folder_id
        if not root_id:
            root_id = settings.GOOGLE_DRIVE_ROOT_FOLDER_ID.strip() or _find_or_create_folder(service, "All Guards")
            with transaction.atomic():
                current = GoogleDriveConnection.objects.select_for_update().get(pk=item.pk)
                if current.encrypted_refresh_token != item.encrypted_refresh_token:
                    return None
                if current.root_folder_id:
                    root_id = current.root_folder_id
                else:
                    current.root_folder_id = root_id
                    current.save(update_fields=["root_folder_id", "updated_at"])
        guard_folder_id = _find_or_create_folder(service, f"{_safe_name(document.employee.name)} — {document.employee.employee_id}", root_id)
        filename = _safe_name(document.document_type)
        original_name = document.file.name.rsplit("/", 1)[-1]
        extension = original_name.rsplit(".", 1)[-1] if "." in original_name else ""
        if extension:
            filename = f"{filename}.{extension}"
        document.file.open("rb")
        media = MediaIoBaseUpload(document.file, mimetype=mimetypes.guess_type(original_name)[0] or "application/octet-stream", resumable=False)
        body = {"name": filename, "parents": [guard_folder_id]}
        if document.drive_file_id and document.drive_folder_id == guard_folder_id:
            uploaded = service.files().update(fileId=document.drive_file_id, body={"name": filename}, media_body=media, fields="id").execute()
        else:
            uploaded = service.files().create(body=body, media_body=media, fields="id").execute()
        document.drive_file_id = uploaded["id"]
        document.drive_folder_id = guard_folder_id
        document.drive_root_folder_id = root_id
        document.drive_synced_at = timezone.now()
        document.drive_sync_error = ""
        with transaction.atomic():
            current = GoogleDriveConnection.objects.select_for_update().get(pk=item.pk)
            if current.root_folder_id == root_id:
                document.save(update_fields=["drive_file_id", "drive_folder_id", "drive_root_folder_id", "drive_synced_at", "drive_sync_error", "updated_at"])
        return uploaded["id"]
    except Exception as exc:  # Drive failure must not undo office verification.
        document.drive_sync_error = str(exc)[:2000]
        document.save(update_fields=["drive_sync_error", "updated_at"])
        from .notifications import publish_notification
        publish_notification(title="Google Drive upload failed", message=f"{document.employee.name}: the verified document could not be copied to Google Drive. Retry from Documents.", link="documents", category="SYSTEM", priority="URGENT", notification_type="WARNING", employee=document.employee, context={"document_id": document.pk}, event_key=f"drive-failure:{document.pk}:{document.file.name}")
        raise
    finally:
        try:
            document.file.close()
        except Exception:
            pass
