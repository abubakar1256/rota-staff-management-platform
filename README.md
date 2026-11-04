# Rota Staff Management Platform

Multi-client security staff management platform for clients, sites, guards, weekly rotas, attendance and day/night PDF reports.

## Included

- Django 5 + Django REST Framework backend
- Token authentication with role-aware users
- Role hierarchy: Super Admin → Admin → Manager → Operator → Guard
- Client Admin portal with strict client/site data isolation
- Employee and site management APIs
- Client records and client-linked sites
- Shift types, weekly rotas, assignments, overlap conflict checking, and rota publishing
- Leave requests with approval/rejection and rota availability blocking
- Employee document records with valid, expiring-soon, and expired statuses
- Timesheets with overnight-hour calculation and overtime tracking
- Reports for employee/site hours, leave, overtime, and expiry alerts
- Daily operations and attendance/follow-up records
- In-app notifications and an activity/audit log
- Excel-compatible CSV exports and print-to-PDF report view
- Production environment examples and Render deployment configuration
- Dashboard summary API
- React + Vite frontend with internal operations portal, Guard Portal and Client Admin Portal
- SQLite by default for local development; PostgreSQL configuration via environment variables

## Backend

```powershell
cd backend
python manage.py migrate
python manage.py seed_demo
python manage.py runserver
```

Demo login after seeding:

- Email: `admin@rota.local`
- Password: `Admin123!`

API base URL: `http://127.0.0.1:8000/api/`

## Frontend

```powershell
cd frontend
npm install
npm run dev
```

Do not double-click `frontend/index.html`; Vite must serve the React modules. Open `http://127.0.0.1:5175` after starting the dev server. The frontend expects the backend at `http://127.0.0.1:8000/api`. Override it with `VITE_API_BASE_URL` when needed.

## Client Admin portal

1. A Super Admin or Admin creates a client from **Clients**.
2. Add each site from **Sites** and select its client.
3. Create a linked user with the **Client Admin** role.
4. The Client Admin signs in at `/client` and can view only that client's sites, published rotas, attendance and private day/night PDF reports.

Client Admin access is read-only. Guard personal documents and internal activity logs are never exposed to the client portal.

## Current rota workflow

1. Open **Weekly Rota** in the app and choose any date; it is normalised to that Monday's week.
2. Add a shift assignment for a site and employee, or leave the employee empty to mark an unfilled shift.
3. Assignments are rejected when an employee is inactive or already has an overlapping shift on that date.
4. Publish the rota when it is ready; published rotas are locked against changes.

## Operations and exports

- **Operations** records daily staffing status, attendance, notes, and follow-up actions.
- **Notifications** shows workflow alerts such as leave approvals and rejections.
- **Activity log** records create/update/delete and approval events.
- **Reports** can export timesheets as CSV (opens in Excel) or open a print-friendly report for browser PDF saving.

## Completed attendance and timesheets

- A successful Book Off closes the guard's attendance controls and shows the site, date, actual Book On/Off timestamps and elapsed duration. Pictures and reasons remain available as history.
- Each newly completed shift creates one unapproved timesheet. Retried submissions cannot create duplicates or replace approved hours. Actual elapsed hours include overnight shifts and clock changes; overtime remains an office-controlled field.
- Active Admin and Super Admin users receive a completion notification. Late Book On, GPS exceptions and missed required hourly pictures are flagged for review. Sites using Book On/Off only do not require hourly pictures.
- In **Timesheets**, open **Review**, inspect attendance evidence and choose **Approve timesheet**. Approval records the reviewer and timestamp, adds an audit entry and notifies only the relevant guard.
- Attendance-linked timestamps and completed shift assignments are retained as evidence. Office users may correct recorded reasons through the audited attendance endpoints.
- A missed Book Off reason alone does not complete a shift or create hours. Older completed records show their existing evidence without automatically creating historical timesheets.
- Apply backend migration `0035_completed_shift_timesheet` with `python manage.py migrate` when deploying this update.

## Guard profile completion

- Newly activated guards open **My profile**. The steps are picture, personal details, contact details, emergency contact, then review and submit.
- Guards choose and crop a passport-size picture, then Next uploads it and opens personal details. Nationality uses a searchable country list with no default selection for a new profile.
- **Save & next** saves that step. **Back** keeps entered values; **Save draft** allows guards to continue later.
- Profile completion counts guard-controlled details, the saved picture and the submitted declaration. Office-managed position and joining date do not prevent guards from reaching 100%.
- Final submission requires all profile fields, a saved picture and an explicit declaration checkbox. The server records the declaration, timestamp and submitted details in the audit log.
- Editing profile details or replacing/deleting the picture requires a fresh declaration. Reviewing the same picture in the office preserves the guard's declaration.
- Deploy backend and frontend together and apply migration `0036_guard_profile_declaration` with `python manage.py migrate`.

## Admin login security

