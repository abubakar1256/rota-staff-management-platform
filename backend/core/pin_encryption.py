from base64 import urlsafe_b64encode
from hashlib import sha256

from cryptography.fernet import Fernet
from django.conf import settings


def pin_cipher(system):
    key = sha256(f"rota-{system}-v1:{settings.SECRET_KEY}".encode()).digest()
    return Fernet(urlsafe_b64encode(key))
