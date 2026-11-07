from .models import CortexITimeCredential
from .pin_encryption import pin_cipher


def save_cortex_access(employee, site, pin):
    if pin:
        credential, _ = CortexITimeCredential.objects.update_or_create(
            employee=employee,
            defaults={"encrypted_pin": pin_cipher("cortex-itime").encrypt(pin.encode()).decode()},
        )
        employee.cortex_itime_credential = credential
    else:
        credential = employee.cortex_itime_credential
    if site:
        credential.sites.add(site)
