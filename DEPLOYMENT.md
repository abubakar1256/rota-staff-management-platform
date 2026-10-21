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
6. Configure persistent media storage before accepting real employee documents or attendance photos. On Railway, attach a Volume to the backend service at `/data` and set `DJANGO_MEDIA_ROOT=/data/media`. The application already reads this setting and serves uploaded files through authenticated media endpoints, so documents and attendance photos are not lost on redeploy and are not publicly exposed.
7. Run `python backend/manage.py seed_demo` only for a non-production demo environment; never use the demo password in production.

## Gmail SMTP and password reset

The application now includes a secure **Forgot password?** flow for the admin and guard portals. It sends a one-time reset link through Gmail SMTP, expires the link after use/expiry, and invalidates existing login tokens after the password is changed.

Use a Google App Password; do not use the normal Gmail account password. The Google account must have 2-Step Verification enabled, then create an App Password from [Google App Passwords](https://myaccount.google.com/apppasswords).

Add these variables to the **backend service** in Railway:

```text
EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USE_TLS=1
EMAIL_HOST_USER=your Gmail address
EMAIL_HOST_PASSWORD=your 16-character Google App Password
DEFAULT_FROM_EMAIL=ROTA Operations <your Gmail address>
FRONTEND_URL=https://your-frontend-domain.example.com
```

Keep `EMAIL_HOST_PASSWORD` private and add it only in Railway Variables. Do not commit it to GitHub. After saving the variables, redeploy the backend and test from `/` and `/guard` using **Forgot password?**. The reset link will open `/reset-password` and return the user to the correct portal after success.

## Local production checks

```powershell
cd backend
$env:DJANGO_DEBUG = "0"
python manage.py check --deploy
python manage.py collectstatic --noinput
```

The report print endpoint is intentionally print-friendly so users can choose **Print / Save as PDF** in the browser without adding a server-side PDF dependency. CSV exports open directly in Excel and other spreadsheet applications.

## Guard portal requirements

The live guard attendance camera and GPS APIs require the deployed HTTPS URL. Before using Book On, hourly check-ins, or Book Off on a phone:

1. Open the guard portal using the Railway HTTPS domain.
2. Allow camera and location permissions in the browser.
3. Configure latitude and longitude for each site in the admin portal.
4. Keep the Railway Volume mounted at `/data`; otherwise uploaded photos, documents, and generated reports will disappear after a redeploy.