- Admin and Super Admin must use an authenticator app. After their password is accepted, first login shows a locally generated QR code and manual setup key. A fresh 6-digit authenticator code is required before any session is issued.
- Existing weak passwords must be replaced during verification. Admin passwords require at least 12 characters and reject common, entirely numeric and account-similar passwords. The same policy applies to admin creation, password changes and email OTP resets. Resetting a password does not disable 2FA.
- First enrollment shows eight single-use recovery codes. Download/store them before continuing; they cannot be displayed again. Five incorrect factors temporarily block verification for 15 minutes, across new login challenges. Used authenticator codes cannot be replayed.
- Admin sessions expire after 30 minutes without user interaction, with an 8-hour maximum. Background polling and page reloads do not extend inactivity. A warning offers **Continue session** before idle expiry; the current form stays mounted. Admin credentials are kept in tab session storage and stored only as hashes on the server.
- **Sign out** revokes the server session. **Security** in the admin sidebar shows authenticator status, unused recovery-code count, active sessions, sign-out-other-sessions and login history. Admin sees their own history; Super Admin sees admin account history. The Django maintenance `/admin/` portal enforces the same authenticator and deadlines and requires enrollment through the operations portal first.
- Deploy backend and frontend together. Apply migration `0039_admin_login_security` with `python manage.py migrate`. Previous admin tokens stop working and admins must sign in again. Keep the existing `DJANGO_SECRET_KEY` stable across redeploys so stored authenticator secrets remain usable. Guard and Client Admin sign-in flows retain their existing password flow.
- Optional backend variables: `ADMIN_SESSION_IDLE_SECONDS=1800`, `ADMIN_SESSION_MAX_SECONDS=28800`. `ADMIN_TRUST_PROXY_HEADERS=0` uses the direct connection IP; enable it only behind a trusted proxy that reliably sets `X-Forwarded-For`. Browser/device and timestamps are recorded regardless.

## Duty location tracking

- In **Sites → Add/Edit site**, enable **30-minute location tracking** for each participating site. Existing sites default to off. Guards see a tracking notice throughout their portal while an enabled shift is booked on.
- Book On provides the first recorded point. The open, visible guard portal attempts a fresh GPS fix every 30 minutes. A lightweight five-minute heartbeat records portal contact separately; it never makes an old location look fresh. Failed fixes are classified as permission denied, unavailable or timeout. GPS failures retry no more frequently than every five minutes unless the guard explicitly retries or restores permission.
- While booked on, the visible guard portal also checks GPS movement against the site's current geofence, independently of the optional 30-minute reports. Leaving the radius shows a red warning, popup and the assigned site's address. The guard receives one private urgent Attendance notification per outside episode; returning inside clears the warning and resolves that notification. Poor GPS accuracy cannot confirm either a breach or recovery. Only boundary transitions are reported, rather than every GPS fix. This watch stops when the page is hidden, the shift ends or Book Off closes the session; browser suspension can delay detection.
- Tracking ends after Book Off, scheduled shift end, site disablement or guard deactivation. Pending uploads are rejected server-side after tracking ends. New location evidence requires finite, valid coordinates, reported accuracy and a fresh timezone-aware GPS timestamp. Recorded points retain their original guard/shift identity.
- **Shift attendance → Location tracker** shows guards by site, status, last portal contact, last GPS time, accuracy, map links and paginated shift history. It includes an overnight shift still active today. These timestamps use `Europe/London`; map pins are explicitly labelled as the last recorded position.
- No fresh location for 35 minutes (30-minute interval plus five-minute grace) generates one urgent **Attendance** notification per incident. Recovery resolves that alert and generates one **Location restored** notice. The notification opens that guard's tracker/history. Manager access is restricted to assigned sites; clients/operators cannot use these tracking endpoints, and guards can only submit/read their own evidence.
- Apply migration `0040_duty_location_tracking`, then deploy backend and frontend together. For checks while the admin portal is closed, add a **separate Railway cron service** using this repository with root directory `/backend` and config path `/deploy/railway-location-cron.json`. Give it references to the existing backend's `DATABASE_URL`, stable `DJANGO_SECRET_KEY`, and `DJANGO_TIME_ZONE=Europe/London`. Run it only after the backend migration has succeeded. The command is `python manage.py check_location_tracking`, schedule `*/5 * * * *`, restart policy `NEVER`. This configuration must be attached to the cron service rather than the web backend. See [Railway cron jobs](https://docs.railway.com/cron-jobs).
- The existing `refresh_notification_alerts` command and office notification reads also run the overdue check. Cron timings and browser execution are best-effort: phone lock, a suspended/closed browser, denied permissions, battery limits or a lost connection can delay updates. A missing update does not establish that a guard intentionally switched GPS off. Background tracking with the browser closed requires a mobile app and appropriate platform permissions.

## Next implementation phases

1. Daily operations, attendance, and operational notes
2. Audit events, notifications, and export/PDF reports
3. Production hardening, PostgreSQL, object storage, backups, and deployment
