# Deployment Runbook

The project is prepared for a two-service Railway deployment: a Django API and a React frontend, backed by PostgreSQL. The included render.yaml is retained for Render users but is not required by Railway.

## Railway service commands

Backend service:

~~~text
Build:       pip install -r backend/requirements.txt && python backend/manage.py collectstatic --noinput
Pre-deploy:  python backend/manage.py migrate
Start:       gunicorn --chdir backend config.wsgi:application --bind 0.0.0.0:$PORT
Health:      /health/
~~~

Frontend service (root directory frontend):

~~~text
Build:  npm ci && npm run build
Start:  npm start
~~~

The frontend server serves the Vite dist directory and falls back to index.html for /guard and /client client-side routes.

Railway is configured from the dashboard using the commands above; the included render.yaml is retained only for Render deployments.

## Required production settings

1. Add a strong `DJANGO_SECRET_KEY` in the hosting provider's environment settings.
2. Set a strong `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0`, `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, and `CORS_ALLOWED_ORIGINS`.
3. Configure PostgreSQL with Railway's `DATABASE_URL` reference, or the `DB_*` variables supported by the backend.
4. Set the frontend `VITE_API_BASE_URL` to the deployed backend `/api` URL.
5. Run migrations as the backend pre-deploy command and `collectstatic` during the backend build.
6. Configure persistent media storage before accepting real employee documents or attendance photos.
7. Run `python backend/manage.py seed_demo` only for a non-production demo environment; never use the demo password in production.

## Local production checks

```powershell
cd backend
$env:DJANGO_DEBUG = "0"
python manage.py check --deploy
python manage.py collectstatic --noinput
```

The report print endpoint is intentionally print-friendly so users can choose **Print / Save as PDF** in the browser without adding a server-side PDF dependency. CSV exports open directly in Excel and other spreadsheet applications.
