from base64 import urlsafe_b64encode
from hashlib import sha256

from cryptography.fernet import Fernet
from django.conf import settings

from .models import CortexITimeCredential


def pin_cipher():
    key = sha256(f"rota-cortex-itime-v1:{settings.SECRET_KEY}".encode()).digest()
    return Fernet(urlsafe_b64encode(key))


def save_cortex_access(employee, site, pin):
    if pin:
        credential, _ = CortexITimeCredential.objects.update_or_create(
            employee=employee,
            defaults={"encrypted_pin": pin_cipher().encrypt(pin.encode()).decode()},
        )
        employee.cortex_itime_credential = credential
    else:
        credential = employee.cortex_itime_credential
    if site:
        credential.sites.add(site)
