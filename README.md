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

## Next implementation phases

1. Daily operations, attendance, and operational notes
2. Audit events, notifications, and export/PDF reports
3. Production hardening, PostgreSQL, object storage, backups, and deployment
