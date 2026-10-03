# Deployment Runbook

The project is deployment-ready but is not published automatically. Use the included `render.yaml` as a starting point for a backend web service and a static frontend service.

## Required production settings

1. Copy `backend/.env.example` into the hosting provider's environment settings.
2. Set a strong `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0`, `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, and `CORS_ALLOWED_ORIGINS`.
3. Configure PostgreSQL values with `DB_ENGINE=postgres`.
4. Set the frontend `VITE_API_BASE_URL` to the deployed backend `/api` URL.
5. Run migrations and `collectstatic` during the backend build.
6. Run `python backend/manage.py seed_demo` only for a non-production demo environment; never use the demo password in production.

## Local production checks

```powershell
cd backend
$env:DJANGO_DEBUG = "0"
python manage.py check --deploy
python manage.py collectstatic --noinput
```

The report print endpoint is intentionally print-friendly so users can choose **Print / Save as PDF** in the browser without adding a server-side PDF dependency. CSV exports open directly in Excel and other spreadsheet applications.
