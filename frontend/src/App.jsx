import { attendanceGeofenceIssue, readCurrentLocation } from "./attendanceGeofence.js";
import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Bell, BriefcaseBusiness, Building2, CalendarDays, Camera, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Clock3, Copy, Download, ExternalLink, FileText, History, LayoutDashboard, LogOut, Megaphone, Menu, MessageCircle, Pencil, RefreshCw, Search, ShieldCheck, Trash2, Upload, Users, UserPlus, X } from "lucide-react";
import { invalidateForPath, queryClient } from "./queryClient";
import AdminSecurity, { AdminMFA, AdminSessionMonitor } from "./AdminSecurity";
import DashboardClock from "./DashboardClock";
import GuardLocationMonitor from "./GuardLocationMonitor";
import GuardSiteInductions from "./GuardSiteInductions";
import { cortexActivationWarning, EmployeeCortexITimeFields, GuardCortexITime } from "./CortexITime";
import { EmployeeTimeGateFields, GuardTimeGate } from "./TimeGate";
import GuardAvailability, { guardUnavailableMessage, unavailableDays, unavailableShiftDate, useGuardAvailability } from "./GuardAvailability";
import { SiteLocationLinks, SitePinInput } from "./SiteLocation";
import LocationTracker from "./LocationTracker";
import CompleteShiftReview from "./CompleteShiftReview";
import ReachedReport from "./ReachedReport";
import DailyOperationsPage from "./DailyOperationsPage";
import { ControlPortal, ControlTeamAdmin } from "./ControlTeam";
import { siteWeekSlots } from "./rotaStaffing.js";
import { BulkAssignmentDialog, NeedsCover, PublishRotaDialog, RotaBatchDialog } from "./RotaPlanning";
import { ukDate, formatUkAttendanceTime, formatUkDateTime } from "./ukTime.js";
import { clearAuth, endAdminSession, getToken, isControlPortal, readAdminSession, storeLogin, syncAdminSession } from "./authSession";
import { GuardScreening, AdminScreening } from "./SecurityScreening";
import CheckUpdatesButton from "./CheckUpdatesButton";
import { siteAttendanceModes, siteAttendanceLabel, hourlyCheckinsFor, bookOnIsLate } from "./siteAttendance";
import { ShiftCompletionSummary, CompletedAttendanceHistory } from "./ShiftCompletionSummary";
import TimesheetReview from "./TimesheetReview";
import ToastNotifications from "./ToastNotifications";
import GuardProfileWizard from "./GuardProfileWizard";
import GuardDocumentsWizard from "./GuardDocumentsWizard";
import DocumentOptions from "./DocumentOptions";
import AdminNotifications from "./AdminNotifications";
import GuardNotifications from "./GuardNotifications";
import { RotaWhatsAppPanel, StaffAnnouncements } from "./WhatsAppMessaging";
import { guardNotificationAction, guardNotificationCategories } from "./notificationInbox";
import { certificateLabel, certificateTypes, documentDriveStatus, documentFieldRules, optionalDocumentItemsFor, requiredDocumentItems } from "./documentWizard";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const PORTAL_ORIGIN = import.meta.env.VITE_PORTAL_ORIGIN || ((window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") ? "http://192.168.1.8:5175" : window.location.origin);
function notifyToast(message, type = "success") {
  window.dispatchEvent(new CustomEvent("rota:toast", { detail: { message, type } }));
}

function RotaLoader({ label = "Loading your operations…", compact = false, overlay = false }) {
  return <div className={`rota-loader${compact ? " compact" : ""}${overlay ? " overlay" : ""}`} role="status" aria-live="polite" aria-label={label}>
    <div className="rota-loader-mark" aria-hidden="true">
      <div className="rota-loader-ring" />
      <div className="rota-loader-shield"><ShieldCheck size={compact ? 16 : 22} strokeWidth={2.2} /></div>
      <span className="rota-loader-dot dot-one" />
      <span className="rota-loader-dot dot-two" />
      <span className="rota-loader-dot dot-three" />
    </div>
    <div className="rota-loader-copy"><strong>RotaOps</strong><span>{label}</span></div>
  </div>;
}

async function api(path, options = {}) {
  const token = getToken();
  const headers = { ...(token ? { Authorization: `Token ${token}` } : {}), ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const showRequestLoader = !options.silentLoading;
  if (showRequestLoader) window.dispatchEvent(new Event("rota:request-start"));
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
    if (!response.ok) {
      if (response.status === 401 && token && token === getToken()) {
        if (readAdminSession()) endAdminSession("Your admin session has ended. Please sign in again.");
        if (isControlPortal()) {
          clearAuth();
          window.dispatchEvent(new CustomEvent("rota:session-ended", { detail: { message: "Your Control Team session has ended. Please sign in again." } }));
        }
      }
      const payload = await response.json().catch(() => ({}));
      const fieldErrors = Object.entries(payload).filter(([key]) => key !== "detail" && key !== "errors").map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      const bulkErrors = Array.isArray(payload.errors) ? payload.errors.map((item) => `${item.employee}: ${Object.values(item.errors || {}).flat().join(", ")}`).join(" | ") : "";
      const fallback = response.status >= 500 ? `The server could not complete this request (HTTP ${response.status}). Please try again or contact the office.` : `Request failed (HTTP ${response.status}). Please try again.`;
      const message = payload.detail || bulkErrors || fieldErrors.join(" | ") || fallback;
      if (!options.silentError) notifyToast(message, "error");
      const error = new Error(message); error.status = response.status; error.payload = payload; throw error;
    }
    const responseText = await response.text();
    const result = responseText ? JSON.parse(responseText) : {};
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET" && !path.startsWith("/auth/") && !options.silentToast) {
      notifyToast(method === "DELETE" ? "Deleted successfully." : method === "PATCH" ? "Changes saved successfully." : "Saved successfully.");
    }
    if (method !== "GET" && !path.startsWith("/auth/") && !options.skipInvalidation) invalidateForPath(path);
    if (method !== "GET" && path.startsWith("/control/") && !path.startsWith("/control/notifications/") && path !== "/control/logout/" &&
      (path !== "/control/attendance/location/" || result.status === "checked_out")) {
      window.dispatchEvent(new Event("rota:notifications-changed"));
    }
    return result;
  } finally {
    if (showRequestLoader) window.dispatchEvent(new Event("rota:request-end"));
  }
}

function ToastHost() {
  return <><GlobalRequestLoader /><ToastNotifications /></>;
}

function GlobalRequestLoader() {
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let showTimer;
    const start = () => {
      setActive((count) => {
        const next = count + 1;
        if (next === 1) showTimer = window.setTimeout(() => setVisible(true), 180);
        return next;
      });
    };
    const end = () => {
      setActive((count) => {
        const next = Math.max(0, count - 1);
        if (next === 0) { window.clearTimeout(showTimer); setVisible(false); }
        return next;
      });
    };
    window.addEventListener("rota:request-start", start);
    window.addEventListener("rota:request-end", end);
    return () => { window.clearTimeout(showTimer); window.removeEventListener("rota:request-start", start); window.removeEventListener("rota:request-end", end); };
  }, []);
  return visible && active > 0 ? <div className="global-request-loader" role="status" aria-live="polite"><span className="global-request-spinner" /><strong>RotaOps</strong><span>Updating live data…</span></div> : null;
}

function GuardNotificationBell({ unreadCount, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const widgetRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api("/notifications/", { silentLoading: true });
      setItems(data.slice(0, 6));
    } catch {
      // The shared API helper already shows the error toast when needed.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    load();
    const refresh = () => load();
    const timer = window.setInterval(load, 30000);
    window.addEventListener("rota:notifications-changed", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("rota:notifications-changed", refresh); };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => {
      if (!widgetRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        widgetRef.current?.querySelector(".guard-notification-trigger")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);

  const markRead = async (id, event) => {
    event.stopPropagation();
    try {
      await api(`/notifications/${id}/mark_read/`, { method: "POST", body: "{}", silentToast: true, silentLoading: true });
      setItems((current) => current.map((item) => item.id === id ? { ...item, is_read: true } : item));
      window.dispatchEvent(new Event("rota:notifications-changed"));
    } catch {
      // Error toast is handled by api().
    }
  };

  return <div className="guard-notification-widget" ref={widgetRef}>
    <button type="button" className={`guard-notification-trigger${unreadCount ? " has-unread" : ""}`} aria-label={`Open notifications${unreadCount ? `, ${unreadCount} unread` : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Bell size={18} />
      <span className="guard-notification-label">Notifications</span>
      {unreadCount > 0 && <b className="guard-notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</b>}
    </button>
    {open && <div className="guard-notification-menu" role="dialog" aria-label="Recent notifications">
      <div className="guard-notification-menu-header"><div><strong>Notifications</strong><span>{unreadCount ? `${unreadCount} unread update${unreadCount === 1 ? "" : "s"}` : "All caught up"}</span></div><button type="button" className="icon-button" aria-label="Close notifications" onClick={() => setOpen(false)}><X size={16} /></button></div>
      <div className="guard-notification-list">
        {loading ? <RotaLoader compact label="Checking updates…" /> : items.length === 0 ? <div className="guard-notification-empty"><Bell size={22} /><span>No notifications yet.</span></div> : items.map((item) => <div className={`guard-notification-item${item.is_read ? "" : " unread"}`} key={item.id}>
          <span className={`guard-notification-kind ${(item.notification_type || "info").toLowerCase()}`} aria-hidden="true"><Bell size={14} /></span>
          <div><span className="guard-alert-category">{guardNotificationCategories.find((category) => category.key === item.category)?.label || "Your update"}{item.priority === "URGENT" && <b>Urgent</b>}</span><strong>{item.title}</strong><p>{item.message}</p><small>{new Date(item.created_at).toLocaleString()}</small>{guardNotificationAction(item) && <button type="button" className="guard-alert-action" onClick={() => { const action = guardNotificationAction(item); setOpen(false); onNavigate?.(action.page, action.context); }}>View / Complete</button>}</div>
          {!item.is_read && <button type="button" className="guard-notification-mark" onClick={(event) => markRead(item.id, event)}>Mark read</button>}
        </div>)}
      </div>
      <button type="button" className="guard-notification-all" onClick={() => { setOpen(false); window.dispatchEvent(new Event("rota:notifications-open")); }}>View all notifications <ChevronRight size={15} /></button>
    </div>}
  </div>;
}

async function downloadFile(path, filename, options = {}) {
  const token = getToken();
  const headers = { ...(token ? { Authorization: `Token ${token}` } : {}), ...options.headers };
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401 && readAdminSession() && token === getToken()) endAdminSession("Your admin session has ended. Please sign in again.");
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Export failed. Please try again.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function absoluteFileUrl(value) {
  if (!value) return "";
  return value.startsWith("http") ? value : `${API_BASE.replace(/\/api$/, "")}${value}`;
}

async function openProtectedFile(value, label = "File") {
  const target = window.open("", "_blank");
  if (!target) throw new Error("Please allow pop-ups to view this file.");
  try {
    const token = getToken();
    const response = await fetch(absoluteFileUrl(value), { headers: token ? { Authorization: `Token ${token}` } : {} });
    if (!response.ok) throw new Error(`${label} could not be opened.`);
    const blobUrl = URL.createObjectURL(await response.blob());
    target.location.href = blobUrl;
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (error) {
    target.close();
    throw error;
  }
}

function useProtectedBlobUrl(value) {
  const [blobUrl, setBlobUrl] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (!value) { setBlobUrl(""); return () => {}; }
    const token = getToken();
    fetch(absoluteFileUrl(value), { headers: token ? { Authorization: `Token ${token}` } : {} })
      .then((response) => response.ok ? response.blob() : null)
      .then((blob) => {
        if (!blob || !active) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => { if (active) setBlobUrl(""); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [value]);
  return blobUrl;
}

function ProtectedImage({ src, alt, className }) {
  const blobUrl = useProtectedBlobUrl(src);
  return blobUrl ? <img src={blobUrl} alt={alt} className={className} /> : null;
}

function useProtectedPreviewUrl(value, enabled) {
  const [state, setState] = useState({ url: "", loading: false, error: "" });
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (!value || !enabled) { setState({ url: "", loading: false, error: "" }); return () => {}; }
    setState({ url: "", loading: true, error: "" });
    const token = getToken();
    fetch(absoluteFileUrl(value), { headers: token ? { Authorization: `Token ${token}` } : {} })
      .then(async (response) => { if (!response.ok) throw new Error(`File could not be loaded (${response.status}).`); return response.blob(); })
      .then((blob) => { if (!active) return; objectUrl = URL.createObjectURL(blob); setState({ url: objectUrl, loading: false, error: "" }); })
      .catch((error) => { if (active) setState({ url: "", loading: false, error: error.message || "File could not be loaded." }); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [value, enabled]);
  return state;
}

function ProtectedFilePreview({ value, label = "File", buttonLabel = "View" }) {
  const [open, setOpen] = useState(false);
  const preview = useProtectedPreviewUrl(value, open);
  if (!value) return null;
  return <><button type="button" className="file-link-button" onClick={() => setOpen(true)}><FileText size={13} /> {buttonLabel}</button>{open && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><section className="modal-card protected-file-preview-modal"><div className="modal-header"><div><p className="eyebrow">SECURE FILE PREVIEW</p><h3>{label}</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div>{preview.loading && <div className="empty-state compact-empty"><RotaLoader label="Opening secure file…" compact /></div>}{preview.error && <div className="empty-state compact-empty"><strong>File could not be loaded</strong><span>{preview.error}</span></div>}{preview.url && <iframe className="protected-file-preview-frame" title={`${label} preview`} src={preview.url} />}{preview.url && <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => openProtectedFile(value, label).catch(() => {})}>Open in new tab</button><button type="button" className="primary-button" onClick={() => setOpen(false)}>Close</button></div>}</section></div>}</>;
}

const navItems = [
  { id: "security", label: "Security", icon: ShieldCheck, adminOnly: true },
  { id: "security-screening", label: "Security Screening", icon: ShieldCheck, adminOnly: true, operatorHidden: true },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "employees", label: "Employees", icon: Users, operatorHidden: true },
  { id: "control-team", label: "Control Team", icon: Clock3, adminOnly: true },
  { id: "clients", label: "Clients", icon: BriefcaseBusiness, adminOnly: true, operatorHidden: true },
  { id: "sites", label: "Sites", icon: Building2, operatorHidden: true },
  { id: "rota", label: "Weekly Rota", icon: CalendarDays, operatorHidden: true },
  { id: "whatsapp-announcements", label: "Staff Announcements", icon: Megaphone, adminOnly: true, groupHeading: "WhatsApp", whatsapp: true },
  { id: "whatsapp-rota", label: "Rota Sharing", icon: MessageCircle, adminOnly: true, whatsapp: true },
  { id: "guard-availability", label: "Guard Availability", icon: CalendarDays, adminOnly: true },
  { id: "guard-induction", label: "Guard induction", icon: ClipboardList, operatorHidden: true },
  { id: "coverage-staffing", label: "Coverage & Staffing", icon: Users, operatorHidden: true },
  { id: "rota-confirmation", label: "Rota confirmation", icon: CheckCircle2, operatorHidden: true },
  { id: "leave", label: "Leave", icon: CalendarDays, operatorHidden: true },
  { id: "documents", label: "Documents", icon: FileText, operatorHidden: true },
  { id: "compliance-approvals", label: "Compliance approvals", icon: ShieldCheck, adminOnly: true, operatorHidden: true },
  { id: "compliance", label: "Compliance registration", icon: ShieldCheck, employeeOnly: true, complianceOnly: true },
  { id: "timesheets", label: "Timesheets", icon: Clock3, operatorHidden: true },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "arrival-report", label: "Reached at site", icon: CheckCircle2, operatorHidden: true },
  { id: "operations", label: "Operations", icon: ClipboardList },
  { id: "attendance-review", label: "Shift attendance", icon: CheckCircle2 },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "audit", label: "Activity log", icon: History, superAdminOnly: true },
  { id: "users", label: "User management", icon: UserPlus, superAdminOnly: true },
  { id: "profile", label: "My profile", icon: Users, employeeOnly: true },
  { id: "attendance", label: "My attendance", icon: CheckCircle2, employeeOnly: true },
];

const positionOptions = ["Security Guard", "CCTV Operator", "Dog Handler", "Site Supervisor", "Other"];
const COMPLIANCE_REGISTRATION_URL = "https://downloadapp.compliant101.co.uk/";
const CUSTOM_ROLE_STORAGE_KEY = "rota_custom_employee_roles";

function readCustomEmployeeRoles() {
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_ROLE_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((role) => typeof role === "string" && role.trim()) : [];
  } catch {
    return [];
  }
}

function employeeRoles(item) {
  const values = Array.isArray(item?.roles) && item.roles.length ? item.roles : String(item?.position || "").replace(/·/g, "+").replace(/,/g, "+").split("+");
  return values.map((value) => value.trim()).filter(Boolean).map((value) => value === "CCTV" ? "CCTV Operator" : value).filter((value, index, list) => list.indexOf(value) === index);
}

function formatEmployeeRoles(item) {
  return employeeRoles(item).join(" · ") || "—";
}

function RoleMultiSelect({ value = [], onChange, customRoles = [], onAddCustomRole, onEditCustomRole, onDeleteCustomRole }) {
  const [adding, setAdding] = useState(false);
  const [editingRole, setEditingRole] = useState("");
  const [draft, setDraft] = useState("");
  const availableRoles = [...positionOptions, ...customRoles, ...value.filter((role) => !positionOptions.includes(role) && !customRoles.includes(role))].filter((role, index, list) => list.indexOf(role) === index);
  const submitRole = (event) => {
    event.preventDefault();
    const role = draft.trim().replace(/\s+/g, " ");
    if (!role || (availableRoles.includes(role) && role !== editingRole)) return;
    if (editingRole) {
      onEditCustomRole?.(editingRole, role);
      if (value.includes(editingRole)) onChange(value.map((item) => item === editingRole ? role : item));
    } else {
      onAddCustomRole?.(role);
      if (!value.includes(role)) onChange([...value, role]);
    }
    setDraft("");
    setEditingRole("");
    setAdding(false);
  };
  const startAddRole = () => { setEditingRole(""); setDraft(""); setAdding(true); };
  const startEditRole = (event, role) => { event.preventDefault(); event.stopPropagation(); setEditingRole(role); setDraft(role); setAdding(true); };
  const deleteRole = (event, role) => { event.preventDefault(); event.stopPropagation(); onDeleteCustomRole?.(role); if (value.includes(role)) onChange(value.filter((item) => item !== role)); };
  return <div className="full-width role-picker"><div className="role-picker-heading"><div><span className="form-label">Positions / roles</span><small>Select all roles this employee can perform.</small></div><span className="role-count">{value.length} selected</span></div><div className="role-options">{availableRoles.map((role, index) => { const custom = customRoles.includes(role); return <label className={`role-option${value.includes(role) ? " selected" : ""}`} key={role}><input type="checkbox" checked={value.includes(role)} onChange={() => onChange(value.includes(role) ? value.filter((item) => item !== role) : [...value, role])} /><span className="role-option-index">{index + 1}</span><span className="role-option-copy"><strong>{role}</strong>{value[0] === role && <small>Primary role</small>}</span>{custom && <span className="role-option-actions"><button type="button" aria-label={`Edit ${role}`} title="Edit role" onClick={(event) => startEditRole(event, role)}><Pencil size={12} /></button><button type="button" aria-label={`Delete ${role}`} title="Delete role" onClick={(event) => deleteRole(event, role)}><Trash2 size={12} /></button></span>}</label>; })}</div><div className="role-custom-row">{adding ? <div className="role-custom-form" onKeyDown={(event) => event.key === "Enter" && submitRole(event)}><input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="e.g. First Aid Officer" aria-label="Custom role name" /><button type="button" onClick={submitRole}>{editingRole ? "Save role" : "Add role"}</button><button type="button" className="secondary-button" onClick={() => { setAdding(false); setEditingRole(""); setDraft(""); }}>Cancel</button></div> : <button type="button" className="role-add-custom" onClick={startAddRole}>+ Add custom role</button>}</div>{value.length > 0 ? <div className="selected-role-summary"><span>Selected:</span>{value.map((role) => <b key={role}>{role}</b>)}</div> : <p className="role-empty-hint">Choose at least one role to continue.</p>}<small className="form-help">The first selected role becomes the primary position used in rota and reports.</small></div>;
}

function Login({ onLogin, guardMode = false, clientMode = false, controlMode = false }) {
  const showDemo = import.meta.env.DEV && !guardMode && !clientMode && !controlMode;
  const [username, setUsername] = useState(showDemo ? "admin@rota.local" : "");
  const [password, setPassword] = useState(showDemo ? "Admin123!" : "");
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState(false);
  const [challenge, setChallenge] = useState(null);
  const [busy, setBusy] = useState(false);
  const completeLogin = (data) => { storeLogin(data); onLogin(data.user); };
  const submit = async (event) => {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      const data = await api(controlMode ? "/control/login/" : clientMode ? "/auth/client-login/" : guardMode ? "/auth/guard-login/" : "/auth/login/", { method: "POST", body: JSON.stringify({ username, password }) });
      if (data.challenge) { setPassword(""); setChallenge(data); return; }
      const role = data.user?.role || data.user?.role_display;
      if (controlMode && role !== "CONTROL_TEAM") throw new Error("Only Control Team accounts can sign in here.");
      if (guardMode && role !== "EMPLOYEE") throw new Error("Only guard accounts can sign in to the guard portal.");
      if (clientMode && role !== "CLIENT_ADMIN") throw new Error("Only Client Admin accounts can sign in here.");
      completeLogin(data);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (challenge) return <AdminMFA challenge={challenge} api={api} onComplete={completeLogin} onBack={() => { setChallenge(null); setError(""); }} />;
  if (forgot) return <ForgotPasswordPage guardMode={guardMode} clientMode={clientMode} controlMode={controlMode} onBack={() => setForgot(false)} />;
  return <main className="login-shell"><section className="login-card"><div className="brand-mark"><ShieldCheck size={22} /></div><p className="eyebrow">{controlMode ? "ROTAOPS CONTROL TEAM" : clientMode ? "ROTA CLIENT PORTAL" : guardMode ? "ROTA GUARD PORTAL" : "ROTA OPERATIONS"}</p><h1>{controlMode ? "Control Team sign in" : clientMode ? "Client Admin sign in" : guardMode ? "Guard sign in" : "Welcome back"}</h1><p className="muted">{controlMode ? "Check in or out, track your hours and manage leave requests." : clientMode ? "View your sites, published rota, attendance and reports." : guardMode ? "Access your rota, attendance and profile securely." : "Sign in to manage staffing, sites and weekly rotas."}</p><form onSubmit={submit}><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <p className="error">{error}</p>}<button className="primary-button" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button><button type="button" className="text-button" onClick={() => setForgot(true)}>Forgot password?</button></form>{controlMode ? <p className="login-hint">Use the email address provided by your office.</p> : clientMode ? <p className="login-hint">Use the Client Admin account supplied by ROTA.</p> : guardMode ? <p className="login-hint">Use the email address provided by your office.</p> : showDemo ? <p className="login-hint">Demo: admin@rota.local / Admin123!</p> : <p className="login-hint">Use the admin account supplied by your organisation.</p>}</section></main>;
}

function ForgotPasswordPage({ guardMode, clientMode, controlMode, onBack }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [phase, setPhase] = useState("request");
  const [resendIn, setResendIn] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const requestCode = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try { const result = await api("/auth/password-reset/", { method: "POST", body: JSON.stringify({ email }) }); setNotice(result.message); setPhase("verify"); setResendIn(60); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  useEffect(() => { if (!resendIn) return undefined; const timer = window.setInterval(() => setResendIn((value) => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer); }, [resendIn]);
  const verifyCode = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try { const result = await api("/auth/password-reset-verify/", { method: "POST", body: JSON.stringify({ email, code }) }); setResetToken(result.reset_token); setPhase("password"); setNotice(result.message); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const resetPassword = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    const form = new FormData(event.currentTarget);
    try { const result = await api("/auth/password-reset-confirm/", { method: "POST", body: JSON.stringify({ reset_token: resetToken, password: form.get("password"), password_confirmation: form.get("password_confirmation") }) }); setNotice(result.message); window.setTimeout(() => { window.location.href = controlMode ? "/control" : guardMode ? "/guard" : clientMode ? "/client" : "/"; }, 1200); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  return <main className="login-shell"><section className="login-card"><div className="brand-mark"><ShieldCheck size={22} /></div><p className="eyebrow">ROTA SECURITY</p><h1>{phase === "request" ? "Reset password" : phase === "verify" ? "Enter verification code" : "Choose new password"}</h1><p className="muted">{phase === "request" ? "Enter the email address linked to your portal account. We will send a 6-digit verification code." : phase === "verify" ? `Enter the 6-digit code sent to ${email}. It expires in 10 minutes.` : "Create a new password with at least 8 characters."}</p>{phase === "request" && <form onSubmit={requestCode}><label>Email address<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>{error && <p className="error">{error}</p>}{notice && <p className="success">{notice}</p>}<button className="primary-button" type="submit" disabled={saving}>{saving ? "Sending..." : "Send verification code"}</button><button type="button" className="text-button" onClick={onBack}>Back to sign in</button></form>}{phase === "verify" && <form onSubmit={verifyCode}><label>6-digit verification code<input required inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" autoFocus /></label>{error && <p className="error">{error}</p>}{notice && <p className="success">{notice}</p>}<button className="primary-button" type="submit" disabled={saving || code.length !== 6}>{saving ? "Verifying..." : "Verify code"}</button><button type="button" className="text-button" disabled={saving || resendIn > 0} onClick={requestCode}>{resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}</button><button type="button" className="text-button" onClick={() => { setPhase("request"); setCode(""); setError(""); setNotice(""); setResendIn(0); }}>Use a different email</button></form>}{phase === "password" && <form onSubmit={resetPassword}><label>New password<input required minLength="8" name="password" type="password" placeholder="At least 8 characters" autoFocus /></label><label>Confirm new password<input required minLength="8" name="password_confirmation" type="password" placeholder="Repeat your password" /></label>{error && <p className="error">{error}</p>}{notice && <p className="success">{notice}</p>}<button className="primary-button" type="submit" disabled={saving}>{saving ? "Updating..." : "Reset password"}</button></form>}<p className="login-hint">The verification code can be used once and expires after 10 minutes.</p></section></main>;
}

function ActivationPage({ token, onActivated }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [identity, setIdentity] = useState(null);
  const [loadingIdentity, setLoadingIdentity] = useState(true);
  const [identityError, setIdentityError] = useState("");
  const [identityAttempt, setIdentityAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setIdentity(null); setIdentityError(""); setLoadingIdentity(true);
    api("/auth/activation-details/", { method: "POST", body: JSON.stringify({ token }), silentLoading: true, silentToast: true, silentError: true, skipInvalidation: true })
      .then((details) => { if (active) setIdentity(details); })
      .catch((err) => { if (active) setIdentityError(err.message); })
      .finally(() => { if (active) setLoadingIdentity(false); });
    return () => { active = false; };
  }, [token, identityAttempt]);
  const submit = async (event) => {
    event.preventDefault();
    if (!identity || loadingIdentity) return;
    setSaving(true); setError("");
    try {
      const data = await api("/auth/activate/", { method: "POST", body: JSON.stringify({ token, password, password_confirmation: confirmation }) });
      storeLogin(data);
      window.history.replaceState({}, document.title, window.location.pathname);
      onActivated(data.user);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  return <main className="login-shell"><section className="login-card"><div className="brand-mark"><ShieldCheck size={22} /></div><p className="eyebrow">EMPLOYEE PORTAL</p><h1>Set your password</h1><p className="muted">Create a private password to activate your guard portal. This invite can be used once.</p>
    <form onSubmit={submit}>
      {loadingIdentity ? <p className="muted" role="status">Loading your account details…</p> : identity && <div className="activation-identity"><label>Full name<input type="text" value={identity.name} readOnly aria-readonly="true" autoComplete="off" /></label><label>Email (login username)<input type="email" value={identity.email} readOnly aria-readonly="true" autoComplete="off" /></label><small>These details were added by your office. Contact the office if a correction is needed.</small></div>}
      {identityError && <div className="error" role="alert"><p>{identityError}</p><button type="button" className="text-button" onClick={() => setIdentityAttempt((attempt) => attempt + 1)}>Try again</button></div>}
      <label>New password<input required minLength="8" type="password" autoComplete="new-password" disabled={!identity || saving} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" /></label><label>Confirm password<input required minLength="8" type="password" autoComplete="new-password" disabled={!identity || saving} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={saving || loadingIdentity || !identity}>{saving ? "Activating..." : "Activate portal"}</button>
    </form><p className="login-hint">After activation, use your email address as username.</p></section></main>;
}

function StatCard({ label, value, detail, icon: Icon, tone }) { return <article className={`stat-card ${tone}`}><div className="stat-icon"><Icon size={19} /></div><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>; }

function Dashboard({ stats, onCreateRota }) {
  const hasTodayAssignments = stats.todays_shifts > 0;
  return <><div className="page-heading"><div><p className="eyebrow">OVERVIEW</p><h2>Good morning, Admin</h2><p className="muted">Here’s what needs attention across today’s operations.</p></div><button className="primary-button" onClick={onCreateRota}>Create weekly rota</button></div><DashboardClock serverTime={stats.server_time} timeZone={stats.time_zone} /><section className="stats-grid"><StatCard label="Active employees" value={stats.active_employees} detail="Ready for assignment" icon={Users} tone="blue" /><StatCard label="Active sites" value={stats.active_sites} detail="Across your operation" icon={Building2} tone="teal" /><StatCard label="On leave" value={stats.employees_on_leave} detail="Current leave records" icon={CalendarDays} tone="amber" /><StatCard label="Unfilled shifts" value={stats.unfilled_shifts} detail="Required staff gaps today" icon={ClipboardList} tone="rose" /></section><section className="content-grid"><article className="panel"><div className="panel-header"><div><h3>Today’s operations</h3><p className="muted">Daily staffing readiness across active sites.</p></div><span className={`status-pill ${hasTodayAssignments ? "active" : "neutral"}`}>{hasTodayAssignments ? `${stats.todays_shifts} assigned` : "No assignments"}</span></div><div className="empty-state"><CalendarDays size={30} /><strong>{hasTodayAssignments ? `${stats.todays_shifts} rota assignments planned today` : "No assignments scheduled yet"}</strong><span>{stats.unfilled_shifts ? `${stats.unfilled_shifts} required staff positions still need coverage.` : "All required positions are covered."}</span></div></article><article className="panel"><div className="panel-header"><div><h3>Attention needed</h3><p className="muted">Key operational alerts</p></div></div><div className="alert-row"><span className="alert-dot amber" /><div><strong>Documents expiring soon</strong><p>{stats.documents_expiring_soon} records need review</p></div></div><div className="alert-row"><span className="alert-dot rose" /><div><strong>Unfilled shifts</strong><p>{stats.unfilled_shifts} required positions need an assignment</p></div></div></article></section></>;
}

function toMonday(value) {
  const weekday = new Date(`${value}T12:00:00Z`).getUTCDay();
  return addDays(value, -((weekday + 6) % 7));
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function formatDay(value, options = {}) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(new Date(`${value}T12:00:00Z`));
}

function Rota({ target = {}, canShareWhatsApp = false }) {
  const [weekStart, setWeekStart] = useState(toMonday(target.event_date || new Date().toISOString().slice(0, 10)));
  const availability = useGuardAvailability(api, weekStart);
  const [rota, setRota] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [shiftTypes, setShiftTypes] = useState([]);
  const [shiftLoadError, setShiftLoadError] = useState("");
  const [selectedDate, setSelectedDate] = useState(weekStart);
  const [form, setForm] = useState({ shift_type: "", site: "", employee: "", scheduled_start: "", scheduled_end: "", notes: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [siteRosterSearch, setSiteRosterSearch] = useState("");
  const [siteView, setSiteView] = useState("all");
  const [batch, setBatch] = useState(null);
  const [publishReview, setPublishReview] = useState(null);
  const [selectedRosterSite, setSelectedRosterSite] = useState(target.site_id ? String(target.site_id) : "");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [siteRequirements, setSiteRequirements] = useState([]);
  const [allSiteRequirements, setAllSiteRequirements] = useState([]);
  const [requirementsReady, setRequirementsReady] = useState(false);
  const [requirementDraft, setRequirementDraft] = useState({});
  const [siteInductions, setSiteInductions] = useState([]);
  const [inductionForm, setInductionForm] = useState({ employee: "", induction_date: selectedDate, status: "PLANNED", notes: "" });
  const [editingAssignment, setEditingAssignment] = useState(null);
  const [editForm, setEditForm] = useState({ work_date: selectedDate, shift_type: "", site: "", employee: "", scheduled_start: "", scheduled_end: "", notes: "" });
  const [draggedAssignment, setDraggedAssignment] = useState(null);
  const [copiedAssignment, setCopiedAssignment] = useState(null);
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

  const loadWeek = async () => {
    setLoading(true);
    setError("");
    try {
      const weeks = await api(`/rota-weeks/?week_start=${weekStart}`);
      const currentWeek = weeks[0] || await api("/rota-weeks/", { method: "POST", body: JSON.stringify({ week_start: weekStart }) });
      const summary = await api(`/rota-weeks/${currentWeek.id}/summary/`);
      setRota(summary.rota_week);
      setAssignments(summary.assignments);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };


  useEffect(() => {
    api("/employees/?status=ACTIVE").then(setEmployees).catch(() => {});
    api("/sites/").then(setSites).catch(() => {});
    api("/site-requirements/").then((items) => { setAllSiteRequirements(items); setRequirementsReady(true); }).catch((err) => setError(`Staffing requirements could not be loaded: ${err.message}`));
    api("/shift-types/").then((items) => {
      setShiftTypes(items.filter((shift) => shift.is_active !== false));
      setShiftLoadError("");
    }).catch((err) => {
      setShiftTypes([]);
      setShiftLoadError(err.message || "Shift types could not be loaded.");
    });
  }, []);
  useEffect(() => {
    if (!selectedRosterSite) return;
    let active = true;
    setSiteInductions([]);
    setSiteRequirements([]);
    setRequirementDraft({});
    Promise.all([api(`/site-requirements/?site=${selectedRosterSite}`), api(`/site-inductions/?site=${selectedRosterSite}`)]).then(([requirements, inductions]) => {
      if (!active) return;
      setSiteRequirements(requirements);
      setAllSiteRequirements((current) => [...current.filter((item) => String(item.site) !== String(selectedRosterSite)), ...requirements]);
      setRequirementDraft(Object.fromEntries(requirements.map((item) => [`${item.weekday}-${item.shift_type}`, item.required_guards])));
      setSiteInductions(inductions);
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [selectedRosterSite]);

  useEffect(() => { setSelectedDate(weekStart); setBulkOpen(false); loadWeek(); }, [weekStart]);

  const updateForm = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const selectRosterSite = (siteId) => {
    setSelectedRosterSite(String(siteId));
    setForm((current) => ({ ...current, site: String(siteId), employee: "" }));
  };
  const copyAssignment = (assignment) => {
    setCopiedAssignment(assignment);
    setNotice(`${assignment.employee_name || "Unfilled shift"} copied. Select a date and paste it into Add assignment.`);
  };
  const pasteAssignment = () => {
    if (!copiedAssignment) return;
    setForm((current) => ({
      ...current,
      site: selectedRoster?.site.id ? String(selectedRoster.site.id) : current.site,
      shift_type: String(copiedAssignment.shift_type),
      employee: copiedAssignment.employee ? String(copiedAssignment.employee) : "",
      scheduled_start: copiedAssignment.scheduled_start?.slice(0, 5) || shiftById(copiedAssignment.shift_type)?.start_time?.slice(0, 5) || "",
      scheduled_end: copiedAssignment.scheduled_end?.slice(0, 5) || shiftById(copiedAssignment.shift_type)?.end_time?.slice(0, 5) || "",
      notes: copiedAssignment.notes || "",
    }));
    setNotice(`Assignment pasted for ${formatDay(selectedDate, { weekday: "long", day: "numeric", month: "short" })}. Click Add assignment to save it.`);
  };
  const shiftById = (value) => shiftTypes.find((shift) => String(shift.id) === String(value));
  const markedDays = unavailableDays(availability.data);
  const blockedDate = (assignment) => {
    const shift = shiftById(assignment.shift_type);
    return unavailableShiftDate(markedDays, assignment.employee, assignment.work_date,
      assignment.scheduled_start || shift?.start_time, assignment.scheduled_end || shift?.end_time);
  };
  const guardOptionLabel = (employee, selection) => {
    const unavailable = blockedDate({ ...selection, employee: employee.id });
    return `${employee.name} · ${employee.employee_id}${unavailable ? " — Unavailable" : ""}`;
  };
  const conflictMessage = (assignment, name) => {
    const date = blockedDate(assignment);
    return date ? guardUnavailableMessage(name, date) : "";
  };
  const addSelection = { ...form, work_date: selectedDate };
  const addConflict = conflictMessage(addSelection, employees.find((employee) => String(employee.id) === form.employee)?.name || "This guard");
  const editConflict = conflictMessage(editForm, employees.find((employee) => String(employee.id) === editForm.employee)?.name || editingAssignment?.employee_name || "This guard");
  const availabilityConflicts = [...new Set(assignments.map((item) => conflictMessage(item, item.employee_name)).filter(Boolean))];
  const setShiftOnForm = (setter, formValue, value) => {
    const shift = shiftById(value);
    setter({ ...formValue, shift_type: value, scheduled_start: shift?.start_time?.slice(0, 5) || "", scheduled_end: shift?.end_time?.slice(0, 5) || "" });
  };
  const addAssignment = async (event) => {
    event.preventDefault();
    if (!rota || addConflict) return;
    setSaving(true);
    setError("");
    try {
      const selectedSiteId = form.site || selectedRoster?.site.id;
      if (!selectedSiteId) throw new Error("Select a site above before adding an assignment.");
      await api("/assignments/", { method: "POST", body: JSON.stringify({ rota_week: rota.id, work_date: selectedDate, shift_type: Number(form.shift_type), site: Number(selectedSiteId), employee: form.employee ? Number(form.employee) : null, scheduled_start: form.scheduled_start || null, scheduled_end: form.scheduled_end || null, notes: form.notes }) });
      setForm((current) => ({ ...current, employee: "", scheduled_start: "", scheduled_end: "", notes: "" }));
      await loadWeek();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const openAssignmentEditor = (assignment) => {
    const shift = shiftById(assignment.shift_type);
    setEditingAssignment(assignment);
    setEditForm({ work_date: assignment.work_date, shift_type: String(assignment.shift_type), site: String(assignment.site), employee: assignment.employee ? String(assignment.employee) : "", scheduled_start: assignment.scheduled_start?.slice(0, 5) || shift?.start_time?.slice(0, 5) || "", scheduled_end: assignment.scheduled_end?.slice(0, 5) || shift?.end_time?.slice(0, 5) || "", notes: assignment.notes || "" });
  };
  const saveAssignmentEdit = async (event) => {
    event.preventDefault();
    if (!editingAssignment || editConflict) return;
    setSaving(true); setError("");
    try {
      await api(`/assignments/${editingAssignment.id}/`, { method: "PATCH", body: JSON.stringify({ work_date: editForm.work_date, shift_type: Number(editForm.shift_type), site: Number(editForm.site), employee: editForm.employee ? Number(editForm.employee) : null, scheduled_start: editForm.scheduled_start || null, scheduled_end: editForm.scheduled_end || null, notes: editForm.notes }) });
      setEditingAssignment(null); await loadWeek();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const moveAssignment = async (assignmentId, workDate) => {
    if (!assignmentId || rota?.status === "PUBLISHED") return;
    const assignment = assignments.find((item) => item.id === assignmentId);
    if (!assignment || assignment.work_date === workDate) return;
    setSaving(true); setError("");
    try { await api(`/assignments/${assignmentId}/`, { method: "PATCH", body: JSON.stringify({ work_date: workDate }) }); await loadWeek(); }
    catch (err) { setError(err.message); } finally { setSaving(false); setDraggedAssignment(null); }
  };
  const moveAssignmentToSite = async (assignmentId, targetSiteId) => {
    if (!assignmentId || rota?.status === "PUBLISHED") return;
    const assignment = assignments.find((item) => item.id === assignmentId);
    const targetSite = sites.find((site) => site.id === Number(targetSiteId));
    const sourceSite = sites.find((site) => site.id === assignment?.site);
    if (!assignment || !targetSite || assignment.site === Number(targetSiteId)) return;
    const shift = shiftById(assignment.shift_type);
    const startMinutes = (assignment.scheduled_start || shift?.start_time || "00:00").split(":").map(Number).reduce((hours, value, index) => hours + (index === 0 ? value * 60 : value), 0);
    const endMinutesRaw = (assignment.scheduled_end || shift?.end_time || "00:00").split(":").map(Number).reduce((hours, value, index) => hours + (index === 0 ? value * 60 : value), 0);
    const endMinutes = endMinutesRaw <= startMinutes ? endMinutesRaw + 1440 : endMinutesRaw;
    const overlaps = (other) => {
      if (other.id === assignment.id || other.employee !== assignment.employee || other.work_date !== assignment.work_date) return false;
      const otherShift = shiftById(other.shift_type);
      const otherStart = (other.scheduled_start || otherShift?.start_time || "00:00").split(":").map(Number).reduce((hours, value, index) => hours + (index === 0 ? value * 60 : value), 0);
      const otherEndRaw = (other.scheduled_end || otherShift?.end_time || "00:00").split(":").map(Number).reduce((hours, value, index) => hours + (index === 0 ? value * 60 : value), 0);
      const otherEnd = otherEndRaw <= otherStart ? otherEndRaw + 1440 : otherEndRaw;
      return startMinutes < otherEnd && otherStart < endMinutes;
    };
    const conflicts = assignment.employee ? assignments.filter(overlaps) : [];
    let replaceConflicts = false;
    if (conflicts.length) {
      const conflictSites = conflicts.map((item) => `${item.site_name} (${item.shift_name})`).join(", ");
      replaceConflicts = confirm(`${assignment.employee_name} is already assigned on ${assignment.work_date} at ${conflictSites}.\n\nMove this shift from ${sourceSite?.name || assignment.site_name} to ${targetSite.name}?\n\nAccept will remove the other site assignment and add this guard to ${targetSite.name}.`);
      if (!replaceConflicts) { setDraggedAssignment(null); return; }
    }
    setSaving(true); setError("");
    try {
      await api(`/assignments/${assignment.id}/move_to_site/`, { method: "POST", body: JSON.stringify({ site: Number(targetSiteId), replace_conflicts: replaceConflicts }) });
      setSelectedRosterSite(String(targetSiteId));
      await loadWeek();
      setNotice(`${assignment.employee_name || "Guard"} moved to ${targetSite.name}.`);
    } catch (err) { setError(err.message); } finally { setSaving(false); setDraggedAssignment(null); }
  };
  const saveRequirements = async () => {
    if (!selectedRoster) return;
    setSaving(true); setError("");
    try {
      await Promise.all(days.flatMap((_, weekday) => shiftTypes.map(async (shift) => {
        const key = `${weekday}-${shift.id}`;
        const value = Math.max(0, Number(requirementDraft[key] ?? selectedRoster.site.required_guards));
        const existing = siteRequirements.find((item) => item.weekday === weekday && item.shift_type === shift.id);
        if (existing) return api(`/site-requirements/${existing.id}/`, { method: "PATCH", body: JSON.stringify({ required_guards: value }) });
        return api("/site-requirements/", { method: "POST", body: JSON.stringify({ site: selectedRoster.site.id, shift_type: shift.id, weekday, required_guards: value }) });
      })));
      const refreshed = await api(`/site-requirements/?site=${selectedRoster.site.id}`); setSiteRequirements(refreshed); setAllSiteRequirements((current) => [...current.filter((item) => String(item.site) !== String(selectedRoster.site.id)), ...refreshed]); setRequirementDraft(Object.fromEntries(refreshed.map((item) => [`${item.weekday}-${item.shift_type}`, item.required_guards]))); setNotice(`${selectedRoster.site.name} staffing requirements saved.`);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const saveInduction = async (event) => {
    event.preventDefault();
    if (!selectedRoster) return;
    setSaving(true); setError("");
    try { await api("/site-inductions/", { method: "POST", body: JSON.stringify({ site: selectedRoster.site.id, ...inductionForm, employee: Number(inductionForm.employee) }) }); setSiteInductions(await api(`/site-inductions/?site=${selectedRoster.site.id}`)); setInductionForm({ employee: "", induction_date: selectedDate, status: "PLANNED", notes: "" }); setNotice("Guard induction added to this site."); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const reviewPublish = async () => {
    if (!staffingReady || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const [review, ...coverageDays] = await Promise.all([
        api(`/rota-weeks/${rota.id}/publish/`, {
          method: "POST", body: JSON.stringify({ preview: true }), silentLoading: true, silentToast: true, skipInvalidation: true,
        }),
        ...days.map((day) => api(`/rota-weeks/${rota.id}/coverage/?date=${day}`, { silentLoading: true })),
      ]);
      const gaps = coverageDays.flatMap((coverageDay, index) => coverageDay.slots
        .filter((slot) => slot.unfilled > 0)
        .map((slot) => ({
          site: { id: slot.site, name: slot.site_name }, shift: { id: slot.shift_type, name: slot.shift_name },
          day: days[index], unfilled: slot.unfilled,
        })));
      setPublishReview({ gaps, conflicts: review.conflicts, error: "" });
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const publish = async () => {
    if (!publishReview || publishReview.conflicts.length || saving) return;
    setSaving(true);
    try {
      const result = await api(`/rota-weeks/${rota.id}/publish/`, { method: "POST", body: "{}", silentError: true, silentLoading: true, silentToast: true });
      setPublishReview(null);
      await loadWeek();
      setNotice(`Rota published. Confirmation requested from ${result.confirmation_count || 0} employees.`);
    } catch (err) {
      setPublishReview((current) => ({ ...current, error: err.message }));
    } finally { setSaving(false); }
  };
  const reopen = async () => {
    if (!rota) return;
    setSaving(true);
    setError("");
    setNotice("");
    try { await api(`/rota-weeks/${rota.id}/reopen/`, { method: "POST", body: "{}" }); await loadWeek(); setNotice("Rota reopened. You can add or edit assignments now."); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const copyWeek = () => setBatch({
    mode: "copy", initial: { week_start: addDays(weekStart, 7), scope: "all", site_ids: [] },
  });
  const openMultiDay = () => setBatch({
    mode: "days", initial: {
      site: String(selectedRoster?.site.id || ""), shift_type: form.shift_type, employee: form.employee,
      dates: [selectedDate], scheduled_start: form.scheduled_start, scheduled_end: form.scheduled_end,
    },
  });
  const openCover = (slot) => {
    const initial = {
      site: String(slot.site.id), shift_type: String(slot.shift.id), employee: "", dates: [slot.day],
      scheduled_start: slot.shift.start_time.slice(0, 5), scheduled_end: slot.shift.end_time.slice(0, 5),
    };
    if (rota.status === "PUBLISHED") {
      selectRosterSite(slot.site.id);
      setSelectedDate(slot.day);
      setForm((current) => ({ ...current, ...initial, notes: "" }));
      requestAnimationFrame(() => document.getElementById("rota-add-assignment")?.scrollIntoView({ block: "center" }));
      return;
    }
    setBatch({ mode: "cover", initial });
  };
  const batchSaved = async (result) => {
    const copied = batch.mode === "copy";
    setBatch(null);
    if (copied) setWeekStart(result.week_start);
    else await loadWeek();
    const skipped = result.skipped ? ` ${result.skipped} skipped. Check Needs cover for open positions.` : "";
    setNotice(`${result.created} ${result.created === 1 ? "assignment" : "assignments"} ${copied ? "copied" : "saved"}.${skipped}`);
  };
  const removeAssignment = async (id) => {
    if (!confirm("Remove this assignment?")) return;
    try { await api(`/assignments/${id}/`, { method: "DELETE" }); await loadWeek(); } catch (err) { setError(err.message); }
  };
  const bulkSaved = async (result) => {
    setBulkOpen(false);
    setNotice(`${result.created} ${result.created === 1 ? "guard" : "guards"} assigned successfully.`);
    await loadWeek();
  };
  const filteredAssignments = selectedRosterSite
    ? assignments.filter((assignment) => String(assignment.site) === selectedRosterSite)
    : assignments;
  const assignmentHours = (assignment) => {
    const shift = shiftById(assignment.shift_type);
    if (!shift) return 0;
    const start = (assignment.scheduled_start || shift.start_time).split(":").map(Number);
    const end = (assignment.scheduled_end || shift.end_time).split(":").map(Number);
    let minutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]);
    if (minutes <= 0) minutes += 24 * 60;
    return minutes / 60;
  };
  const staffingReady = requirementsReady && shiftTypes.length > 0 && !loading && rota?.week_start === weekStart;
  const rosterSiteRows = sites.map((site) => {
    const siteAssignments = assignments.filter((assignment) => assignment.site === site.id && assignment.employee);
    const weeklyHours = siteAssignments.reduce((total, assignment) => total + assignmentHours(assignment), 0);
    const slots = siteWeekSlots({ site, days, shifts: shiftTypes, requirements: allSiteRequirements, assignments: siteAssignments });
    return { site, assignments: siteAssignments, assigned: siteAssignments.length, slots, weeklyHours,
      unfilled: slots.reduce((total, slot) => total + slot.unfilled, 0) };
  });
  const activeRosterSites = rosterSiteRows.filter(({ site }) => site.is_active !== false);
  const gapSites = activeRosterSites.filter((row) => row.unfilled > 0).length;
  const weekGaps = rosterSiteRows.flatMap((row) => row.slots.filter((slot) => slot.unfilled > 0))
    .sort((left, right) => left.day.localeCompare(right.day) || left.site.name.localeCompare(right.site.name));
  const listedRosterSites = rosterSiteRows.filter(({ site, unfilled }) =>
    (siteView !== "ready" || (site.is_active !== false && unfilled === 0)) &&
    `${site.name} ${site.site_id}`.toLowerCase().includes(siteRosterSearch.trim().toLowerCase()),
  );
  const selectedRoster = rosterSiteRows.find((row) => String(row.site.id) === String(selectedRosterSite));
  const inductedEmployeeIds = new Set(siteInductions.filter((induction) => induction.status === "COMPLETED").map((induction) => induction.employee));
  const selectedSiteEmployees = employees.filter((employee) => inductedEmployeeIds.has(employee.id));
  const selectedRosterEmployees = selectedRoster ? selectedSiteEmployees.map((employee) => ({ id: employee.id, name: employee.name, assignments: selectedRoster.assignments.filter((assignment) => assignment.employee === employee.id) })) : [];
  const rosterCell = (employeeAssignments, day) => employeeAssignments.filter((assignment) => assignment.work_date === day).map((assignment) => { const shift = shiftTypes.find((item) => item.id === assignment.shift_type); return { assignment, shift }; }).filter((item) => item.shift);
  const requirementRows = selectedRoster ? days.flatMap((day, weekday) => shiftTypes.map((shift) => {
    const key = `${weekday}-${shift.id}`;
    const required = Number(requirementDraft[key] ?? selectedRoster.site.required_guards);
    const assigned = assignments.filter((assignment) => assignment.site === selectedRoster.site.id && assignment.work_date === day && assignment.shift_type === shift.id && assignment.employee).length;
    return { day, weekday, shift, key, required, assigned, complete: assigned >= required };
  })) : [];

  return <>
    <div className="page-heading"><div><p className="eyebrow">ROTA MANAGEMENT</p><h2>Weekly rota</h2><p className="muted">Plan staffing by day, shift and site. Conflict checks run automatically.</p></div><div className="rota-actions"><label className="week-picker">Week starting<input type="date" value={weekStart} onChange={(event) => setWeekStart(toMonday(event.target.value))} /></label><button className="secondary-button" onClick={() => downloadFile(`/exports/rota.csv?rota_week=${rota?.id || ""}`, "weekly-rota.csv")}><Download size={14} /> Export</button><button className="secondary-button" disabled={loading || rota?.week_start !== weekStart || !assignments.length || saving} onClick={copyWeek}><Copy size={14} /> Copy week</button>{rota?.status !== "PUBLISHED" && <button className="secondary-button" disabled={!staffingReady || saving} onClick={openMultiDay}><CalendarDays size={14} /> Assign multiple days</button>}{rota?.status !== "PUBLISHED" && <button className="secondary-button" disabled={loading || rota?.week_start !== weekStart || saving} onClick={() => setBulkOpen(true)}><Users size={14} /> Bulk assign</button>}{rota?.status === "PUBLISHED" && <button className="secondary-button" disabled={saving} onClick={reopen}>Reopen for editing</button>}<button className="primary-button" disabled={(!assignments.length && !rota?.whatsapp_previously_shared) || rota?.status === "PUBLISHED" || saving || !staffingReady} onClick={reviewPublish}>{rota?.status === "PUBLISHED" ? "Published" : "Review & publish"}</button></div></div>
    {error && <p className="error page-error">{error}</p>}{shiftLoadError && <p className="error page-error">Shift list could not be loaded: {shiftLoadError}</p>}{!shiftLoadError && !shiftTypes.length && !loading && <p className="error page-error">No active shifts are configured. Ask an Admin to run the latest deployment/migrations.</p>}{notice && <p className="success page-success">{notice}</p>}
    {availability.error && <p className="rota-availability-warning" role="status">Availability could not be loaded. The server checks availability when you save or publish.</p>}
    {availabilityConflicts.length > 0 && <div className="rota-availability-warning" role="status">
      <strong>Guard availability conflicts</strong>
      <ul>{availabilityConflicts.slice(0, 6).map((message) => <li key={message}>{message}</li>)}</ul>
      {availabilityConflicts.length > 6 && <p>See the rota cards for the remaining conflicts.</p>}
      <p>{rota?.status === "PUBLISHED" ? "Reopen the rota to reassign these shifts, or update Guard Availability." : "Reassign these shifts or update Guard Availability before publishing."}</p>
    </div>}
    <section className="panel site-roster-panel">
      <div className="panel-header"><h3>Sites</h3>
        {canShareWhatsApp && rota?.status === "PUBLISHED" && rota.week_start === weekStart &&
          <a className="secondary-button rota-share-link" href="#rota-sharing">Rota Sharing</a>}
      </div>
      <p className="rota-site-summary" role="status"><span><strong>{activeRosterSites.length}</strong> active sites</span>
        {staffingReady && <><span><strong>{activeRosterSites.length - gapSites}</strong> ready</span><span><strong>{gapSites}</strong> need cover</span></>}
      </p>
      <div className="rota-planning-filters" aria-label="Site views">
        {[["all", "All sites"], ["cover", "Needs cover"], ["ready", "Ready"]].map(([id, label]) =>
          <button type="button" className="secondary-button" key={id} aria-pressed={siteView === id} onClick={() => setSiteView(id)}>{label}</button>)}
      </div>
      {siteView === "cover" ? staffingReady
        ? <NeedsCover gaps={weekGaps} onSelect={openCover} published={rota.status === "PUBLISHED"} />
        : <p className="muted">{loading ? "Loading coverage…" : "Coverage is unavailable. Check staffing requirements and shift types."}</p>
        : <>
          <div className="site-roster-toolbar"><label className="search-box"><Search size={16} /><input aria-label="Search sites" value={siteRosterSearch} onChange={(event) => setSiteRosterSearch(event.target.value)} placeholder="Search site name or ID" /></label></div>
          <div className="site-name-buttons">{listedRosterSites.length ? listedRosterSites.map((row) => <button type="button" className={`site-name-button ${String(row.site.id) === String(selectedRoster?.site.id) ? "selected" : ""}`} key={row.site.id} onClick={() => selectRosterSite(row.site.id)} onDragOver={(event) => { if (rota?.status !== "PUBLISHED" && draggedAssignment) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); moveAssignmentToSite(draggedAssignment, row.site.id); }}><span><strong>{row.site.name}</strong><small>{row.site.site_id} · {row.assigned} assigned · {row.weeklyHours.toFixed(0)}h</small></span><span className={`status-pill ${!staffingReady || row.site.is_active === false ? "neutral" : row.unfilled ? "pending" : "active"}`}>{!staffingReady ? (error || shiftLoadError ? "Count unavailable" : "Loading requirements…") : row.site.is_active === false ? "Inactive" : row.unfilled ? `${row.unfilled} unfilled this week` : "Week covered"}</span></button>) : <div className="empty-state compact-empty">No sites match your search.</div>}</div>
        </>}
      {selectedRoster && <div className="site-roster-detail"><div className="site-roster-detail-header"><div><p className="eyebrow">SITE WEEKLY ROSTER</p><h3>{selectedRoster.site.name}</h3><span>{selectedRoster.site.site_id} · Week commencing {formatDay(weekStart, { day: "numeric", month: "short", year: "numeric" })}</span><small className="table-subtext">Completed-induction guards are added automatically.</small></div><div className="site-roster-metrics"><span><strong>{selectedRoster.assigned}</strong> assigned</span><span><strong>{selectedRoster.weeklyHours.toFixed(0)}h</strong> total</span><span><strong>{staffingReady ? selectedRoster.unfilled : "—"}</strong> unfilled this week</span></div></div><div className="table-wrap"><table className="site-roster-matrix"><thead><tr><th>Guard</th>{days.map((day) => <th key={day}>{formatDay(day, { weekday: "short" })}<small>{formatDay(day, { day: "numeric", month: "short" })}</small></th>)}<th>Total</th></tr></thead><tbody>{selectedRosterEmployees.length ? selectedRosterEmployees.map((employee) => { const totalHours = employee.assignments.reduce((total, assignment) => total + assignmentHours(assignment), 0); return <tr key={employee.id}><td><strong>{employee.name}</strong><small>{employees.find((item) => item.id === employee.id)?.employee_id || ""}</small></td>{days.map((day) => <td key={day}><div className="roster-day-cell">{rosterCell(employee.assignments, day).length ? rosterCell(employee.assignments, day).map(({ assignment, shift }) => <span className={`roster-shift-badge ${shift.name.toLowerCase().includes("night") ? "night" : "day"}`} key={assignment.id}>{shift.name.replace(" Shift", "")}<small>{(assignment.scheduled_start || shift.start_time).slice(0, 5)}–{(assignment.scheduled_end || shift.end_time).slice(0, 5)}</small></span>) : <span className="roster-off">—</span>}</div></td>)}<td><strong>{totalHours.toFixed(0)}h</strong></td></tr>; }) : <tr><td colSpan={9}><div className="empty-state compact-empty">No completed-induction guards for this site yet.</div></td></tr>}</tbody></table></div></div>}</section>
    {selectedRoster && <section className="site-rota-tools"><section className="panel"><div className="panel-header"><div><h3>{selectedRoster.site.name} · staffing requirements</h3><p className="muted">Set required guards for every day and shift. Completion is checked against assigned guards.</p></div><button className="primary-button" type="button" onClick={saveRequirements} disabled={saving}>Save requirements</button></div><div className="table-wrap"><table className="requirements-table"><thead><tr><th>Day</th><th>Shift</th><th>Required guards</th><th>Assigned</th><th>Status</th></tr></thead><tbody>{requirementRows.map((row) => <tr key={row.key}><td>{formatDay(row.day, { weekday: "long", day: "numeric", month: "short" })}</td><td><strong>{row.shift.name}</strong><small className="table-subtext">{row.shift.start_time.slice(0, 5)}–{row.shift.end_time.slice(0, 5)}</small></td><td><input className="requirement-input" type="number" min="0" value={requirementDraft[row.key] ?? selectedRoster.site.required_guards} onChange={(event) => setRequirementDraft((current) => ({ ...current, [row.key]: event.target.value }))} /></td><td>{row.assigned}/{row.required}</td><td><span className={`status-pill ${row.complete ? "active" : "pending"}`}>{row.complete ? "Complete" : "Incomplete"}</span></td></tr>)}</tbody></table></div></section></section>}
    <section className="panel rota-builder" id="rota-add-assignment"><div className="panel-header"><div><h3>Add assignment</h3><p className="muted">{rota?.status === "PUBLISHED" ? "Click the button to reopen this rota for editing." : selectedRoster ? `Adding to ${selectedRoster.site.name}. Only inducted guards are available.` : "Select a site above, then choose a guard and shift."}</p>{copiedAssignment && <small className="table-subtext">Copied: {copiedAssignment.employee_name || "Unfilled shift"} · {copiedAssignment.shift_name}</small>}</div><div className="panel-header-actions"><span className={`status-pill ${rota?.status === "PUBLISHED" ? "active" : "neutral"}`}>{rota?.status || "Loading"}</span>{copiedAssignment && <button type="button" className="secondary-button" onClick={pasteAssignment} disabled={rota?.status === "PUBLISHED" || saving}><Copy size={14} /> Paste assignment</button>}</div></div><form className="rota-form" onSubmit={addAssignment}><label>Date<select value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)}>{days.map((day) => <option value={day} key={day}>{formatDay(day, { weekday: "long", day: "numeric", month: "short" })}</option>)}</select></label><label>Shift<select required value={form.shift_type} onChange={(event) => setShiftOnForm(setForm, form, event.target.value)}><option value="">Select shift</option>{shiftTypes.map((shift) => <option value={shift.id} key={shift.id}>{shift.name} · {shift.start_time.slice(0, 5)}-{shift.end_time.slice(0, 5)}</option>)}</select></label><label>Guard<select value={form.employee} onChange={(event) => updateForm("employee", event.target.value)}><option value="">Unfilled shift</option>{selectedSiteEmployees.map((employee) => <option value={employee.id} key={employee.id}>{guardOptionLabel(employee, addSelection)}</option>)}</select></label><label>Start time<input type="time" value={form.scheduled_start} onChange={(event) => updateForm("scheduled_start", event.target.value)} /></label><label>End time<input type="time" value={form.scheduled_end} onChange={(event) => updateForm("scheduled_end", event.target.value)} /></label><button type={rota?.status === "PUBLISHED" ? "button" : "submit"} className="primary-button" onClick={rota?.status === "PUBLISHED" ? reopen : undefined} disabled={!rota || saving || Boolean(addConflict && rota.status !== "PUBLISHED")}>{rota?.status === "PUBLISHED" ? "Reopen to add assignment" : saving ? "Saving..." : "Add assignment"}</button>{addConflict && <p className="rota-availability-warning" role="alert">{addConflict}</p>}</form></section>
    <section className="rota-board">{days.map((day) => { const dayAssignments = filteredAssignments.filter((assignment) => assignment.work_date === day); return <article className="day-column" key={day} onDragOver={(event) => event.preventDefault()} onDrop={() => moveAssignment(draggedAssignment, day)}><div className="day-heading"><div><strong>{formatDay(day, { weekday: "short" })}</strong><span>{formatDay(day, { day: "numeric", month: "short" })}</span></div><b>{dayAssignments.length}</b></div>{dayAssignments.length ? dayAssignments.map((assignment) => <div className={`assignment-card ${assignment.employee ? "assigned" : "unfilled"}`} key={assignment.id} draggable={rota?.status !== "PUBLISHED"} onDragStart={() => setDraggedAssignment(assignment.id)} onDragEnd={() => setDraggedAssignment(null)} onDoubleClick={() => rota?.status !== "PUBLISHED" && openAssignmentEditor(assignment)}><div className="assignment-top"><strong>{assignment.shift_name}</strong><span>{assignment.employee ? "Assigned" : "Unfilled"}</span></div><p>{assignment.site_name}</p><small>{assignment.employee_name ? `${assignment.employee_name} · ${assignment.employee_code || ""}` : "Needs a staff assignment"}</small>{blockedDate(assignment) && <small className="assignment-unavailable">{conflictMessage(assignment, assignment.employee_name)}</small>}<small>{(assignment.scheduled_start || shiftById(assignment.shift_type)?.start_time || "").slice(0, 5)}–{(assignment.scheduled_end || shiftById(assignment.shift_type)?.end_time || "").slice(0, 5)}</small>{rota?.status !== "PUBLISHED" && <div className="assignment-actions"><button type="button" className="mini-button" onClick={() => copyAssignment(assignment)}><Copy size={13} /> Copy</button><button type="button" className="mini-button" onClick={() => openAssignmentEditor(assignment)}><Pencil size={13} /> Edit</button><button type="button" className="mini-button reject" onClick={() => removeAssignment(assignment.id)}><Trash2 size={13} /> Remove</button></div>}</div>) : <div className="day-empty">Drop a shift here or add a new assignment</div>}</article>; })}</section>
    {bulkOpen && <BulkAssignmentDialog api={api} rota={rota} days={days} sites={sites} shifts={shiftTypes}
      selectedDate={selectedDate} onClose={() => setBulkOpen(false)} onSaved={bulkSaved} />}
    {editingAssignment && <div className="modal-backdrop"><form className="modal-card" onSubmit={saveAssignmentEdit}><div className="modal-header"><div><p className="eyebrow">EDIT SHIFT</p><h3>Update assignment</h3><p className="muted">Change the day, site, guard or manual timing.</p></div><button type="button" className="icon-button" onClick={() => setEditingAssignment(null)}><X size={19} /></button></div><div className="form-grid"><label>Date<select required value={editForm.work_date} onChange={(event) => setEditForm({ ...editForm, work_date: event.target.value })}>{days.map((day) => <option value={day} key={day}>{formatDay(day, { weekday: "long", day: "numeric", month: "short" })}</option>)}</select></label><label>Shift<select required value={editForm.shift_type} onChange={(event) => setShiftOnForm(setEditForm, editForm, event.target.value)}>{shiftTypes.map((shift) => <option value={shift.id} key={shift.id}>{shift.name}</option>)}</select></label><label>Site<select required value={editForm.site} onChange={(event) => setEditForm({ ...editForm, site: event.target.value })}>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label><label>Guard<select value={editForm.employee} onChange={(event) => setEditForm({ ...editForm, employee: event.target.value })}><option value="">Unfilled shift</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{guardOptionLabel(employee, editForm)}</option>)}</select></label><label>Start time<input required type="time" value={editForm.scheduled_start} onChange={(event) => setEditForm({ ...editForm, scheduled_start: event.target.value })} /></label><label>End time<input required type="time" value={editForm.scheduled_end} onChange={(event) => setEditForm({ ...editForm, scheduled_end: event.target.value })} /></label><label className="full-width">Notes<input value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} /></label></div>{error && <p className="error">{error}</p>}{editConflict && <p className="rota-availability-warning" role="alert">{editConflict}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditingAssignment(null)}>Cancel</button><button className="primary-button" disabled={saving || Boolean(editConflict)}>{saving ? "Saving..." : "Save changes"}</button></div></form></div>}
    {canShareWhatsApp && rota?.status === "PUBLISHED" && rota.week_start === weekStart && !loading &&
      <RotaWhatsAppPanel key={rota.id} api={api} rota={rota} />}
    {batch && <RotaBatchDialog mode={batch.mode} api={api} rota={rota} days={days} shifts={shiftTypes}
      sites={batch.mode === "copy" ? sites.filter((site) => assignments.some((assignment) => assignment.site === site.id)) : sites.filter((site) => site.is_active !== false)}
      initial={batch.initial} onClose={() => setBatch(null)} onSaved={batchSaved} />}
    {publishReview && <PublishRotaDialog {...publishReview} busy={saving}
      onClose={() => setPublishReview(null)} onPublish={publish} />}
    {loading && <div className="loading-strip">Loading rota...</div>}
  </>;
}

function GuardInductionPage() {
  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [inductions, setInductions] = useState([]);
  const [siteFilter, setSiteFilter] = useState("");
  const [form, setForm] = useState({ site: "", employee: "", induction_date: new Date().toISOString().slice(0, 10), status: "PLANNED", notes: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try { const items = await api(`/site-inductions/${siteFilter ? `?site=${siteFilter}` : ""}`); setInductions(items); }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => {
    Promise.all([api("/sites/"), api("/employees/?status=ACTIVE")]).then(([siteItems, employeeItems]) => { setSites(siteItems); setEmployees(employeeItems); }).catch((err) => setError(err.message));
  }, []);
  useEffect(() => { load(); }, [siteFilter]);
  const save = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      await api("/site-inductions/", { method: "POST", body: JSON.stringify({ ...form, site: Number(form.site), employee: Number(form.employee) }) });
      setNotice("Guard induction saved. It will appear on the selected site in Weekly Rota.");
      setForm((current) => ({ ...current, employee: "", notes: "" }));
      await load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  return <><div className="page-heading"><div><p className="eyebrow">SITE COMPLIANCE</p><h2>Guard induction</h2><p className="muted">Record guard inductions by site and show them inside the selected Weekly Rota site.</p></div></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}<section className="panel induction-page-form"><div className="panel-header"><div><h3>Add induction</h3><p className="muted">Select the site where the guard induction took place.</p></div></div><form className="form-grid" onSubmit={save}><label>Site<select required value={form.site} onChange={(event) => setForm({ ...form, site: event.target.value })}><option value="">Select site</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name} · {site.site_id}</option>)}</select></label><label>Guard<select required value={form.employee} onChange={(event) => setForm({ ...form, employee: event.target.value })}><option value="">Select guard</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.employee_id}</option>)}</select></label><label>Induction date<input required type="date" value={form.induction_date} onChange={(event) => setForm({ ...form, induction_date: event.target.value })} /></label><label>Status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="PLANNED">Planned</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option></select></label><label className="full-width">Notes<input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Induction notes" /></label><div className="form-actions full-width"><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save induction"}</button></div></form></section><section className="panel"><div className="panel-header"><div><h3>Induction records</h3><p className="muted">These records are also shown when the matching site is opened in Weekly Rota.</p></div><div className="document-toolbar"><select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}><option value="">All sites</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select><span className="muted">{inductions.length} records</span></div></div>{loading ? <div className="empty-state compact-empty">Loading induction records...</div> : inductions.length ? <div className="table-wrap"><table><thead><tr><th>Site</th><th>Guard</th><th>Induction date</th><th>Status</th><th>Notes</th></tr></thead><tbody>{inductions.map((induction) => <tr key={induction.id}><td><strong>{induction.site_name}</strong></td><td>{induction.employee_name}<small className="table-subtext">{induction.employee_code}</small></td><td>{induction.induction_date}</td><td><span className={`status-pill ${induction.status === "COMPLETED" ? "active" : induction.status === "CANCELLED" ? "inactive" : "pending"}`}>{induction.status.toLowerCase()}</span></td><td>{induction.notes || "—"}</td></tr>)}</tbody></table></div> : <div className="empty-state compact-empty">No induction records found.</div>}</section></>;
}

function LegacyGuardInductionPageV2() {
  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [inductions, setInductions] = useState([]);
  const [siteFilter, setSiteFilter] = useState("");
  const [form, setForm] = useState({ site: "", employee: "", induction_date: new Date().toISOString().slice(0, 10), induction_time: "", status: "PLANNED", notes: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try { setInductions(await api(`/site-inductions/${siteFilter ? `?site=${siteFilter}` : ""}`)); }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { Promise.all([api("/sites/"), api("/employees/?status=ACTIVE")]).then(([siteItems, employeeItems]) => { setSites(siteItems); setEmployees(employeeItems); }).catch((err) => setError(err.message)); }, []);
  useEffect(() => { load(); }, [siteFilter]);
  const save = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try { await api("/site-inductions/", { method: "POST", body: JSON.stringify({ ...form, site: Number(form.site), employee: Number(form.employee), induction_time: form.induction_time || null }) }); setNotice("Induction saved. The guard is now linked to this site in Weekly Rota."); setForm((current) => ({ ...current, employee: "", induction_time: "", notes: "" })); await load(); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const portalReadyEmployees = employees.filter((employee) => employee.portal_status === "ACTIVE");
  return <><div className="page-heading"><div><p className="eyebrow">SITE COMPLIANCE</p><h2>Guard induction</h2><p className="muted">Add a guard to a site with the induction date and time.</p></div></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}<section className="panel induction-page-form"><div className="panel-header"><div><h3>Add induction</h3><p className="muted">Only guards with active portal access can be inducted. Completed inductions unlock that guard for the site’s Weekly Rota.</p></div></div><form className="form-grid" onSubmit={save}><label>Site<select required value={form.site} onChange={(event) => setForm({ ...form, site: event.target.value })}><option value="">Select site</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name} · {site.site_id}</option>)}</select></label><label>Guard<select required value={form.employee} onChange={(event) => setForm({ ...form, employee: event.target.value })}><option value="">Select guard</option>{portalReadyEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.employee_id}</option>)}</select></label><label>Induction date<input required type="date" value={form.induction_date} onChange={(event) => setForm({ ...form, induction_date: event.target.value })} /></label><label>Induction time<input type="time" value={form.induction_time} onChange={(event) => setForm({ ...form, induction_time: event.target.value })} /></label><label>Status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="PLANNED">Planned</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option></select></label><label className="full-width">Notes<input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Induction notes" /></label><div className="form-actions full-width"><button className="primary-button" disabled={saving || !portalReadyEmployees.length}>{saving ? "Saving..." : "Save induction"}</button></div></form>{!portalReadyEmployees.length && <p className="muted form-help">No guards with completed portal access are available yet. Create the employee first, then send the portal invite and finish activation.</p>}</section><section className="panel"><div className="panel-header"><div><h3>Induction records</h3><p className="muted">These records control which guards appear for each site in Weekly Rota.</p></div><div className="document-toolbar"><select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}><option value="">All sites</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select><span className="muted">{inductions.length} records</span></div></div>{loading ? <div className="empty-state compact-empty">Loading induction records...</div> : inductions.length ? <div className="table-wrap"><table><thead><tr><th>Site</th><th>Guard</th><th>Induction date/time</th><th>Status</th><th>Notes</th></tr></thead><tbody>{inductions.map((induction) => <tr key={induction.id}><td><strong>{induction.site_name}</strong></td><td>{induction.employee_name}<small className="table-subtext">{induction.employee_code}</small></td><td>{induction.induction_date}{induction.induction_time ? ` · ${induction.induction_time.slice(0, 5)}` : ""}</td><td><span className={`status-pill ${induction.status === "COMPLETED" ? "active" : induction.status === "CANCELLED" ? "inactive" : "pending"}`}>{induction.status.toLowerCase()}</span></td><td>{induction.notes || "—"}</td></tr>)}</tbody></table></div> : <div className="empty-state compact-empty">No induction records found.</div>}</section></>;
}

function RotaConfirmationPage() {
  const [weeks, setWeeks] = useState([]);
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadWeeks = async () => {
    try {
      const items = await api("/rota-weeks/");
      const published = items.filter((week) => week.status === "PUBLISHED");
      setWeeks(published);
      setSelectedWeekId((current) => current && published.some((week) => String(week.id) === current) ? current : String(published[0]?.id || ""));
    } catch (err) { setError(err.message); }
  };

  const loadSummary = async (weekId) => {
    if (!weekId) { setSummary(null); setLoading(false); return; }
    setLoading(true); setError("");
    try { setSummary(await api(`/rota-weeks/${weekId}/summary/`)); } catch (err) { setError(err.message); setSummary(null); } finally { setLoading(false); }
  };

  useEffect(() => { loadWeeks().finally(() => setLoading(false)); }, []);
  useEffect(() => { loadSummary(selectedWeekId); }, [selectedWeekId]);

  const confirmEmployee = async (employeeId) => {
    if (!selectedWeekId) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await api(`/rota-weeks/${selectedWeekId}/confirm/`, { method: "POST", body: JSON.stringify({ employee: employeeId }) });
      await loadSummary(selectedWeekId);
      setNotice("Employee rota confirmation saved.");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const confirmations = summary?.confirmations || [];
  const confirmedCount = confirmations.filter((item) => item.status === "CONFIRMED").length;
  return <>
    <div className="page-heading"><div><p className="eyebrow">ROTA MANAGEMENT</p><h2>Rota confirmation</h2><p className="muted">Track which employees have confirmed their published weekly rota.</p></div></div>
    {error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}
    <section className="panel confirmation-page-toolbar"><div className="panel-header"><div><h3>Published rotas</h3><p className="muted">Select a published week to review employee confirmations.</p></div><select value={selectedWeekId} onChange={(event) => setSelectedWeekId(event.target.value)} disabled={!weeks.length}><option value="">{weeks.length ? "Select published week" : "No published rotas"}</option>{weeks.map((week) => <option value={week.id} key={week.id}>Week commencing {formatDay(week.week_start, { day: "numeric", month: "short", year: "numeric" })}</option>)}</select></div></section>
    {loading ? <div className="empty-state"><strong>Loading confirmations...</strong></div> : summary ? <>
      <section className="rota-summary-grid confirmation-summary"><article><span>Published week</span><strong>{formatDay(summary.rota_week.week_start, { day: "numeric", month: "short" })}</strong><small>Published rota</small></article><article><span>Employees</span><strong>{confirmations.length}</strong><small>Assigned employees</small></article><article className="success-card"><span>Confirmed</span><strong>{confirmedCount}</strong><small>Employees confirmed</small></article><article className="warning"><span>Pending</span><strong>{confirmations.length - confirmedCount}</strong><small>Awaiting confirmation</small></article></section>
      <section className="panel confirmation-panel"><div className="panel-header"><div><h3>Employee confirmations</h3><p className="muted">Confirm each employee after the published rota has been shared.</p></div><span className="muted">{confirmedCount}/{confirmations.length} confirmed</span></div>{confirmations.length ? <div className="confirmation-list">{confirmations.map((confirmation) => <div className="confirmation-row" key={confirmation.id}><div><strong>{confirmation.employee_name}</strong><small>{confirmation.employee_code} · {confirmation.status === "CONFIRMED" && confirmation.confirmed_at ? `confirmed ${new Date(confirmation.confirmed_at).toLocaleString()}` : "confirmation pending"}</small></div>{confirmation.status === "CONFIRMED" ? <span className="status-pill active">Confirmed</span> : <button className="mini-button approve" disabled={saving} onClick={() => confirmEmployee(confirmation.employee)}><CheckCircle2 size={13} /> Confirm rota</button>}</div>)}</div> : <div className="empty-state compact-empty">No employee confirmations found for this rota.</div>}</section>
    </> : <div className="empty-state"><CheckCircle2 size={30} /><strong>No published rota available</strong><span>Publish a weekly rota first. Confirmation tracking will appear here.</span></div>}
  </>;
}

function CoverageStaffingPage() {
  const [weeks, setWeeks] = useState([]);
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [rota, setRota] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [shiftTypes, setShiftTypes] = useState([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [search, setSearch] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [shiftFilter, setShiftFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [coverage, setCoverage] = useState({ sites: [], slots: [] });
  const [coverageFilter, setCoverageFilter] = useState("ALL");
  const [coverageSearch, setCoverageSearch] = useState("");
  const [coveragePage, setCoveragePage] = useState(1);
  const [expandedSite, setExpandedSite] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const daysForWeek = (weekStart) => weekStart ? Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)) : [];
  const loadWeek = async (weekId, dateValue) => {
    if (!weekId) { setRota(null); setAssignments([]); setCoverage({ sites: [], slots: [] }); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const summary = await api(`/rota-weeks/${weekId}/summary/`);
      setRota(summary.rota_week);
      setAssignments(summary.assignments || []);
      const date = dateValue && dateValue >= summary.rota_week.week_start && dateValue <= addDays(summary.rota_week.week_start, 6) ? dateValue : summary.rota_week.week_start;
      setSelectedDate(date);
      setCoverage(await api(`/rota-weeks/${weekId}/coverage/?date=${date}`));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  useEffect(() => {
    Promise.all([api("/rota-weeks/"), api("/employees/?status=ACTIVE"), api("/sites/"), api("/shift-types/")]).then(([weekItems, employeeItems, siteItems, shiftItems]) => {
      setWeeks(weekItems);
      setEmployees(employeeItems);
      setSites(siteItems);
      setShiftTypes(shiftItems.filter((shift) => shift.is_active !== false));
      setSelectedWeekId(String(weekItems[0]?.id || ""));
    }).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { loadWeek(selectedWeekId, selectedDate); }, [selectedWeekId]);
  useEffect(() => { if (selectedWeekId && selectedDate && rota?.week_start <= selectedDate) loadWeek(selectedWeekId, selectedDate); }, [selectedDate]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredAssignments = assignments.filter((assignment) => {
    const searchable = `${assignment.employee_name || ""} ${assignment.employee_code || ""} ${assignment.site_name || ""}`.toLowerCase();
    const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
    const matchesSite = !siteFilter || String(assignment.site) === siteFilter;
    const matchesShift = !shiftFilter || String(assignment.shift_type) === shiftFilter;
    const matchesStatus = statusFilter === "ALL" || (statusFilter === "ASSIGNED" ? Boolean(assignment.employee) : !assignment.employee);
    return matchesSearch && matchesSite && matchesShift && matchesStatus;
  });
  const employeeRows = employees.filter((employee) => !normalizedSearch || `${employee.name} ${employee.employee_id}`.toLowerCase().includes(normalizedSearch)).map((employee) => {
    const employeeAssignments = filteredAssignments.filter((assignment) => assignment.employee === employee.id);
    return { employee, assignments: employeeAssignments, sites: new Set(employeeAssignments.map((assignment) => assignment.site_name)), days: new Set(employeeAssignments.map((assignment) => assignment.work_date)) };
  });
  const unfilledAssignments = coverage.slots.filter((slot) => {
    const searchable = `${slot.site_name} ${slot.shift_name}`.toLowerCase();
    return slot.unfilled > 0 && (!siteFilter || String(slot.site) === siteFilter) && (!shiftFilter || String(slot.shift_type) === shiftFilter) && (!normalizedSearch || searchable.includes(normalizedSearch));
  }).map((slot) => ({ id: `gap-${slot.site}-${slot.shift_type}`, work_date: selectedDate, site_name: slot.site_name, shift_name: `${slot.shift_name} · ${slot.unfilled} needed` }));
  const assignedCount = assignments.filter((assignment) => assignment.employee).length;
  const unfilledCount = coverage.slots.reduce((total, slot) => total + slot.unfilled, 0);
  const visibleSites = coverage.sites.filter((site) => coverageFilter === "ALL" || (coverageFilter === "GAPS" ? site.unfilled > 0 : site.unfilled === 0));
  const normalizedCoverageSearch = coverageSearch.trim().toLowerCase();
  const filteredCoverageSites = visibleSites.filter((site) => !normalizedCoverageSearch || `${site.site_name} ${site.site_code || site.site}`.toLowerCase().includes(normalizedCoverageSearch));
  const coveragePageSize = 20;
  const coveragePageCount = Math.max(1, Math.ceil(filteredCoverageSites.length / coveragePageSize));
  const coveragePageSites = filteredCoverageSites.slice((coveragePage - 1) * coveragePageSize, coveragePage * coveragePageSize);
  const selectedSite = coverage.sites.find((site) => site.site === expandedSite);
  const selectedSiteSlots = coverage.slots.filter((slot) => slot.site === expandedSite);
  const days = daysForWeek(rota?.week_start);

  useEffect(() => { setCoveragePage(1); }, [coverageFilter, coverageSearch, selectedDate]);
  const syncOperations = async () => {
    if (!selectedWeekId || !selectedDate) return;
    setSaving(true); setError(""); setNotice("");
    try { const result = await api(`/rota-weeks/${selectedWeekId}/generate_operations/`, { method: "POST", body: JSON.stringify({ date: selectedDate }) }); setNotice(`${result.total} daily operations synced.`); await loadWeek(selectedWeekId, selectedDate); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return <>
    <div className="page-heading"><div><p className="eyebrow">ROTA MANAGEMENT</p><h2>Coverage &amp; Staffing</h2><p className="muted">Review site coverage and plan employee assignments across the selected week.</p></div></div>
    {error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}
    <section className="panel coverage-staffing-toolbar"><div className="panel-header"><div><h3>Planning week</h3><p className="muted">Choose a rota week and day to review staffing.</p></div><div className="coverage-staffing-selects"><select value={selectedWeekId} onChange={(event) => setSelectedWeekId(event.target.value)} disabled={!weeks.length}><option value="">{weeks.length ? "Select week" : "No rota weeks"}</option>{weeks.map((week) => <option value={week.id} key={week.id}>Week commencing {formatDay(week.week_start, { day: "numeric", month: "short", year: "numeric" })} · {week.status}</option>)}</select><select value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} disabled={!days.length}>{days.map((day) => <option value={day} key={day}>{formatDay(day, { weekday: "long", day: "numeric", month: "short" })}</option>)}</select></div></div></section>
    {loading ? <div className="empty-state"><strong>Loading staff plan...</strong></div> : rota ? <>
      <section className="rota-summary-grid"><article><span>Active employees</span><strong>{employees.length}</strong><small>Available for planning</small></article><article><span>Assigned shifts this week</span><strong>{assignedCount}</strong><small>{filteredAssignments.length} matching weekly shifts</small></article><article className="warning"><span>Unfilled on selected date</span><strong>{unfilledCount}</strong><small>Required positions for {formatDay(selectedDate, { day: "numeric", month: "short" })}</small></article><article className="success-card"><span>Planning status</span><strong>{rota.status === "PUBLISHED" ? "Published" : "Draft"}</strong><small>Week commencing {formatDay(rota.week_start, { day: "numeric", month: "short" })}</small></article></section>
      <section className="panel coverage-panel"><div className="panel-header"><div><h3>Site coverage</h3><p className="muted">Required versus assigned staff across every active site and shift.</p></div><div className="coverage-actions"><button className="secondary-button" disabled={!coverage.slots.length || saving} onClick={syncOperations}><ClipboardList size={14} /> Sync daily operations</button></div></div><div className="coverage-toolbar"><div className="search-box"><Search size={16} /><input value={coverageSearch} onChange={(event) => setCoverageSearch(event.target.value)} placeholder="Search site name or ID" /></div><select value={coverageFilter} onChange={(event) => setCoverageFilter(event.target.value)}><option value="ALL">All sites</option><option value="GAPS">Needs staff</option><option value="COVERED">Fully covered</option></select><span className="muted">{filteredCoverageSites.length} sites</span></div>{filteredCoverageSites.length ? <><div className="table-wrap"><table className="coverage-table"><thead><tr><th>Site</th><th>Required</th><th>Assigned</th><th>Unfilled</th><th>Status</th><th>Action</th></tr></thead><tbody>{coveragePageSites.map((site) => <tr key={site.site}><td><strong>{site.site_name}</strong><small className="table-subtext">Site ID: {site.site_code || site.site}</small></td><td>{site.required}</td><td>{site.assigned}</td><td>{site.unfilled}</td><td><span className={`status-pill ${site.unfilled ? "pending" : "active"}`}>{site.unfilled ? "Needs staff" : "Fully covered"}</span></td><td><button type="button" className="mini-button" onClick={() => setExpandedSite(expandedSite === site.site ? null : site.site)}>{expandedSite === site.site ? "Hide shifts" : "View shifts"}</button></td></tr>)}</tbody></table></div><div className="coverage-pagination"><span>Showing {(coveragePage - 1) * coveragePageSize + 1}–{Math.min(coveragePage * coveragePageSize, filteredCoverageSites.length)} of {filteredCoverageSites.length}</span><div><button className="secondary-button" disabled={coveragePage <= 1} onClick={() => setCoveragePage((page) => page - 1)}>Previous</button><span>Page {coveragePage} of {coveragePageCount}</span><button className="secondary-button" disabled={coveragePage >= coveragePageCount} onClick={() => setCoveragePage((page) => page + 1)}>Next</button></div></div></> : <div className="empty-state compact-empty">No sites match this filter.</div>}{selectedSite && <div className="coverage-detail"><div className="coverage-detail-header"><strong>{selectedSite.site_name} · shift breakdown</strong><span>{selectedSite.assigned}/{selectedSite.required} assigned</span></div><div className="coverage-slot-grid">{selectedSiteSlots.map((slot) => <div className={`coverage-slot ${slot.unfilled ? "needs-attention" : "covered"}`} key={`${slot.site}-${slot.shift_type}`}><div><strong>{slot.shift_name}</strong><small>{slot.assigned}/{slot.required} staff</small></div>{slot.employees.length ? slot.employees.map((employee) => <span key={employee.assignment}>{employee.employee_name} · {employee.employee_id}</span>) : <span className="unfilled-text">No assignment · {slot.unfilled} needed</span>}</div>)}</div></div>}</section>
      <section className="panel rota-planning-panel"><div className="panel-header"><div><h3>Employee planning overview</h3><p className="muted">Search and filter the weekly plan without scrolling through all employees.</p></div><span className="muted">{filteredAssignments.length} matching shifts</span></div><div className="rota-filter-grid"><label>Search employee or site<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, ID or site" /></label><label>Site<select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}><option value="">All sites</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label><label>Shift<select value={shiftFilter} onChange={(event) => setShiftFilter(event.target.value)}><option value="">All shifts</option>{shiftTypes.map((shift) => <option value={shift.id} key={shift.id}>{shift.name}</option>)}</select></label><label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="ALL">All status</option><option value="ASSIGNED">Assigned</option><option value="UNFILLED">Unfilled</option></select></label></div><div className="planning-columns"><div className="employee-overview-wrap"><table className="employee-overview-table"><thead><tr><th>Employee</th><th>Shifts</th><th>Sites</th><th>Days</th><th>Status</th></tr></thead><tbody>{employeeRows.map((row) => <tr key={row.employee.id}><td><strong>{row.employee.name}</strong><small>{row.employee.employee_id}</small></td><td>{row.assignments.length}</td><td>{row.sites.size || "—"}</td><td>{row.days.size || "—"}</td><td><span className={`status-pill ${row.assignments.length ? "active" : "neutral"}`}>{row.assignments.length ? "Assigned" : "Unassigned"}</span></td></tr>)}</tbody></table></div><aside className="unfilled-queue"><div className="queue-header"><strong>Unfilled queue</strong><span>{unfilledAssignments.length}</span></div>{unfilledAssignments.length ? unfilledAssignments.slice(0, 12).map((assignment) => <button type="button" key={assignment.id} onClick={() => setSelectedDate(assignment.work_date)}><strong>{assignment.site_name}</strong><span>{formatDay(assignment.work_date, { weekday: "short", day: "numeric", month: "short" })} · {assignment.shift_name}</span></button>) : <div className="queue-empty">No unfilled shifts in this filter.</div>}{unfilledAssignments.length > 12 && <small>Showing first 12 gaps</small>}</aside></div></section>
    </> : <div className="empty-state"><Users size={30} /><strong>No rota week available</strong><span>Create a weekly rota first to use Coverage &amp; Staffing.</span></div>}
  </>;
}

function Records({ kind }) {
  const isEmployee = kind === "employees";
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const endpoint = isEmployee ? "employees" : "sites";
  const emptyForm = isEmployee ? { employee_id: "", name: "", position: "Security Guard", phone: "", status: "ACTIVE" } : { site_id: "", name: "", address: "", required_guards: 1, latitude: "", longitude: "", geofence_radius_m: 150, is_active: true };
  const [form, setForm] = useState(emptyForm);
  const load = () => { setLoading(true); api(`/${endpoint}/?search=${encodeURIComponent(search)}`).then(setItems).catch(() => setItems([])).finally(() => setLoading(false)); };
  useEffect(load, [kind]);
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await api(`/${endpoint}/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(form) });
      setForm(emptyForm);
      setFormOpen(false);
      load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  };
  const remove = async (id) => {
    if (!confirm(`Delete this ${isEmployee ? "employee" : "site"}?`)) return;
    try { await api(`/${endpoint}/${id}/`, { method: "DELETE" }); load(); } catch (err) { setFormError(err.message); }
  };
  const updateForm = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  return <><div className="page-heading"><div><p className="eyebrow">MANAGEMENT</p><h2>{isEmployee ? "Employees" : "Sites"}</h2><p className="muted">{isEmployee ? "Manage guards, supervisors and employee records." : "Manage client sites and staffing requirements."}</p></div><button className="primary-button" onClick={() => { setEditingId(null); setForm(emptyForm); setFormError(""); setFormOpen(true); }}>Add {isEmployee ? "employee" : "site"}</button></div><section className="panel"><div className="toolbar"><div className="search-box"><Search size={17} /><input placeholder={`Search ${isEmployee ? "employees" : "sites"}...`} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} /></div><span className="muted">{items.length} records</span></div>{loading ? <div className="empty-state">Loading records...</div> : items.length === 0 ? <div className="empty-state"><Users size={30} /><strong>No records found</strong><span>Use the Add button to create your first record.</span></div> : <div className="table-wrap"><table><thead><tr>{isEmployee ? <><th>ID</th><th>Name</th><th>Position</th><th>Status</th><th>Phone</th></> : <><th>ID</th><th>Site</th><th>Required guards</th><th>Contact</th><th>Status</th></>}<th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}>{isEmployee ? <><td>{item.employee_id}</td><td><strong>{item.name}</strong></td><td>{item.position || "—"}</td><td><span className={`status-pill ${item.status.toLowerCase()}`}>{item.status.replace("_", " ")}</span></td><td>{item.phone || "—"}</td></> : <><td>{item.site_id}</td><td><strong>{item.name}</strong></td><td>{item.required_guards}</td><td>{item.contact_name || "—"}</td><td><span className={`status-pill ${item.is_active ? "active" : "inactive"}`}>{item.is_active ? "Active" : "Inactive"}</span></td></>}<td><div className="row-actions"><button className="mini-button" onClick={() => { setEditingId(item.id); setForm(item); setFormError(""); setFormOpen(true); }}><Pencil size={13} /> Edit</button><button className="mini-button reject" onClick={() => remove(item.id)}><Trash2 size={13} /> Delete</button></div></td></tr>)}</tbody></table></div>}</section>{formOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setFormOpen(false)}><form className="modal-card" onSubmit={submit}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EDIT RECORD" : "NEW RECORD"}</p><h3>{editingId ? "Edit" : "Add"} {isEmployee ? "employee" : "site"}</h3></div><button type="button" className="icon-button" onClick={() => setFormOpen(false)}><X size={19} /></button></div><div className="form-grid">{isEmployee ? <><label>ID<input required value={form.employee_id} onChange={(e) => updateForm("employee_id", e.target.value)} placeholder="EMP-003" /></label><label>Name<input required value={form.name} onChange={(e) => updateForm("name", e.target.value)} placeholder="Full name" /></label><label>Position<input value={form.position} onChange={(e) => updateForm("position", e.target.value)} /></label><label>Phone<input value={form.phone} onChange={(e) => updateForm("phone", e.target.value)} placeholder="+92..." /></label><label>Status<select value={form.status} onChange={(e) => updateForm("status", e.target.value)}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="ON_LEAVE">On leave</option></select></label></> : <><label>ID<input required value={form.site_id} onChange={(e) => updateForm("site_id", e.target.value)} placeholder="SITE-002" /></label><label>Site name<input required value={form.name} onChange={(e) => updateForm("name", e.target.value)} placeholder="Client site" /></label><label className="full-width">Address<input value={form.address} onChange={(e) => updateForm("address", e.target.value)} /></label><label>Required guards<input required min="1" type="number" value={form.required_guards} onChange={(e) => updateForm("required_guards", Number(e.target.value))} /></label><label>Active<select value={String(form.is_active)} onChange={(e) => updateForm("is_active", e.target.value === "true")}><option value="true">Active</option><option value="false">Inactive</option></select></label></>}</div>{formError && <p className="error">{formError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save record"}</button></div></form></div>}</>;
}

function SiteRecords() {
  const empty = { client: "", site_id: "", name: "", address: "", required_guards: 1, latitude: "", longitude: "", geofence_radius_m: 150, attendance_mode: "WITH_HOURLY", location_tracking_enabled: false, cortex_itime_enabled: false, timegate_enabled: false, is_active: true };
  const [items, setItems] = useState([]); const [clients, setClients] = useState([]); const [search, setSearch] = useState(""); const [form, setForm] = useState(empty); const [open, setOpen] = useState(false); const [editingId, setEditingId] = useState(null); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const load = () => api(`/sites/?search=${encodeURIComponent(search)}`).then(setItems).catch((err) => setError(err.message));
  useEffect(() => { load(); api("/clients/").then(setClients).catch(() => {}); }, []);
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); const payload = { ...form, client: form.client ? Number(form.client) : null, required_guards: Number(form.required_guards), latitude: form.latitude === "" ? null : Number(form.latitude), longitude: form.longitude === "" ? null : Number(form.longitude), geofence_radius_m: Number(form.geofence_radius_m) }; try { await api(`/sites/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) }); setOpen(false); setEditingId(null); setForm(empty); load(); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  const remove = async (id) => { if (!confirm("Delete this site?")) return; try { await api(`/sites/${id}/`, { method: "DELETE" }); load(); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">SITE MANAGEMENT</p><h2>Sites</h2><p className="muted">Manage client sites and configure GPS geofences for guard attendance.</p></div><button className="primary-button" onClick={() => { setEditingId(null); setForm(empty); setError(""); setOpen(true); }}>Add site</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div className="search-box"><Search size={17} /><input placeholder="Search sites..." value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} /></div><span className="muted">{items.length} sites</span></div>{items.length ? <div className="table-wrap"><table><thead><tr><th>Client</th><th>ID</th><th>Site</th><th>Required guards</th><th>Geofence</th><th>GPS</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.client_name || "Unassigned"}</td><td>{item.site_id}</td><td><strong>{item.name}</strong><small className="table-subtext">{item.address || "No address"}</small><small className="table-subtext site-attendance-summary">{siteAttendanceLabel(item)}{item.cortex_itime_enabled ? " · Cortex iTime" : ""}{item.timegate_enabled ? " · TimeGate" : ""}{item.location_tracking_enabled ? " · 30-minute location tracking" : ""}</small></td><td>{item.required_guards}</td><td>{item.latitude !== null && item.longitude !== null ? `${item.geofence_radius_m}m` : "Not configured"}</td><td>{item.latitude !== null && item.longitude !== null ? "Configured" : "Missing"}</td><td><span className={`status-pill ${item.is_active ? "active" : "inactive"}`}>{item.is_active ? "Active" : "Inactive"}</span></td><td><div className="row-actions"><button className="mini-button" onClick={() => { setEditingId(item.id); setForm({ ...empty, ...item, client: item.client ?? "", latitude: item.latitude ?? "", longitude: item.longitude ?? "" }); setError(""); setOpen(true); }}><Pencil size={13} /> Edit</button><button className="mini-button reject" onClick={() => remove(item.id)}><Trash2 size={13} /> Delete</button></div></td></tr>)}</tbody></table></div> : <div className="empty-state"><Building2 size={30} /><strong>No sites found</strong><span>Add a site and configure its GPS coordinates before using Book On verification.</span></div>}</section>{open && <div className="modal-backdrop"><form className="modal-card site-record-modal" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EDIT SITE" : "NEW SITE"}</p><h3>{editingId ? "Edit site" : "Add site"}</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Client<select required value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })}><option value="">Select client</option>{clients.filter((client) => client.status === "ACTIVE").map((client) => <option value={client.id} key={client.id}>{client.client_id} · {client.name}</option>)}</select></label><label>Site ID<input required value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} placeholder="SITE-001" /></label><label>Site name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label className="full-width">Address<textarea rows="2" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Required guards<input required min="1" type="number" value={form.required_guards} onChange={(e) => setForm({ ...form, required_guards: e.target.value })} /></label><label>Latitude<input type="number" min="-90" max="90" step="any" required={form.longitude !== ""} value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} placeholder="51.5074" /></label><label>Longitude<input type="number" min="-180" max="180" step="any" required={form.latitude !== ""} value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} placeholder="-0.1278" /></label><label>Geofence radius (metres)<input required min="50" type="number" value={form.geofence_radius_m} onChange={(e) => setForm({ ...form, geofence_radius_m: e.target.value })} /></label><label>Active<select value={String(form.is_active)} onChange={(e) => setForm({ ...form, is_active: e.target.value === "true" })}><option value="true">Active</option><option value="false">Inactive</option></select></label><SitePinInput latitude={form.latitude} longitude={form.longitude} address={form.address} onChange={(point) => setForm((current) => ({ ...current, ...point }))} /><fieldset className="site-attendance-field full-width"><legend>Attendance requirements</legend><div className="site-attendance-options">{siteAttendanceModes.map((mode) => <label className={`site-attendance-option${form.attendance_mode === mode.value ? " selected" : ""}`} key={mode.value}><input type="radio" name="attendance_mode" value={mode.value} checked={form.attendance_mode === mode.value} onChange={(event) => setForm({ ...form, attendance_mode: event.target.value })} required /><span><strong>{mode.label}</strong><small>{mode.hint}</small></span></label>)}</div><p className="muted">Guards assigned to this site will follow the selected attendance steps.</p></fieldset><label className="full-width site-tracking-setting"><input type="checkbox" checked={Boolean(form.location_tracking_enabled)} onChange={(event) => setForm({ ...form, location_tracking_enabled: event.target.checked })} /><span><strong>Enable 30-minute location tracking</strong><small>Track assigned guards after Book On, during duty only. Updates can pause when the phone is locked or the browser is closed.</small></span></label>
      <label className="full-width site-tracking-setting">
        <input type="checkbox" checked={Boolean(form.cortex_itime_enabled)}
          onChange={(event) => setForm({ ...form, cortex_itime_enabled: event.target.checked })} />
        <span><strong>Enable Cortex iTime</strong><small>Allow the office to record Cortex iTime activation for this site.</small></span>
      </label>
      <label className="full-width site-tracking-setting">
        <input type="checkbox" checked={Boolean(form.timegate_enabled)}
          onChange={(event) => setForm({ ...form, timegate_enabled: event.target.checked })} />
        <span><strong>Enable TimeGate</strong><small>Mark this site as using TimeGate.</small></span>
      </label></div>{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save site"}</button></div></form></div>}</>;
}

function LegacyEmployeeRecordsOriginal() {
  const empty = { employee_id: "", name: "", date_of_birth: "", nationality: "", position: "Security Guard", phone: "", email: "", address: "", emergency_contact: "", joining_date: "", status: "ACTIVE" };
  const [items, setItems] = useState([]); const [search, setSearch] = useState(""); const [open, setOpen] = useState(false); const [editingId, setEditingId] = useState(null); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [invite, setInvite] = useState(null); const [copied, setCopied] = useState(false);
  const load = () => api(`/employees/?search=${encodeURIComponent(search)}`).then(setItems).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);
  const editForm = (item) => ({ employee_id: item.employee_id || "", name: item.name || "", date_of_birth: item.date_of_birth || "", nationality: item.nationality || "", position: item.position || "", phone: item.phone || "", email: item.email || "", address: item.address || "", emergency_contact: item.emergency_contact || "", joining_date: item.joining_date || "", status: item.status || "ACTIVE" });
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); try { await api(`/employees/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(form) }); setOpen(false); setEditingId(null); setForm(empty); load(); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  const createPortalAccount = async (employee) => { if (!confirm(`${employee.portal_status === "INVITE_PENDING" ? "Resend" : "Create"} secure portal invite for ${employee.name}?`)) return; setError(""); try { const result = await api(`/employees/${employee.id}/create_portal_account/`, { method: "POST", body: JSON.stringify({ frontend_url: PORTAL_ORIGIN }) }); setInvite({ employee: employee.name, url: result.activation_url }); setCopied(false); try { await navigator.clipboard.writeText(result.activation_url); setCopied(true); } catch { /* Keep the link visible for manual copy if clipboard permission is unavailable. */ } load(); } catch (err) { setError(err.message); } };
  const copyInvite = async () => { if (!invite?.url) return; try { await navigator.clipboard.writeText(invite.url); setCopied(true); } catch { setCopied(false); } }; const removeEmployee = async (employee) => { if (!confirm(`Delete ${employee.name}? This cannot be undone.`)) return; setError(""); try { await api(`/employees/${employee.id}/`, { method: "DELETE" }); await load(); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">PEOPLE MANAGEMENT</p><h2>Employees</h2><p className="muted">Manage guards and send secure self-service portal invites.</p></div><button className="primary-button" onClick={() => { setEditingId(null); setForm(empty); setError(""); setOpen(true); }}>Add employee</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div className="search-box"><Search size={17} /><input placeholder="Search employees..." value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} /></div><span className="muted">{items.length} records</span></div>{items.length === 0 ? <div className="empty-state"><Users size={30} /><strong>No employees found</strong><span>Use the Add employee button to create a record.</span></div> : <div className="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Position</th><th>Profile</th><th>Portal access</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.employee_id}</td><td><strong>{item.name}</strong></td><td>{item.position || "—"}</td><td><span className="profile-completion-inline">{item.profile_completion || 0}%</span></td><td>{item.portal_status === "ACTIVE" ? <span className="status-pill active">Active</span> : <button className="mini-button" onClick={() => createPortalAccount(item)}>{item.portal_status === "INVITE_PENDING" ? "Resend invite" : "Invite guard"}</button>}</td><td><span className={`status-pill ${item.status.toLowerCase()}`}>{item.status.replace("_", " ")}</span></td><td><div className="row-actions"><button className="mini-button" onClick={() => { setEditingId(item.id); setForm(editForm(item)); setError(""); setOpen(true); }}><Pencil size={13} /> Edit</button></div></td></tr>)}</tbody></table></div>}</section>{open && <div className="modal-backdrop"><form className="modal-card" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EDIT RECORD" : "NEW RECORD"}</p><h3>{editingId ? "Edit employee" : "Add employee"}</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Employee ID<input required value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} /></label><label>Full name (first name + surname)<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="First name Surname" /></label><label>Date of birth<input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></label><label>Nationality<input value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} placeholder="Select nationality" /></label><label>Position<select required value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}><option value="">Select position</option>{positionOptions.map((position) => <option value={position} key={position}>{position}</option>)}</select></label><label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label><label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Joining date<input type="date" value={form.joining_date} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} /></label><label className="full-width">Address<textarea rows="2" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label className="full-width">Emergency contact<input value={form.emergency_contact} onChange={(e) => setForm({ ...form, emergency_contact: e.target.value })} /></label><label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="ON_LEAVE">On leave</option></select></label></div>{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save employee"}</button></div></form></div>}{invite && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setInvite(null)}><section className="modal-card invite-modal"><div className="modal-header"><div><p className="eyebrow">GUARD PORTAL INVITE</p><h3>Invite link ready</h3><p className="muted">Send this one-time link to {invite.employee}. It expires in 48 hours.</p></div><button type="button" className="icon-button" onClick={() => setInvite(null)}><X size={19} /></button></div><div className="invite-link-box"><input readOnly value={invite.url} onFocus={(event) => event.target.select()} /><button className="primary-button" onClick={copyInvite}>{copied ? "Copied" : "Copy link"}</button></div>{copied ? <p className="success invite-success">Invite link copied to clipboard successfully.</p> : <p className="muted invite-help">Clipboard permission was unavailable. Select the link above and copy it manually.</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setInvite(null)}>Done</button></div></section></div>}</>;
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

function LeavePage({ initialLeaveId }) {
  const [items, setItems] = useState([]); const [employees, setEmployees] = useState([]); const [open, setOpen] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const empty = { employee: "", leave_type: "ANNUAL", start_date: todayIso(), end_date: todayIso(), reason: "" }; const [form, setForm] = useState(empty);
  const load = () => api("/leave/").then(setItems).catch((err) => setError(err.message));
  useEffect(() => { load(); api("/employees/?status=ACTIVE").then(setEmployees).catch(() => {}); }, []);
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); try { await api("/leave/", { method: "POST", body: JSON.stringify({ ...form, employee: Number(form.employee) }) }); setOpen(false); setForm(empty); load(); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  const review = async (id, action) => { try { await api(`/leave/${id}/${action}/`, { method: "POST", body: "{}" }); load(); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">PEOPLE MANAGEMENT</p><h2>Leave</h2><p className="muted">Track leave records and keep rota availability accurate.</p></div><button className="primary-button" onClick={() => { setForm(empty); setOpen(true); }}>Request leave</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div><h3>Leave records</h3><p className="muted">Approve or reject pending requests.</p></div><span className="muted">{items.length} records</span></div>{items.length === 0 ? <div className="empty-state"><CalendarDays size={30} /><strong>No leave records</strong><span>Create the first leave request to see it here.</span></div> : <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Status</th><th>Reason</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={item.id === initialLeaveId ? "notification-target-row" : undefined}><td><strong>{item.employee_name}</strong></td><td>{item.leave_type}</td><td>{item.start_date} → {item.end_date}</td><td><span className={`status-pill ${item.status.toLowerCase()}`}>{item.status}</span></td><td>{item.reason || "—"}</td><td>{item.status === "PENDING" && <div className="row-actions"><button className="mini-button approve" onClick={() => review(item.id, "approve")}><CheckCircle2 size={13} />Approve</button><button className="mini-button reject" onClick={() => review(item.id, "reject")}>Reject</button></div>}</td></tr>)}</tbody></table></div>}</section>{open && <div className="modal-backdrop"><form className="modal-card" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">NEW REQUEST</p><h3>Request leave</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Employee<select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}><option value="">Select employee</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label><label>Leave type<select value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}><option>ANNUAL</option><option>SICK</option><option>EMERGENCY</option><option>OTHER</option></select></label><label>Start date<input required type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></label><label>End date<input required type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></label><label className="full-width">Reason<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Optional reason" /></label></div>{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Submit request"}</button></div></form></div>}</>;
}

function DocumentDriveCell({ document, activeRootId, documentLabel, onRetry }) {
  const { label, tone, url, syncedAt, detail, canRetry } = documentDriveStatus(document, activeRootId);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const retry = async () => {
    setRetryError("");
    setRetrying(true);
    try {
      await onRetry(document.id);
    } catch (error) {
      setRetryError(error.message);
    } finally {
      setRetrying(false);
    }
  };
  const status = <>
    {tone === "active" && <CheckCircle2 size={13} aria-hidden="true" />}
    <span>{label}</span>
    {url && <ExternalLink size={12} aria-hidden="true" />}
  </>;
  const className = `status-pill document-drive-badge ${tone}`;
  return <td><div className="document-drive-status">
    <div className="document-drive-actions">
      {url ? <a className={className} href={url} target="_blank" rel="noopener noreferrer"
        title="Open in Google Drive" aria-label={`${label}. Open ${documentLabel} in Google Drive`}>{status}</a>
        : <span className={className}>{status}</span>}
      {canRetry && <button type="button" className="mini-button document-drive-retry" onClick={retry} disabled={retrying}
        aria-label={retrying ? `Uploading ${documentLabel}` : `Retry upload for ${documentLabel}`}>
        <RefreshCw size={12} aria-hidden="true" /> {retrying ? "Uploading…" : "Retry upload"}
      </button>}
    </div>
    {(syncedAt || detail) && <div className="document-drive-meta">
      {syncedAt && <time dateTime={syncedAt}>{formatUkDateTime(syncedAt)}</time>}
      {detail && <small>{detail}</small>}
    </div>}
    {canRetry && retryError && <small className="document-drive-retry-error" role="alert">{retryError}</small>}
  </div></td>;
}

function EmployeeDocumentRow({ employee, expanded, onToggle, onAddDocument, onEdit, onDelete, onReview, fileHref, archiveSelection, showDriveStatus, driveRootId, onDriveRetry }) {
  const statusClass = employee.compliance_status.toLowerCase();
  const statusLabel = { NO_DOCUMENTS: "No documents", REVIEW_REQUIRED: "Review required", REJECTED: "Rejected", EXPIRING_SOON: "Expiring soon", EXPIRED: "Expired", VALID: "Valid" }[employee.compliance_status] || employee.compliance_status.replaceAll("_", " ");
  const verificationLabel = { PENDING: "Needs review", VERIFIED: "Verified", REJECTED: "Rejected" };
  const uploadedIds = archiveSelection && expanded ? employee.documents.filter((item) => item.secure_file_url).map((item) => item.id) : [];
  const selectedIds = uploadedIds.filter((id) => archiveSelection.selected.has(id));
  const selectedCount = selectedIds.length;
  const allSelected = uploadedIds.length > 0 && selectedCount === uploadedIds.length;
  return <><tr><td><button className="employee-expand-button" aria-expanded={expanded} onClick={onToggle}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span><strong>{employee.employee_name}</strong><small>{employee.employee_id} · {employee.documents_count} document{employee.documents_count === 1 ? "" : "s"}</small></span></button></td><td>{employee.employee_status.replace("_", " ")}</td><td><strong>{employee.documents_count}</strong><small className="document-count">{employee.valid_documents} valid</small></td><td>{employee.documents_count ? `${employee.valid_documents}/${employee.documents_count}` : "—"}</td><td>{employee.nearest_expiry || "—"}</td><td><span className={`status-pill ${statusClass}`}>{statusLabel}</span></td><td><button className="mini-button" onClick={() => onAddDocument(employee.employee)}><Upload size={13} /> Add</button></td></tr>{expanded && <tr className="expanded-document-row"><td colSpan="7"><div className="expanded-document-panel"><div className="expanded-document-header"><div><strong>{employee.employee_name} documents</strong><span>{employee.documents_count} documents · {employee.expired_documents} expired · {employee.expiring_documents} expiring soon</span></div><button className="primary-button" onClick={() => onAddDocument(employee.employee)}><Upload size={14} /> Add document</button></div>{archiveSelection && uploadedIds.length > 0 && <div className="document-zip-bar">
        <div>
          <strong aria-live="polite">{selectedCount ? `${selectedCount} selected for ZIP` : "Select files to download as a ZIP"}</strong>
        </div>
        <div className="document-zip-actions">
          {selectedCount > 0 && <button type="button" className="secondary-button" disabled={archiveSelection.busy}
            onClick={archiveSelection.clear}>Clear selection</button>}
          <button type="button" className="primary-button" disabled={!selectedCount || archiveSelection.busy}
            onClick={() => archiveSelection.download(employee.employee_name, selectedIds)}>
            <Download size={15} /> {archiveSelection.busy ? "Preparing ZIP…" : "Download ZIP"}
          </button>
        </div>
        {archiveSelection.error && <p className="error" role="alert">{archiveSelection.error}</p>}
      </div>}{employee.documents.length ? <div className="table-wrap document-detail-scroll" role="region" aria-label={`${employee.employee_name} documents`} tabIndex={0}><table className="nested-document-table"><thead><tr>{archiveSelection && <th className="document-zip-check">
          <input type="checkbox" aria-label={`Select all uploaded documents for ${employee.employee_name}`}
            ref={(element) => { if (element) element.indeterminate = selectedCount > 0 && !allSelected; }}
            checked={allSelected} disabled={archiveSelection.busy || !uploadedIds.length}
            onChange={(event) => archiveSelection.update(uploadedIds, event.target.checked)} />
        </th>}<th>Document</th><th>Number</th><th>Expiry</th><th>Review</th><th>File</th>{showDriveStatus && <th scope="col">Google Drive</th>}<th>Actions</th></tr></thead><tbody>{employee.documents.map((item) => {
        const label = item.document_type === "Certificates" ? `Certificate · ${certificateLabel(item)}` : item.document_label || item.document_type;
        return <tr key={item.id} className={archiveSelection?.selected.has(item.id) ? "document-row-selected" : undefined}>{archiveSelection && <td className="document-zip-check">
          <input type="checkbox" aria-label={`Select ${label} for ${employee.employee_name}`}
            title={item.secure_file_url ? "Include in ZIP" : "An uploaded file is required"}
            checked={archiveSelection.selected.has(item.id)} disabled={archiveSelection.busy || !item.secure_file_url}
            onChange={(event) => archiveSelection.update([item.id], event.target.checked)} />
        </td>}<td className="document-type-cell"><strong>{label}</strong>{item.rejection_reason && <small className="document-review-reason">Reason: {item.rejection_reason}</small>}</td><td>{item.document_number || "—"}</td><td className="document-expiry-cell">{item.expiry_date || "No expiry"}</td><td><div className="document-status-stack"><span className={`status-pill ${(item.verification_status || "PENDING").toLowerCase()}`}>{verificationLabel[item.verification_status] || "Needs review"}</span><span className={`status-pill ${item.status.toLowerCase()}`}>{item.status.replace("_", " ")}</span></div></td><td>{fileHref(item) ? <ProtectedFilePreview value={fileHref(item)} label={`${employee.employee_name} · ${item.document_label || item.document_type}`} buttonLabel="View" /> : "—"}</td>{showDriveStatus && <DocumentDriveCell document={item} activeRootId={driveRootId} documentLabel={label} onRetry={onDriveRetry} />}<td><div className="row-actions compliance-review-actions">{item.verification_status === "PENDING" && <><button className="mini-button approve" onClick={() => onReview(item, "verify")}><CheckCircle2 size={13} /> Verify</button><button className="mini-button reject" onClick={() => onReview(item, "reject")}>Reject</button></>}<button className="mini-button" onClick={() => onEdit(item)}><Pencil size={13} /> Edit</button><button className="mini-button reject" onClick={() => onDelete(item.id)}><Trash2 size={13} /> Delete</button></div></td></tr>; })}</tbody></table></div> : <div className="empty-state compact-empty"><strong>No documents yet</strong><span>Add the first document for this employee.</span></div>}</div></td></tr>}</>;
}

const driveConnectionPath = "/integrations/google-drive/connect/";
const driveConnectionStateKey = "rotaops.google-drive.state";

function GoogleDriveConnection({ connection, setConnection }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("google_drive");

    const load = async () => {
      if (result === "authorize" || result === "cancelled") {
        const params = new URLSearchParams(url.hash.slice(1));
        url.searchParams.delete("google_drive");
        url.hash = "";
        window.history.replaceState(window.history.state, "", url);
        setConnecting(true);
        try {
          const state = params.get("state");
          const expected = sessionStorage.getItem(driveConnectionStateKey);
          if (!state || state !== expected) throw new Error("Start the connection again from this browser tab.");
          sessionStorage.removeItem(driveConnectionStateKey);
          if (result === "cancelled") throw new Error("Google Drive authorisation was cancelled.");
          const updated = await api(driveConnectionPath, {
            method: "POST", body: JSON.stringify({ state, code: params.get("code") }),
            silentLoading: true, silentToast: true, silentError: true,
          });
          setConnection(updated);
          notifyToast(`Google Drive connected as ${updated.authorized_email}.`, "success");
          return;
        } catch (err) {
          setError(err.message);
        } finally {
          setConnecting(false);
        }
      }
      try {
        setConnection(await api("/integrations/google-drive/status/", { silentLoading: true, silentError: true }));
      } catch (err) {
        setError(err.message);
      }
    };
    load();
  }, []);

  const connect = async () => {
    setConnecting(true);
    setError("");
    try {
      const result = await api(driveConnectionPath, { silentLoading: true, silentError: true });
      sessionStorage.setItem(driveConnectionStateKey, result.state);
      window.location.assign(result.authorization_url);
    } catch (err) {
      setError(err.message);
      setConnecting(false);
    }
  };

  return <section className="panel" aria-labelledby="documents-google-drive">
    <div className="toolbar">
      <div>
        <h3 id="documents-google-drive">Google Drive</h3>
        {connection?.connected && <>
          <p className="muted">{connection.authorized_email ? `Connected as ${connection.authorized_email}` : "Connected. Authorise the account again to show its email."}</p>
          <p className="muted">Changing accounts sends future verified documents to the new Drive. Existing copies stay in their original Drive.</p>
        </>}
        {connection && !connection.configured && <p className="muted">Google OAuth configuration is required on the backend.</p>}
      </div>
      <button type="button" className="secondary-button" disabled={!connection?.configured || connecting} onClick={connect}>
        {connecting ? "Connecting…" : connection?.connected ? "Change Google Account" : "Connect Google Drive"}
      </button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

function DocumentsPage({ onNavigate, target = {}, isOfficeAdmin = false }) {
  const [driveConnection, setDriveConnection] = useState(null);
  const [documentOptions, setDocumentOptions] = useState(null);
  const [optionsError, setOptionsError] = useState("");
  const [managingOptions, setManagingOptions] = useState(false);
  const [selectedDocuments, setSelectedDocuments] = useState(new Set());
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState("");
  const [items, setItems] = useState([]); const [employees, setEmployees] = useState([]); const [open, setOpen] = useState(false); const [error, setError] = useState(""); const [editingDocument, setEditingDocument] = useState(null); const [expandedId, setExpandedId] = useState(target.employee_record_id || null); const [searchInput, setSearchInput] = useState(target.employee_name || ""); const [searchQuery, setSearchQuery] = useState(target.employee_name || ""); const [status, setStatus] = useState("ALL"); const [pagination, setPagination] = useState({ page: 1, total_pages: 1, total_employees: 0 }); const empty = { employee: "", document_type: "", document_number: "", certificate_type: "", certificate_name: "", issue_date: "", expiry_date: "", file_url: "", file: null, notes: "" }; const [form, setForm] = useState(empty);
  const uniqueEmployees = Array.from(new Map(employees.map((employee) => [employee.name.trim().toLowerCase(), employee])).values());
  const editingId = editingDocument?.id;
  const missingEmployee = editingDocument && !uniqueEmployees.some((employee) => employee.id === editingDocument.employee);
  const selectedEmployee = uniqueEmployees.find((employee) => String(employee.id) === form.employee);
  const builtinOptions = (documentOptions || []).filter((option) => option.builtin_key);
  const requiredTypes = requiredDocumentItems(selectedEmployee, builtinOptions).map((item) => item.label);
  const optionalTypes = optionalDocumentItemsFor(builtinOptions, selectedEmployee).map((item) => item.label);
  const checklistTypes = [...requiredTypes, ...optionalTypes];
  const savedType = editingDocument?.document_type;
  const extraSavedType = savedType && !checklistTypes.includes(savedType) ? savedType : "";
  const customChoices = (documentOptions || []).filter((option) => option.is_active && !option.builtin_key);
  const savedOption = editingDocument?.document_option;
  const selectedType = form.document_option
    ? `custom-${form.document_option}`
    : [...checklistTypes, extraSavedType].includes(form.document_type) ? form.document_type : "";
  const fields = documentFieldRules(selectedType, form.certificate_type);
  const newEvidence = !editingDocument || savedType !== selectedType || Boolean(form.file)
    || (form.file_url || "") !== (editingDocument.file_url || "");
  const issueRequired = Boolean(fields.issue && (newEvidence || editingDocument?.issue_date));
  const expiryRequired = Boolean(fields.expiry && (newEvidence || editingDocument?.expiry_date
    || (selectedType === "Certificates" && form.certificate_type !== editingDocument?.certificate_type)));
  const load = async () => { setError(""); try { const data = await api(`/documents/employee-summary/?page=${pagination.page}&page_size=25&q=${encodeURIComponent(searchQuery)}&status=${status}`); setItems(data.results); setPagination(data.pagination); } catch (err) { setError(err.message); } };
  useEffect(() => { load(); api("/employees/?status=ACTIVE").then(setEmployees).catch(() => {}); }, [pagination.page, searchQuery, status]);
  const loadOptions = async () => {
    setOptionsError("");
    try { setDocumentOptions(await api("/document-options/", { silentLoading: true, silentError: true })); }
    catch (err) { setOptionsError(err.message); }
  };
  useEffect(() => { loadOptions(); }, []);
  const optionChanged = (option) => {
    setDocumentOptions((current) => [...current.filter((item) => item.id !== option.id), option].sort((a, b) => a.name.localeCompare(b.name)));
    load();
  };
  const selectDocumentType = (value) => {
    const option = customChoices.find((item) => `custom-${item.id}` === value);
    setForm({ ...form, document_option: option?.id ?? null, document_type: option ? "" : value });
  };
  const runSearch = (event) => { event?.preventDefault(); setPagination((current) => ({ ...current, page: 1 })); setSearchQuery(searchInput); };
  const openNewDocument = (employeeId = "") => { setEditingDocument(null); setForm({ ...empty, employee: String(employeeId || "") }); setOpen(true); };
  const save = async (event) => {
    event.preventDefault();
    if (!selectedType) return;
    setError("");
    const data = new FormData();
    for (const field of Object.keys(empty)) {
      if (form.document_option && field === "document_type") continue;
      if (selectedType !== "Certificates" && (field === "certificate_type" || field === "certificate_name")) continue;
      const value = form[field] ?? "";
      if (editingDocument && field !== "file") {
        if (String(value) !== String(editingDocument[field] ?? "")) data.set(field, value);
      } else if (value !== "") {
        data.set(field, value);
      }
    }
    if (form.document_option && !editingDocument) data.set("document_option", form.document_option);
    try {
      await api(`/documents/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: data });
      setOpen(false);
      setEditingDocument(null);
      setForm(empty);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };
  const remove = async (id) => { if (!confirm("Delete this document record?")) return; try { await api(`/documents/${id}/`, { method: "DELETE" }); setSelectedDocuments((current) => new Set([...current].filter((selectedId) => selectedId !== id))); await load(); } catch (err) { setError(err.message); } };
  const review = async (item, action) => { let reason = ""; if (action === "reject") { reason = prompt(`Why should ${item.document_label || item.document_type} be rejected?`, "") || ""; if (!reason.trim()) return; } try { await api(`/documents/${item.id}/${action}/`, { method: "POST", body: JSON.stringify(action === "reject" ? { reason } : {}) }); await load(); } catch (err) { setError(err.message); } };
  const retryDriveUpload = async (id) => {
    const uploaded = await api(`/documents/${id}/sync-drive/`, {
      method: "POST", silentLoading: true, silentToast: true, silentError: true,
    });
    setItems((current) => current.map((employee) => employee.employee !== uploaded.employee ? employee : {
      ...employee,
      documents: employee.documents.map((document) => document.id === id ? uploaded : document),
    }));
    notifyToast("Document uploaded to Google Drive.", "success");
  };
  const fileHref = (item) => item.secure_file_url || (item.file ? absoluteFileUrl(item.file) : item.file_url);
  const updateSelection = (ids, checked) => {
    const next = new Set(selectedDocuments);
    for (const id of ids) checked ? next.add(id) : next.delete(id);
    if (next.size > 100) { setZipError("Select up to 100 uploaded files per ZIP."); return; }
    setZipError("");
    setSelectedDocuments(next);
  };
  const clearSelection = () => { setSelectedDocuments(new Set()); setZipError(""); };
  const toggleEmployee = (id) => {
    if (zipBusy) return;
    clearSelection();
    setExpandedId(expandedId === id ? null : id);
  };
  const downloadZip = async (guardName, ids) => {
    const safeName = guardName.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/^[. ]+|[. ]+$/g, "") || "Guard";
    const reserved = /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[0-9¹²³])(?:\.|$)/i.test(safeName);
    const filename = `${reserved ? "_" : ""}${safeName}.zip`;
    setZipBusy(true);
    setZipError("");
    try {
      await downloadFile("/documents/download-zip/", filename, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: ids }),
      });
    } catch (err) { setZipError(err.message); }
    finally { setZipBusy(false); }
  };
  const archiveSelection = isOfficeAdmin ? {
    selected: selectedDocuments, busy: zipBusy, error: zipError,
    update: updateSelection, clear: clearSelection, download: downloadZip,
  } : null;
  return <><div className="page-heading"><div><p className="eyebrow">COMPLIANCE</p><h2>Employee documents</h2><p className="muted">Search 500+ employees quickly and review critical documents before rota assignment.</p></div><div className="page-heading-actions">{isOfficeAdmin && <button className="secondary-button" aria-expanded={managingOptions} onClick={() => { setManagingOptions(!managingOptions); if (!managingOptions && documentOptions === null && optionsError) loadOptions(); }}>Manage document options</button>}<button className="secondary-button" onClick={() => onNavigate("employees")}><UserPlus size={14} /> Add employee</button><button className="primary-button" onClick={() => openNewDocument()}><Upload size={14} /> Add document</button></div></div>{error && <p className="error page-error">{error}</p>}{isOfficeAdmin && managingOptions && (documentOptions ? <DocumentOptions api={api} options={documentOptions} onChange={optionChanged} /> : <section className="panel document-options-panel">{optionsError ? <><p className="error" role="alert">{optionsError}</p><button className="secondary-button" onClick={loadOptions}>Try again</button></> : <p role="status">Loading document options…</p>}</section>)}{isOfficeAdmin && <GoogleDriveConnection connection={driveConnection} setConnection={setDriveConnection} />}<section className="panel"><form className="document-toolbar" onSubmit={runSearch}><div className="search-box"><Search size={17} /><input placeholder="Search name or employee ID..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} /></div><select value={status} onChange={(e) => { setStatus(e.target.value); setPagination((current) => ({ ...current, page: 1 })); }}><option value="ALL">All compliance</option><option value="REVIEW_REQUIRED">Needs review</option><option value="REJECTED">Rejected</option><option value="NO_DOCUMENTS">Missing documents</option><option value="EXPIRED">Expired</option><option value="EXPIRING_SOON">Expiring soon</option><option value="VALID">Fully valid</option></select><button className="secondary-button" type="submit">Search</button><span className="muted">{pagination.total_employees} employees</span></form>{items.length === 0 ? <div className="empty-state"><FileText size={30} /><strong>No employees found</strong><span>Try changing the search or compliance filter.</span></div> : <div className="table-wrap employee-documents-scroll"><table className="employee-document-table"><thead><tr><th>Employee</th><th>Employee status</th><th>Documents</th><th>Compliance</th><th>Nearest expiry</th><th>Overall status</th><th>Action</th></tr></thead><tbody>{items.map((employee) => <EmployeeDocumentRow key={employee.employee} employee={employee} expanded={expandedId === employee.employee} onToggle={() => toggleEmployee(employee.employee)} onAddDocument={openNewDocument} onEdit={(item) => { setEditingDocument(item); setForm({ ...item, employee: String(item.employee), file: null }); setOpen(true); }} onDelete={remove} onReview={review} fileHref={fileHref} archiveSelection={archiveSelection} showDriveStatus={isOfficeAdmin} driveRootId={driveConnection?.root_folder_id} onDriveRetry={retryDriveUpload} />)}</tbody></table></div>}<div className="pagination-bar"><span>Page {pagination.page} of {pagination.total_pages || 1}</span><div><button className="secondary-button" disabled={!pagination.has_previous} onClick={() => setPagination((current) => ({ ...current, page: current.page - 1 }))}>Previous</button><button className="secondary-button" disabled={!pagination.has_next} onClick={() => setPagination((current) => ({ ...current, page: current.page + 1 }))}>Next</button></div></div></section>{open && <div className="modal-backdrop"><form className="modal-card" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EDIT RECORD" : "NEW RECORD"}</p><h3>{editingId ? "Edit" : "Add"} document</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Employee<select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}><option value="">Select employee</option>{missingEmployee && <option value={editingDocument.employee}>{editingDocument.employee_name}</option>}{uniqueEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label><label>Document type
      <select required value={selectedType} disabled={Boolean(savedOption)} onChange={(event) => selectDocumentType(event.target.value)}>
        <option value="">Select document type</option>
        <optgroup label="Required documents">
          {requiredTypes.map((type) => <option value={type} key={type}>{type}</option>)}
          {!editingDocument && customChoices.filter((option) => option.required).map((option) => <option value={`custom-${option.id}`} key={option.id}>{option.name}</option>)}
        </optgroup>
        <optgroup label="Optional documents">
          {optionalTypes.map((type) => <option value={type} key={type}>{type}</option>)}
          {!editingDocument && customChoices.filter((option) => !option.required).map((option) => <option value={`custom-${option.id}`} key={option.id}>{option.name}</option>)}
        </optgroup>
        {savedOption ? <option value={`custom-${savedOption}`}>{editingDocument.document_label}</option> : extraSavedType && <optgroup label="Saved document type"><option value={extraSavedType}>{extraSavedType}</option></optgroup>}
      </select>
    </label>{form.document_type === "Certificates" && <><label>Certificate type<select required value={form.certificate_type || ""} onChange={(event) => setForm({ ...form, certificate_type: event.target.value })}><option value="">Select certificate type</option>{certificateTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{form.certificate_type === "OTHER" && <label>Certificate name<input required maxLength={160} value={form.certificate_name || ""} onChange={(event) => setForm({ ...form, certificate_name: event.target.value })} /></label>}</>}<label>{fields.code ? "Code / number" : fields.number ? "Card number" : "Document number"}<input maxLength={100} value={form.document_number || ""} onChange={(e) => setForm({ ...form, document_number: e.target.value })} /></label><label>{issueRequired ? "Issue date" : "Issue date (optional)"}<input type="date" required={issueRequired} value={form.issue_date || ""} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} /></label><label>{expiryRequired ? "Expiry date" : "Expiry date (optional)"}<input type="date" required={expiryRequired} value={form.expiry_date || ""} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} /></label><label>Secure file URL<input type="url" value={form.file_url || ""} onChange={(e) => setForm({ ...form, file_url: e.target.value })} placeholder="https://..." /></label><label className="full-width"><span>{editingDocument?.file ? "Replace uploaded file (optional)" : "Upload document"} <Upload size={14} /></span><input type="file" accept={fields.photo ? ".jpg,.jpeg,.png,.webp" : ".pdf,.jpg,.jpeg,.png,.webp"} onChange={(e) => setForm({ ...form, file: e.target.files?.[0] || null })} /></label><label className="full-width">Notes<textarea value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label></div>{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button">Save document</button></div></form></div>}</>;
}

function TimesheetsPage({ canApprove = true, initialTimesheetId }) {
  const [reviewing, setReviewing] = useState(null);
  const [items, setItems] = useState([]); const [employees, setEmployees] = useState([]); const [sites, setSites] = useState([]); const [open, setOpen] = useState(false); const [error, setError] = useState(""); const empty = { employee: "", site: "", work_date: todayIso(), scheduled_start: "07:00", scheduled_end: "19:00", actual_start: "", actual_end: "", overtime_minutes: 0, notes: "" }; const [form, setForm] = useState(empty);
  const load = () => api("/timesheets/").then((data) => { setItems(data); if (initialTimesheetId) setReviewing(data.find((item) => item.id === initialTimesheetId) || null); }).catch((err) => setError(err.message));
  useEffect(() => { load(); api("/employees/").then(setEmployees).catch(() => {}); api("/sites/").then(setSites).catch(() => {}); }, []);
  const save = async (event) => { event.preventDefault(); setError(""); try { await api("/timesheets/", { method: "POST", body: JSON.stringify({ ...form, employee: Number(form.employee), site: form.site ? Number(form.site) : null, overtime_minutes: Number(form.overtime_minutes) }) }); setOpen(false); setForm(empty); load(); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">WORKING HOURS</p><h2>Timesheets</h2><p className="muted">Record scheduled and actual hours for payroll and client summaries.</p></div><button className="primary-button" onClick={() => { setForm(empty); setOpen(true); }}>Add timesheet</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div><h3>Timesheet entries</h3><p className="muted">Overnight shifts are calculated across midnight.</p></div><div className="row-actions"><span className="muted">{items.length} records</span><CheckUpdatesButton api={api} paths="/timesheets/" currentData={items} onUpdate={setItems} setError={setError} /></div></div>{items.length === 0 ? <div className="empty-state"><Clock3 size={30} /><strong>No timesheets recorded</strong><span>Add completed shift hours to build summaries.</span></div> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>Site</th><th>Scheduled</th><th>Actual</th><th>OT</th><th>Review</th><th>Action</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.work_date}</td><td><strong>{item.employee_name}</strong></td><td>{item.site_name || "Unassigned"}</td><td>{item.scheduled_hours}h</td><td>{item.actual_hours}h</td><td>{item.overtime_minutes} min</td><td><span className={`status-pill ${item.approved ? "active" : "pending"}`}>{item.approved ? "Approved" : item.review_flags?.length ? "Review required" : "Draft"}</span></td><td><button type="button" className="mini-button" onClick={() => setReviewing(item)}>{item.approved ? "View record" : "Review"}</button></td></tr>)}</tbody></table></div>}</section>{open && <div className="modal-backdrop"><form className="modal-card" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">NEW ENTRY</p><h3>Add timesheet</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Employee<select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}><option value="">Select employee</option>{employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label><label>Site<select value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })}><option value="">Unassigned</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label><label>Work date<input required type="date" value={form.work_date} onChange={(e) => setForm({ ...form, work_date: e.target.value })} /></label><label>Overtime minutes<input min="0" type="number" value={form.overtime_minutes} onChange={(e) => setForm({ ...form, overtime_minutes: e.target.value })} /></label><label>Scheduled start<input type="time" value={form.scheduled_start} onChange={(e) => setForm({ ...form, scheduled_start: e.target.value })} /></label><label>Scheduled end<input type="time" value={form.scheduled_end} onChange={(e) => setForm({ ...form, scheduled_end: e.target.value })} /></label><label>Actual start<input type="time" value={form.actual_start} onChange={(e) => setForm({ ...form, actual_start: e.target.value })} /></label><label>Actual end<input type="time" value={form.actual_end} onChange={(e) => setForm({ ...form, actual_end: e.target.value })} /></label><label className="full-width">Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label></div>{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button">Save timesheet</button></div></form></div>}{reviewing && <TimesheetReview sheet={reviewing} canApprove={canApprove} api={api} FilePreview={ProtectedFilePreview} onClose={() => setReviewing(null)} onApproved={(result) => { setItems((current) => current.map((item) => item.id === result.id ? result : item)); setReviewing(result); }} />}</>;
}


function ReportsPage() {
  const monday = toMonday(ukDate()); const [startDate, setStartDate] = useState(monday); const [endDate, setEndDate] = useState(addDays(monday, 6)); const [report, setReport] = useState(null); const [error, setError] = useState("");
  const rangeValid = Boolean(startDate && endDate && startDate <= endDate);
  const openPrint = async () => { try { const token = getToken(); const response = await fetch(`${API_BASE}/exports/report-print/?start_date=${startDate}&end_date=${endDate}`, { headers: { Authorization: `Token ${token}` } }); if (!response.ok) throw new Error("Report could not be opened. Check your access and selected dates."); const html = await response.text(); const printWindow = window.open("", "_blank"); if (printWindow) { printWindow.document.write(html); printWindow.document.close(); } } catch (err) { setError(err.message); } };
  useEffect(() => { let active = true; if (!startDate || !endDate || startDate > endDate) { setError("Choose a valid date range."); setReport(null); return; } setError(""); setReport(null); api(`/reports/summary/?start_date=${startDate}&end_date=${endDate}`, { silentLoading: true, silentError: true }).then((value) => { if (active) setReport(value); }).catch((err) => { if (active) setError(err.message); }); return () => { active = false; }; }, [startDate, endDate]);
  return <><div className="page-heading"><div><p className="eyebrow">INSIGHTS</p><h2>Reports</h2><p className="muted">Review working hours, leave activity and compliance alerts.</p></div><div className="report-filters"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /><span>to</span><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /><button className="secondary-button" disabled={!rangeValid} onClick={() => downloadFile(`/exports/timesheets.csv?start_date=${startDate}&end_date=${endDate}`, "timesheets.csv").catch((err) => setError(err.message))}><Download size={14} /> CSV</button><button className="secondary-button" disabled={!rangeValid} onClick={openPrint}>Print / PDF</button><CheckUpdatesButton className="primary-button" disabled={!rangeValid} api={api} paths={`/reports/summary/?start_date=${startDate}&end_date=${endDate}`} currentData={report} onUpdate={setReport} setError={setError} /></div></div>{error && <p className="error page-error">{error}</p>}{report && <><section className="stats-grid"><StatCard label="Total actual hours" value={`${report.total_hours}h`} detail={`${report.timesheet_count} timesheet entries`} icon={Clock3} tone="blue" /><StatCard label="Overtime" value={`${Math.round(report.overtime_minutes / 60 * 10) / 10}h`} detail={`${report.overtime_minutes} minutes`} icon={BarChart3} tone="amber" /><StatCard label="Approved leave" value={report.approved_leave_records} detail="Records in selected period" icon={CalendarDays} tone="teal" /><StatCard label="Expiring documents" value={report.documents_expiring_soon} detail="Next 30 days" icon={FileText} tone="rose" /></section><section className="content-grid"><article className="panel"><div className="panel-header"><div><h3>Hours by employee</h3><p className="muted">Actual hours for selected period.</p></div></div>{report.employee_hours.length ? <div className="report-list">{report.employee_hours.map((row) => <div className="report-line" key={row.name}><strong>{row.name}</strong><span>{row.hours}h</span></div>)}</div> : <div className="empty-state">No hours in this period.</div>}</article><article className="panel"><div className="panel-header"><div><h3>Hours by site</h3><p className="muted">Client/site operational totals.</p></div></div>{report.site_hours.length ? <div className="report-list">{report.site_hours.map((row) => <div className="report-line" key={row.name}><strong>{row.name}</strong><span>{row.hours}h</span></div>)}</div> : <div className="empty-state">No site hours in this period.</div>}</article></section></>}</>;
}

function ArrivalReportPage({ canRegenerate = false }) {
  const monday = toMonday(ukDate());
  const [startDate, setStartDate] = useState(monday);
  const [endDate, setEndDate] = useState(addDays(monday, 6));
  const [report, setReport] = useState(null);
  const [savedReports, setSavedReports] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(null);
  const rangeRef = useRef("");
  const regenerationPending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  rangeRef.current = `${startDate}:${endDate}`;
  const rangeValid = Boolean(startDate && endDate && startDate <= endDate);
  useEffect(() => {
    let active = true;
    if (!rangeValid) { setError("Choose a valid date range. End date must be on or after start date."); setReport(null); setSavedReports([]); setLoading(false); return; }
    setLoading(true); setError("");
    Promise.all([api(`/reports/summary/?start_date=${startDate}&end_date=${endDate}`, { silentLoading: true, silentError: true }), api(`/arrival-reports/?start_date=${startDate}&end_date=${endDate}`, { silentLoading: true, silentError: true })])
      .then(([summary, reports]) => { if (active) { setReport(summary); setSavedReports(reports); } })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [startDate, endDate, rangeValid]);
  const regenerate = async (saved) => {
    if (regenerationPending.current) return;
    regenerationPending.current = true;
    const requestedRange = rangeRef.current;
    setRegenerating(saved.id); setError("");
    try {
      const updated = await api(`/arrival-reports/${saved.id}/regenerate/`, { method: "POST", body: "{}", silentLoading: true, silentError: true, silentToast: true });
      if (mounted.current && rangeRef.current === requestedRange) {
        setSavedReports((items) => items.map((item) => item.id === updated.id ? updated : item));
        notifyToast("PDF updated with current guard records, requirements and UK times. Open PDF to view it.");
      }
    } catch (err) { if (mounted.current && rangeRef.current === requestedRange) { setError(err.message); notifyToast(err.message, "error"); } }
    finally { regenerationPending.current = false; if (mounted.current) setRegenerating(null); }
  };
  return <><div className="page-heading"><div><p className="eyebrow">SITE ATTENDANCE</p><h2>Reached at site</h2><p className="muted">Track assigned guard arrivals and delays. All times shown in Europe/London (GMT/BST).</p></div><div className="report-filters"><input type="date" aria-label="Arrival report start date" disabled={regenerating != null} value={startDate} onChange={(e) => setStartDate(e.target.value)} /><span>to</span><input type="date" aria-label="Arrival report end date" disabled={regenerating != null} value={endDate} onChange={(e) => setEndDate(e.target.value)} /><CheckUpdatesButton key={regenerating == null ? "ready" : `pdf-${regenerating}`} className="primary-button" disabled={loading || !rangeValid || regenerating != null} api={api} paths={[`/reports/summary/?start_date=${startDate}&end_date=${endDate}`, `/arrival-reports/?start_date=${startDate}&end_date=${endDate}`]} currentData={[report, savedReports]} onUpdate={([summary, reports]) => { setReport(summary); setSavedReports(reports); }} setError={setError} /></div></div>{error && <p className="error page-error">{error}</p>}{loading && <p className="muted" role="status">Loading selected arrival dates…</p>}{report && <ReachedReport report={report} StatCard={StatCard} />}<section className="panel saved-reports"><div className="panel-header"><div><h3>Saved daily PDFs</h3><p className="muted">Saved files reflect their generation time. Update PDF to rebuild a file using current records; then Open PDF. Live totals are shown above.</p></div><span className="muted">{savedReports.length} files</span></div>{savedReports.length ? <div className="saved-report-list">{savedReports.map((saved) => <div className="saved-report-row" key={saved.id}><div><strong>{saved.report_date} · {saved.shift_name}</strong><small>{saved.scheduled_count} scheduled · {saved.reached_count} reached · {saved.late_count} late · generated {formatUkDateTime(saved.generated_at)}</small></div><div className="saved-report-actions">{canRegenerate && <button type="button" className="mini-button" disabled={regenerating != null || loading} onClick={() => regenerate(saved)}>{regenerating === saved.id ? "Updating PDF…" : "Update PDF"}</button>}<button type="button" className="mini-button" disabled={regenerating != null || !saved.pdf_url} onClick={() => openProtectedFile(saved.pdf_url, "Report PDF").catch((err) => setError(err.message))}>Open PDF</button></div></div>)}</div> : <div className="empty-state compact-empty">No saved PDFs for this date range yet. Sync daily operations from Weekly Rota to generate them.</div>}</section></>;
}

function OperationsPage({ canEdit = true, canTrack = true }) {
  return <DailyOperationsPage api={api} StatCard={StatCard} FilePreview={ProtectedFilePreview} notify={notifyToast} canEdit={canEdit} canTrack={canTrack} />;
}

function EmployeeAttendancePageGpsFirst() {
  const [date, setDate] = useState(todayIso()); const [items, setItems] = useState([]); const [photoFiles, setPhotoFiles] = useState({}); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const selectedDateRef = useRef(date);
  selectedDateRef.current = date;
  const load = async () => {
    const requestedDate = date;
    if (!requestedDate) { setItems([]); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const selected = await api(`/operations/?operation_date=${requestedDate}`);
      if (selectedDateRef.current === requestedDate) setItems(selected);
    } catch (err) {
      if (selectedDateRef.current === requestedDate) setError(err.message);
    } finally {
      if (selectedDateRef.current === requestedDate) setLoading(false);
    }
  };
  useEffect(() => { load(); }, [date]);
  const submitAttendance = async (item, eventType) => { const photo = photoFiles[item.id]; const location = locations[item.id]; if (!location) { setError("Set GPS location before submitting attendance."); return; } if (!photo) { setError("Take a live picture before submitting attendance."); return; } setSaving(`${item.id}-${eventType}`); setError(""); setNotice(""); try { const payload = new FormData(); payload.append("event_type", eventType); payload.append("photo", photo); payload.append("latitude", location.latitude); payload.append("longitude", location.longitude); payload.append("accuracy_m", location.accuracy); await api(`/operations/${item.id}/attendance/`, { method: "POST", body: payload }); setPhotoFiles((current) => ({ ...current, [item.id]: null })); setNotice(`${eventType === "BOOK_ON" ? "Book On" : eventType === "BOOK_OFF" ? "Book Off" : "Hourly check-in"} submitted successfully.`); await load(); } catch (err) { setError(err.message); } finally { setSaving(""); } };
  const eventsFor = (item) => item.attendance_events || []; const hasEvent = (item, type) => eventsFor(item).some((event) => event.event_type === type); const hourlyCount = (item) => eventsFor(item).filter((event) => event.event_type === "HOURLY").length; const eventTime = (item, type) => { const event = eventsFor(item).find((entry) => entry.event_type === type); return event ? new Date(event.captured_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"; };
  return <><div className="page-heading"><div><p className="eyebrow">GUARD ATTENDANCE</p><h2>My attendance</h2><p className="muted">Set GPS first, then submit a live photo when you arrive, every hour and when you finish.</p></div><div className="report-filters"><input type="date" value={date} aria-label="Attendance date" onChange={(e) => { setItems([]); setDate(e.target.value); }} /><CheckUpdatesButton api={api} paths={`/operations/?operation_date=${date}`} currentData={items} onUpdate={setItems} setError={setError} disabled={!date || loading || Boolean(saving)} /></div></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}<section className="panel attendance-instructions"><div><strong>How it works</strong><span>1) Set GPS location  2) Take live photo  3) Book On, hourly check-in or Book Off. The server records the timestamp.</span></div><small>Only submit while you are on the assigned shift.</small></section>{loading ? <div className="empty-view"><h2>Loading shifts...</h2></div> : items.length ? <section className="attendance-shift-list">{items.map((item) => { const on = hasEvent(item, "BOOK_ON"); const off = hasEvent(item, "BOOK_OFF"); const photo = photoFiles[item.id]; const location = locations[item.id]; return <article className="panel attendance-shift-card" key={item.id}><div className="attendance-shift-header"><div><h3>{item.site_name}</h3><p className="muted">{item.operation_date} · {item.shift_name} · starts {String(item.scheduled_start || "").slice(0, 5)}</p></div><span className={`status-pill ${off ? "active" : on ? "present" : "pending"}`}>{off ? "Booked off" : on ? "On duty" : "Not started"}</span></div><div className="attendance-timeline"><span>Book On <strong>{eventTime(item, "BOOK_ON")}</strong></span><span>Hourly photos <strong>{hourlyCount(item)}/{item.expected_hourly_checkins}</strong></span><span>Book Off <strong>{eventTime(item, "BOOK_OFF")}</strong></span></div><div className="attendance-events">{eventsFor(item).map((event) => <span className={`status-pill ${event.location_status.toLowerCase()}`} key={event.id}>{event.event_label} · {event.location_status.replaceAll("_", " ")}</span>)}</div>{!off && <><div className="attendance-actions"><button className={location ? "secondary-button gps-ready" : "secondary-button"} onClick={() => saveLocation(item)}>{location ? "GPS saved · Set again" : "Set GPS location"}</button><small>{location ? `Accuracy ±${Math.round(location.accuracy || 0)}m` : "Required before submitting"}</small></div><label className="attendance-photo-input">Take live photo<input type="file" accept="image/*" capture="environment" onChange={(e) => setPhotoFiles((current) => ({ ...current, [item.id]: e.target.files?.[0] || null }))} /><small>{photo ? photo.name : "Camera photo required"}</small></label><div className="attendance-actions">{!on && <button className="primary-button" disabled={saving === `${item.id}-BOOK_ON`} onClick={() => submitAttendance(item, "BOOK_ON")}>{saving === `${item.id}-BOOK_ON` ? "Submitting..." : "Book On"}</button>}{on && <button className="secondary-button" disabled={saving === `${item.id}-HOURLY`} onClick={() => submitAttendance(item, "HOURLY")}>{saving === `${item.id}-HOURLY` ? "Submitting..." : `Submit hourly check-in #${hourlyCount(item) + 1}`}</button>}{on && <button className="secondary-button attendance-off-button" disabled={saving === `${item.id}-BOOK_OFF`} onClick={() => submitAttendance(item, "BOOK_OFF")}>{saving === `${item.id}-BOOK_OFF` ? "Submitting..." : "Book Off"}</button>}</div></>}</article>; })}</section> : <section className="panel empty-state"><ClipboardList size={30} /><strong>No assigned shifts</strong><span>Your published shifts for this date will appear here.</span></section>}</>;
}

function EmployeeAttendancePage({ initialDate, initialOperationId } = {}) {
  const [date, setDate] = useState(initialDate || ukDate());
  const [items, setItems] = useState([]);
  const [photoFiles, setPhotoFiles] = useState({});
  const [loading, setLoading] = useState(true);
  useEffect(() => { if (initialOperationId && !loading) document.getElementById(`guard-operation-${initialOperationId}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [loading, initialOperationId]);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [locations, setLocations] = useState({});
  const [photoCapturedAt, setPhotoCapturedAt] = useState({});
  const [hourlyReasons, setHourlyReasons] = useState({});
  const [bookOnReasons, setBookOnReasons] = useState({});
  const [lateBookOnRequired, setLateBookOnRequired] = useState({});
  const [clock, setClock] = useState(Date.now);
  const [reasonSaving, setReasonSaving] = useState("");
  const [cameraOpen, setCameraOpen] = useState(null);
  const [cameraFacing, setCameraFacing] = useState("environment");
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [attendanceIssue, setAttendanceIssue] = useState(null);
  const reportError = (message, operationId = null) => {
    setError(message);
    setAttendanceIssue(message && operationId ? { operationId, message } : null);
    if (message) { setNotice(""); notifyToast(message, "error"); }
  };
  const selectedDateRef = useRef(date);
  selectedDateRef.current = date;
  const load = async () => {
    const requestedDate = date;
    if (!requestedDate) { setItems([]); setLoading(false); return; }
    setLoading(true); reportError("");
    try {
      const selected = await api(`/operations/?operation_date=${requestedDate}`);
      if (selectedDateRef.current === requestedDate) setItems(selected);
    } catch (err) {
      if (selectedDateRef.current === requestedDate) reportError(err.message);
    } finally {
      if (selectedDateRef.current === requestedDate) setLoading(false);
    }
  };
  useEffect(() => { load(); }, [date]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 15000); return () => window.clearInterval(timer); }, []);
  const stopCamera = () => { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; setCameraOpen(null); };
  useEffect(() => () => stopCamera(), []);
  useEffect(() => { if (cameraOpen && videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current; }, [cameraOpen]);
  const startCamera = async (itemId, facing = cameraFacing) => { reportError(""); if (!navigator.mediaDevices?.getUserMedia) { reportError("Camera access is unavailable. Open the secure HTTPS portal on a device with a camera."); return; } try { streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false }); setCameraFacing(facing); setCameraOpen(itemId); } catch { reportError(`${facing === "user" ? "Front" : "Back"} camera is unavailable or permission was denied. Allow camera access and try again.`); } };
  const openCamera = (itemId) => startCamera(itemId, cameraFacing);
  const switchCamera = async () => { if (!cameraOpen) return; const nextFacing = cameraFacing === "environment" ? "user" : "environment"; const itemId = cameraOpen; stopCamera(); await startCamera(itemId, nextFacing); };
  const capturePhoto = (itemId) => { const video = videoRef.current; const canvas = canvasRef.current; if (!video || !canvas || !video.videoWidth) { reportError("Camera is still starting. Try again in a moment."); return; } canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height); canvas.toBlob((blob) => { if (!blob) return; setPhotoFiles((current) => ({ ...current, [itemId]: new File([blob], `live-attendance-${itemId}-${Date.now()}.jpg`, { type: "image/jpeg" }) })); setPhotoCapturedAt((current) => ({ ...current, [itemId]: new Date().toISOString() })); stopCamera(); }, "image/jpeg", 0.88); };
  const saveLocation = async (item) => { reportError(""); try { const location = await readCurrentLocation(); const geofenceError = attendanceGeofenceIssue(item, location); if (geofenceError) { setLocations((current) => ({ ...current, [item.id]: null })); if (geofenceError.includes("outside")) window.dispatchEvent(new CustomEvent("rota:geofence-outside", { detail: { operation_id: item.id, site_name: item.site_name, site_address: item.site_address, site_geofence_radius_m: item.site_geofence_radius_m } })); throw new Error(geofenceError); } setLocations((current) => ({ ...current, [item.id]: location })); setNotice("GPS location saved for this shift."); } catch (geoError) { reportError(geoError.message, item.id); } };
  const submitAttendance = async (item, eventType, sequence) => { if (item.attendance_status === "BOOKED_OFF") { reportError("This shift is completed. Attendance is closed.", item.id); return; } const photo = photoFiles[item.id]; const lateReason = (bookOnReasons[item.id] ?? item.attendance_events?.find((event) => event.event_type === "BOOK_ON")?.late_reason ?? "").trim(); if (eventType === "BOOK_ON" && (lateBookOnRequired[item.id] || bookOnIsLate(item)) && !lateReason) { setLateBookOnRequired((current) => ({ ...current, [item.id]: true })); reportError("Please enter a reason for late Book On before submitting.", item.id); return; } if (!locations[item.id]) { reportError(`Set your GPS location before submitting ${eventType === "BOOK_ON" ? "Book On" : eventType === "BOOK_OFF" ? "Book Off" : "the hourly picture"}.`, item.id); return; } if (!photo) { reportError("Please take a live photo before submitting.", item.id); return; } setSaving(`${item.id}-${eventType}`); reportError(""); setNotice(""); try { const location = await readCurrentLocation(); const geofenceError = attendanceGeofenceIssue(item, location); if (geofenceError) { setLocations((current) => ({ ...current, [item.id]: null })); if (geofenceError.includes("outside")) window.dispatchEvent(new CustomEvent("rota:geofence-outside", { detail: { operation_id: item.id, site_name: item.site_name, site_address: item.site_address, site_geofence_radius_m: item.site_geofence_radius_m } })); throw new Error(geofenceError); } setLocations((current) => ({ ...current, [item.id]: location })); const payload = new FormData(); payload.append("event_type", eventType); if (eventType === "HOURLY") payload.append("sequence", sequence); if (eventType === "BOOK_ON") payload.append("late_reason", lateReason); payload.append("photo", photo); payload.append("latitude", location.latitude); payload.append("longitude", location.longitude); payload.append("accuracy_m", location.accuracy ?? ""); const result = await api(`/operations/${item.id}/attendance/`, { method: "POST", body: payload, silentToast: true, silentError: true }); setItems((current) => current.map((entry) => entry.id === item.id ? result.operation : entry)); if (eventType === "BOOK_OFF") { stopCamera(); setLocations((current) => ({ ...current, [item.id]: null })); } setPhotoFiles((current) => ({ ...current, [item.id]: null })); setPhotoCapturedAt((current) => ({ ...current, [item.id]: null })); const message = eventType === "BOOK_OFF" ? "Shift completed successfully. Your draft timesheet is ready for office review." : `${eventType === "BOOK_ON" ? "Book On" : "Hourly check-in"} submitted with current GPS location.`; setNotice(message); notifyToast(message); } catch (err) { if (eventType === "BOOK_ON" && /late Book On/i.test(err.message)) setLateBookOnRequired((current) => ({ ...current, [item.id]: true })); reportError(err.message, item.id); } finally { setSaving(""); } };
  const saveHourlyReason = async (item, sequence, existingReason = "") => { const reason = (hourlyReasons[`${item.id}-${sequence}`] ?? existingReason).trim(); if (!reason) { reportError("Please enter a reason for the missed hourly picture.", item.id); return; } setReasonSaving(`${item.id}-${sequence}`); reportError(""); setNotice(""); try { await api(`/operations/${item.id}/hourly-note/`, { method: "POST", body: JSON.stringify({ sequence, reason }), silentError: true }); setNotice(`Reason saved for hourly check-in ${sequence}.`); await load(); } catch (err) { reportError(err.message, item.id); } finally { setReasonSaving(""); } };
  const saveBookOnReason = async (item, existingReason = "") => {
    const reason = (bookOnReasons[item.id] ?? existingReason).trim();
    if (!reason) { reportError("Please enter a reason for late Book On.", item.id); return; }
    setReasonSaving(`book-on-${item.id}`); reportError(""); setNotice("");
    try {
      const result = await api(`/operations/${item.id}/book-on-note/`, { method: "POST", body: JSON.stringify({ reason }), silentError: true });
      setItems((current) => current.map((entry) => entry.id === item.id ? result.operation : entry));
      setBookOnReasons((current) => ({ ...current, [item.id]: result.event.late_reason }));
      setNotice("Late Book On reason saved for office review.");
    } catch (err) { reportError(err.message, item.id); } finally { setReasonSaving(""); }
  };
  const saveBookOffReason = async (item, existingReason = "") => { const reason = (hourlyReasons[`book-off-${item.id}`] ?? existingReason).trim(); if (!reason) { reportError("Please enter a reason for the missed Book Off picture.", item.id); return; } setReasonSaving(`book-off-${item.id}`); reportError(""); setNotice(""); try { await api(`/operations/${item.id}/book-off-note/`, { method: "POST", body: JSON.stringify({ reason }), silentError: true }); setNotice("Reason saved for the missed Book Off picture."); await load(); } catch (err) { reportError(err.message, item.id); } finally { setReasonSaving(""); } };
  const eventsFor = (item) => item.attendance_events || [];
  const hasEvent = (item, type) => eventsFor(item).some((event) => event.event_type === type);
  const hourlyCount = (item) => eventsFor(item).filter((event) => event.event_type === "HOURLY").length;
  const eventTime = (item, type) => { const event = eventsFor(item).find((entry) => entry.event_type === type); return event ? formatUkAttendanceTime(event.captured_at) : "—"; };
  const formatCapturedAt = (value) => value ? new Date(value).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }) : "—";
  const locationLabel = (event) => event && event.latitude !== null && event.longitude !== null ? `${Number(event.latitude).toFixed(6)}, ${Number(event.longitude).toFixed(6)}` : "Not recorded";
  const formatWindow = formatUkAttendanceTime;
  const renderPhotoLink = (url, label = "View picture") => url ? <ProtectedFilePreview value={url} label="Attendance picture" buttonLabel={label} /> : null;
  const locationMapUrl = (location, item) => { if (!location) return ""; const lat = Number(location.latitude); const lon = Number(location.longitude); if (!Number.isFinite(lat) || !Number.isFinite(lon)) return ""; const siteLat = Number(item.site_latitude); const siteLon = Number(item.site_longitude); const points = [[lat, lon]]; if (Number.isFinite(siteLat) && Number.isFinite(siteLon)) points.push([siteLat, siteLon]); const lats = points.map(([pointLat]) => pointLat); const lons = points.map(([, pointLon]) => pointLon); const padding = Math.max(0.002, Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons)) * 0.35); const bbox = [Math.min(...lons) - padding, Math.min(...lats) - padding, Math.max(...lons) + padding, Math.max(...lats) + padding].map((value) => value.toFixed(6)).join(","); return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat},${lon}`; };

  return <><div className="page-heading"><div><p className="eyebrow">GUARD ATTENDANCE</p><h2>My attendance</h2><p className="muted">Follow the attendance steps selected for each site.</p></div><div className="report-filters"><input type="date" value={date} aria-label="Attendance date" onChange={(e) => { setItems([]); setDate(e.target.value); }} /><CheckUpdatesButton api={api} paths={`/operations/?operation_date=${date}`} currentData={items} onUpdate={setItems} setError={setError} disabled={!date || loading || Boolean(saving)} /></div></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}<section className="panel attendance-instructions"><div><strong>Attendance flow</strong><span>Book On at arrival → complete any hourly pictures required by your site → Book Off at shift end.</span></div><small>Each hourly picture has a full 1-hour window. A missed-picture reason becomes available after that hour expires. Times shown in Europe/London (GMT/BST).</small></section>{loading ? <div className="empty-view"><h2>Loading shifts...</h2></div> : items.length ? <section className="attendance-shift-list">{items.map((item) => { const on = hasEvent(item, "BOOK_ON"); const off = hasEvent(item, "BOOK_OFF"); const photo = photoFiles[item.id]; const location = locations[item.id]; const liveCapturedAt = photoCapturedAt[item.id]; const checkins = hourlyCheckinsFor(item); const nextHourly = checkins.find((checkin) => checkin.status === "AVAILABLE"); const bookOnEvent = eventsFor(item).find((event) => event.event_type === "BOOK_ON"); const lateBookOn = bookOnIsLate(item, clock) || (!on && lateBookOnRequired[item.id]); const bookOffEvent = eventsFor(item).find((event) => event.event_type === "BOOK_OFF"); const lastLocationEvent = [...eventsFor(item)].reverse().find((event) => event.latitude !== null && event.longitude !== null); const mapLocation = location || lastLocationEvent; const mapUrl = locationMapUrl(mapLocation, item); const bookOffStatus = off ? "COMPLETED" : item.book_off_status || (on ? "AVAILABLE" : "UPCOMING"); const bookOffNote = item.book_off_note; const steps = [{ key: "book-on", label: "1. Book On", detail: on ? `Completed at ${eventTime(item, "BOOK_ON")}` : "Take a live picture when you arrive", status: on ? "COMPLETED" : "AVAILABLE", photo_url: bookOnEvent?.photo_url, event: bookOnEvent }, ...checkins.map((checkin) => { const event = eventsFor(item).find((entry) => entry.event_type === "HOURLY" && entry.sequence === checkin.sequence); return { key: `hourly-${checkin.sequence}`, sequence: checkin.sequence, label: `${checkin.sequence + 1}. Hourly picture`, detail: checkin.status === "COMPLETED" ? `Completed at ${formatWindow(checkin.captured_at)}` : checkin.status === "EXPIRED" ? `Missed — window ended ${formatWindow(checkin.deadline_at)}` : `Available ${formatWindow(checkin.due_at)}–${formatWindow(checkin.deadline_at)}`, status: checkin.status, photo_url: checkin.photo_url, missed_reason: checkin.missed_reason, event }; }), { key: "book-off", label: `${checkins.length + 2}. Book Off`, detail: off ? `Completed at ${eventTime(item, "BOOK_OFF")}` : bookOffStatus === "UPCOMING" ? `Available ${formatWindow(item.book_off_due_at)}–${formatWindow(item.book_off_deadline_at)}` : bookOffStatus === "EXPIRED" ? "Missed — reason required" : "Take the final live picture when your shift ends", status: bookOffStatus, photo_url: bookOffEvent?.photo_url, missed_reason: bookOffNote?.reason, event: bookOffEvent }]; return <article className="panel attendance-shift-card" key={item.id} id={`guard-operation-${item.id}`}><div className="attendance-shift-header"><div><h3>{item.site_name}</h3><span className="attendance-mode-chip">{siteAttendanceLabel(item)}</span><small className="table-subtext">GPS required · Stay within {item.site_geofence_radius_m}m of this site.</small><p className="muted">{item.operation_date} · {item.shift_name} · {String(item.scheduled_start || "").slice(0, 5)}–{String(item.scheduled_end || "").slice(0, 5)}</p></div><span className={`status-pill ${off ? "active" : on ? "present" : "pending"}`}>{off ? "Booked off" : on ? "On duty" : "Not started"}</span></div><SiteLocationLinks item={item} />{attendanceIssue?.operationId === item.id && <p className="attendance-action-error" role="alert">{attendanceIssue.message}</p>}{off ? <><ShiftCompletionSummary summary={item.completion_summary} /><CompletedAttendanceHistory item={item} steps={steps} renderPhotoLink={renderPhotoLink} /></> : <div className="attendance-step-list">{steps.map((step, index) => <div className={`attendance-step ${step.status.toLowerCase()}`} key={step.key}><span className="attendance-step-number">{index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small>{step.event && <small className="attendance-photo-meta">Captured {formatCapturedAt(step.event.captured_at)} · GPS {locationLabel(step.event)}</small>}{step.status === "EXPIRED" && step.key.startsWith("hourly-") && <div className="missed-hourly-note"><strong>Why was this hourly picture missed?</strong><textarea rows="2" value={hourlyReasons[`${item.id}-${step.sequence}`] ?? step.missed_reason ?? ""} onChange={(event) => setHourlyReasons((current) => ({ ...current, [`${item.id}-${step.sequence}`]: event.target.value }))} placeholder="Tell the office what happened (for example: site incident, emergency or camera issue)." /><button type="button" className="mini-button" disabled={reasonSaving === `${item.id}-${step.sequence}`} onClick={() => saveHourlyReason(item, step.sequence, step.missed_reason)}>{reasonSaving === `${item.id}-${step.sequence}` ? "Saving reason..." : step.missed_reason ? "Update reason" : "Save reason"}</button>{step.missed_reason && <small className="note-saved-label">Reason saved for office review.</small>}</div>}{step.status === "EXPIRED" && step.key === "book-off" && <div className="missed-hourly-note"><strong>Why was the Book Off picture missed?</strong><textarea rows="2" value={hourlyReasons[`book-off-${item.id}`] ?? step.missed_reason ?? ""} onChange={(event) => setHourlyReasons((current) => ({ ...current, [`book-off-${item.id}`]: event.target.value }))} placeholder="Tell the office why Book Off was late or missed." /><button type="button" className="mini-button" disabled={reasonSaving === `book-off-${item.id}`} onClick={() => saveBookOffReason(item, step.missed_reason)}>{reasonSaving === `book-off-${item.id}` ? "Saving reason..." : step.missed_reason ? "Update reason" : "Save reason"}</button>{step.missed_reason && <small className="note-saved-label">Reason saved for office review.</small>}</div>}{step.key === "book-on" && lateBookOn && <div className="missed-hourly-note late-book-on-note"><strong>Reason for late Book On</strong><p className="muted">Your shift started at {formatWindow(item.book_on_due_at)}. {on ? "The office can review your explanation below." : "Enter a brief reason. It will be saved with your Book On."}</p><textarea rows="2" maxLength={500} aria-label={`Reason for late Book On at ${item.site_name}`} value={bookOnReasons[item.id] ?? bookOnEvent?.late_reason ?? ""} onChange={(event) => setBookOnReasons((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Explain why you arrived late (up to 500 characters)." />{on && <button type="button" className="mini-button" disabled={reasonSaving === `book-on-${item.id}`} onClick={() => saveBookOnReason(item, bookOnEvent?.late_reason || "")}>{reasonSaving === `book-on-${item.id}` ? "Saving reason…" : bookOnEvent?.late_reason ? "Update reason" : "Save reason"}</button>}{on && bookOnEvent?.late_reason && <small className="note-saved-label">Reason saved for office review.</small>}</div>}{step.key === "book-on" && !on && <div className="attendance-stage-controls"><div className="attendance-actions"><button type="button" className={location ? "secondary-button gps-ready" : "secondary-button"} onClick={() => saveLocation(item)}>{location ? "GPS saved · Set again" : "1. Set GPS location"}</button><small>{location ? `Accuracy ±${Math.round(location.accuracy || 0)}m` : "Required before Book On"}</small></div>{photo && <div className="attendance-photo-meta-card"><strong>Live picture ready</strong><span>Captured {formatCapturedAt(liveCapturedAt)}</span>{location && <span>Current location: {locationLabel(location)} · ±{Math.round(location.accuracy || 0)}m</span>}</div>}<button type="button" className="attendance-photo-input" onClick={() => openCamera(item.id)}><Camera size={16} /> <span>2. Take live picture</span><small>{photo ? `Photo ready: ${photo.name}` : "Camera only — gallery upload is disabled"}</small></button><button type="button" className="primary-button" disabled={saving === `${item.id}-BOOK_ON`} onClick={() => submitAttendance(item, "BOOK_ON")}>{saving === `${item.id}-BOOK_ON` ? "Submitting..." : "3. Submit Book On"}</button></div>}{step.key.startsWith("hourly-") && on && step.status === "AVAILABLE" && nextHourly?.sequence === step.sequence && <div className="attendance-stage-controls"><div className="attendance-actions"><button type="button" className={location ? "secondary-button gps-ready" : "secondary-button"} onClick={() => saveLocation(item)}>{location ? "GPS saved · Set again" : "Set GPS location"}</button><small>{location ? `Accuracy ±${Math.round(location.accuracy || 0)}m` : "Required before hourly picture"}</small></div>{photo && <div className="attendance-photo-meta-card"><strong>Live picture ready</strong><span>Captured {formatCapturedAt(liveCapturedAt)}</span></div>}<button type="button" className="attendance-photo-input" onClick={() => openCamera(item.id)}><Camera size={16} /> <span>Take hourly picture</span><small>{photo ? `Photo ready: ${photo.name}` : "Camera only — gallery upload is disabled"}</small></button><button type="button" className="secondary-button" disabled={saving === `${item.id}-HOURLY`} onClick={() => submitAttendance(item, "HOURLY", step.sequence)}>{saving === `${item.id}-HOURLY` ? "Submitting..." : `Submit hourly picture ${step.sequence}`}</button></div>}{step.key === "book-off" && on && !off && <div className="attendance-stage-controls"><div className="attendance-actions"><span className={`status-pill ${bookOffStatus.toLowerCase()}`}>{bookOffStatus === "AVAILABLE" ? "Book Off window open" : bookOffStatus === "EXPIRED" ? "Book Off window expired" : `Available ${formatWindow(item.book_off_due_at)}`}</span><small>{bookOffStatus === "AVAILABLE" ? `Submit before ${formatWindow(item.book_off_deadline_at)}` : "Book Off picture is only accepted at shift end."}</small></div>{bookOffStatus === "AVAILABLE" && <><button type="button" className={location ? "secondary-button gps-ready" : "secondary-button"} onClick={() => saveLocation(item)}>{location ? "GPS saved · Set again" : "Set GPS location"}</button><button type="button" className="attendance-photo-input" onClick={() => openCamera(item.id)}><Camera size={16} /> <span>Take Book Off picture</span><small>{photo ? `Photo ready: ${photo.name}` : "Camera only — gallery upload is disabled"}</small></button><button type="button" className="secondary-button attendance-off-button" disabled={saving === `${item.id}-BOOK_OFF`} onClick={() => submitAttendance(item, "BOOK_OFF")}>{saving === `${item.id}-BOOK_OFF` ? "Submitting..." : "Submit Book Off"}</button></>}</div>}</div><span className="attendance-step-status">{step.status === "COMPLETED" ? "Done" : step.status === "EXPIRED" ? "Missed" : step.status === "AVAILABLE" ? "Ready" : "Upcoming"}</span>{renderPhotoLink(step.photo_url)}</div>)}</div>}{!off && <div className="attendance-events">{eventsFor(item).map((event) => <span className={`attendance-event-chip ${event.location_status.toLowerCase()}`} key={event.id}><span>{event.event_label} · {event.location_status.replaceAll("_", " ")} · {formatCapturedAt(event.captured_at)}</span>{renderPhotoLink(event.photo_url)}</span>)}</div>}{mapUrl && <div className="attendance-location-map"><div className="attendance-location-map-header"><strong>{location ? "Current location" : "Recorded location"}</strong><span>{locationLabel(mapLocation)}{mapLocation.accuracy ? ` · ±${Math.round(mapLocation.accuracy)}m` : ""}</span></div><iframe title={`${location ? "Current" : "Recorded"} location at ${item.site_name}`} src={mapUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" /></div>}</article>; })}</section> : <section className="panel empty-state"><ClipboardList size={30} /><strong>No assigned shifts</strong><span>Your published shifts for this date will appear here.</span></section>}{cameraOpen && <div className="modal-backdrop"><section className="modal-card camera-modal"><div className="modal-header"><div><p className="eyebrow">LIVE ATTENDANCE PHOTO</p><h3>Take live picture</h3><p className="muted">Use the camera now. Photos from the gallery are not accepted.</p></div><button type="button" className="icon-button" onClick={stopCamera}><X size={19} /></button></div><video ref={videoRef} autoPlay playsInline className="camera-preview" /><canvas ref={canvasRef} className="camera-canvas" /><div className="modal-actions"><button type="button" className="secondary-button" onClick={stopCamera}>Cancel</button><button type="button" className="secondary-button" onClick={switchCamera}>{cameraFacing === "environment" ? "Use front camera" : "Use back camera"}</button><button type="button" className="primary-button" onClick={() => capturePhoto(cameraOpen)}>Capture picture</button></div></section></div>}</>;
}

function GuardHomePage({ onNavigate, unreadNotifications }) {
  const [profile, setProfile] = useState(null); const [operations, setOperations] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = async () => { setLoading(true); setError(""); try { const [profileData, todayOperations] = await Promise.all([api("/employees/me/"), api(`/operations/?operation_date=${todayIso()}`)]); setProfile(profileData); setOperations(todayOperations); } catch (err) { setError(err.message); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);
  const assigned = operations.filter((item) => item.employee); const onDuty = assigned.filter((item) => item.attendance_status === "ON_DUTY"); const bookedOff = assigned.filter((item) => item.attendance_status === "BOOKED_OFF");
  if (loading) return <div className="empty-view"><RotaLoader label="Loading your portal…" /></div>;
  return <><div className="page-heading guard-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>Welcome, {profile?.name?.split(" ")[0] || "Guard"}</h2><p className="muted">Your shifts, attendance and compliance tasks in one place.</p></div><span className="profile-progress-badge">{profile?.profile_completion || 0}% profile</span></div>{error && <p className="error page-error">{error}</p>}<section className="guard-hero panel"><div><span className="eyebrow">TODAY · {todayIso()}</span><h3>{assigned.length ? `${assigned.length} shift${assigned.length === 1 ? "" : "s"} assigned today` : "No shift assigned today"}</h3><p>{assigned.length ? "Open My attendance to book on at your assigned site." : "Check My rota for your next published shift."}</p></div><div className="guard-hero-actions"><button className="primary-button" onClick={() => onNavigate("attendance")}>Book On / Attendance</button><button className="secondary-button" onClick={() => onNavigate("rota")}>View my rota</button></div></section><section className="stats-grid guard-stats"><StatCard label="Today’s shifts" value={assigned.length} detail="Assigned to you" icon={CalendarDays} tone="blue" /><StatCard label="On duty" value={onDuty.length} detail="Book On received" icon={CheckCircle2} tone="teal" /><StatCard label="Booked off" value={bookedOff.length} detail="Shift completed" icon={Clock3} tone="amber" /><StatCard label="Unread alerts" value={unreadNotifications} detail="Review notifications" icon={Bell} tone="rose" /></section><section className="guard-home-grid"><article className="panel"><div className="panel-header"><div><h3>Today’s assignments</h3><p className="muted">Your site and shift details.</p></div><button className="mini-button" onClick={() => onNavigate("attendance")}>Open attendance</button></div>{assigned.length ? <div className="guard-assignment-list">{assigned.map((item) => <div className="guard-assignment-row" key={item.id}><div><strong>{item.site_name}</strong><span>{item.shift_name} · {String(item.scheduled_start || "").slice(0, 5)}–{String(item.scheduled_end || "").slice(0, 5)}</span></div><span className={`status-pill ${item.attendance_status === "BOOKED_OFF" ? "active" : item.attendance_status === "ON_DUTY" ? "present" : "pending"}`}>{item.attendance_status.replaceAll("_", " ")}</span></div>)}</div> : <div className="empty-state compact-empty"><CalendarDays size={25} /><strong>No shift for today</strong><span>Your next published assignments are in My rota.</span></div>}</article><article className="panel guard-quick-panel"><div className="panel-header"><div><h3>Quick actions</h3><p className="muted">Keep your account ready for work.</p></div></div><button className="guard-quick-action" onClick={() => onNavigate("profile")}><FileText size={17} /><span><strong>Complete profile & documents</strong><small>{profile?.profile_completion || 0}% personal details completed</small></span><ChevronRight size={16} /></button><button className="guard-quick-action" onClick={() => onNavigate("notifications")}><Bell size={17} /><span><strong>Check notifications</strong><small>{unreadNotifications} unread updates</small></span><ChevronRight size={16} /></button></article></section></>;
}

function GuardRotaPage({ initialDate } = {}) {
  const thisWeek = toMonday(ukDate());
  const nextWeek = addDays(thisWeek, 7);
  const [weekStart, setWeekStart] = useState(() => {
    const linkedWeek = new URLSearchParams(window.location.search).get("week_start");
    if (initialDate) return toMonday(initialDate);
    const linkedDate = new Date(`${linkedWeek}T00:00:00Z`);
    if (linkedDate.getUTCDay() === 1 && linkedDate.toISOString().slice(0, 10) === linkedWeek) return linkedWeek;
    return thisWeek;
  });
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    const url = new URL(window.location.href);
    url.searchParams.set("week_start", weekStart);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);

    api(`/rota-weeks/my/?week_start=${weekStart}`, { silentLoading: true, silentError: true })
      .then((result) => { if (active) setSchedule(result[0] || null); })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [weekStart]);

  const selectWeek = (date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || saving) return;
    const monday = toMonday(date);
    if (monday === weekStart) return;
    setSchedule(null);
    setLoading(true);
    setError("");
    setNotice("");
    setWeekStart(monday);
  };
  const confirm = async () => {
    if (!schedule || saving) return;
    setSaving(true);
    setError("");
    try {
      const confirmation = await api(`/rota-weeks/${schedule.rota_week.id}/confirm/`, {
        method: "POST", body: "{}", silentToast: true, silentError: true,
      });
      setSchedule({ ...schedule, confirmation });
      setNotice("Rota confirmed successfully.");
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  const assignments = schedule?.assignments || [];
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const confirmed = schedule?.confirmation?.status === "CONFIRMED";
  const shortDate = (date) => formatDay(date, { day: "numeric", month: "short" });
  return <>
    <div className="page-heading guard-rota-heading">
      <div><p className="eyebrow">GUARD PORTAL</p><h2>My weekly rota</h2><p className="muted">Only your published assignments are shown here.</p></div>
      <div className="guard-week-controls">
        <div className="guard-week-shortcuts" role="group" aria-label="Rota week">
          {[["This week", thisWeek], ["Next week", nextWeek]].map(([label, date]) => (
            <button type="button" key={label} className="guard-week-shortcut" aria-pressed={weekStart === date} disabled={saving} onClick={() => selectWeek(date)}>
              <strong>{label}</strong>
              <span>{shortDate(date)} – {shortDate(addDays(date, 6))}</span>
            </button>
          ))}
        </div>
        <label className="guard-week-picker">Week starting
          <input type="date" value={weekStart} disabled={saving} onChange={(event) => selectWeek(event.target.value)} />
        </label>
      </div>
    </div>
    {error && <p role="alert" className="error page-error">{error}</p>}
    {notice && <p role="status" className="success page-success">{notice}</p>}
    {loading ? <div className="empty-view" role="status"><h2>Loading rota...</h2></div> : schedule ? <>
      <section className="guard-rota-status panel">
        <div>
          <strong>Week of {formatDay(weekStart, { day: "numeric", month: "short", year: "numeric" })}</strong>
          <span>{assignments.length} assignment{assignments.length === 1 ? "" : "s"} · {confirmed ? `Confirmed ${new Date(schedule.confirmation.confirmed_at).toLocaleString()}` : "Confirmation pending"}</span>
        </div>
        {confirmed ? <span className="status-pill active">Rota confirmed</span> : <button className="primary-button" disabled={saving} onClick={confirm}>{saving ? "Confirming..." : "Confirm rota"}</button>}
      </section>
      <section className="guard-rota-board">
        {days.map((day) => {
          const dayAssignments = assignments.filter((item) => item.work_date === day);
          return <article className="panel guard-day-card" key={day}>
            <div className="day-heading"><div><strong>{formatDay(day, { weekday: "short" })}</strong><span>{shortDate(day)}</span></div><b>{dayAssignments.length}</b></div>
            {dayAssignments.length ? dayAssignments.map((item) => <div className="guard-rota-assignment" key={item.id}>
              <strong>{item.site_name}</strong><span>{item.shift_name}</span>
              <small>{String(item.scheduled_start || "").slice(0, 5)}–{String(item.scheduled_end || "").slice(0, 5)}</small>
              <SiteLocationLinks item={item} />
            </div>) : <div className="day-empty">No assignment</div>}
          </article>;
        })}
      </section>
    </> : !error && <section className="panel empty-state"><CalendarDays size={30} /><strong>{weekStart === nextWeek ? "No published rota for next week" : "No published rota for the selected week"}</strong><span>The office will publish your assignments here.</span></section>}
  </>;
}

function GuardLeavePage() {
  const empty = { leave_type: "ANNUAL", start_date: todayIso(), end_date: todayIso(), reason: "" };
  const [items, setItems] = useState([]); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const load = () => { setLoading(true); api("/leave/").then(setItems).catch((err) => setError(err.message)).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, []);
  const submit = async (event) => { event.preventDefault(); setSaving(true); setError(""); setNotice(""); try { await api("/leave/", { method: "POST", body: JSON.stringify(form) }); setForm(empty); setNotice("Request sent to the office for review."); load(); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  return <><div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>Leave & replacement</h2><p className="muted">Send leave, absence or replacement requests to the office.</p></div></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}<section className="panel"><div className="panel-header"><div><h3>New request</h3><p className="muted">The office will approve or reject your request.</p></div></div><form className="form-grid" onSubmit={submit}><label>Request type<select value={form.leave_type} onChange={(event) => setForm({ ...form, leave_type: event.target.value })}><option value="ANNUAL">Annual leave</option><option value="SICK">Sick leave</option><option value="EMERGENCY">Emergency absence</option><option value="REPLACEMENT">Request replacement</option></select></label><label>Start date<input required type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></label><label>End date<input required type="date" value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} /></label><label className="full-width">Reason / handover notes<textarea required rows="3" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Tell the office why you cannot attend or what handover is needed." /></label><div className="form-actions full-width"><button className="primary-button" disabled={saving}>{saving ? "Sending..." : "Send request"}</button></div></form></section><section className="panel"><div className="panel-header"><div><h3>My requests</h3><p className="muted">Previous requests and their current status.</p></div><span className="muted">{items.length} requests</span></div>{loading ? <div className="empty-state compact-empty">Loading requests...</div> : items.length ? <div className="table-wrap"><table><thead><tr><th>Type</th><th>Dates</th><th>Reason</th><th>Status</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.leave_type}</td><td>{item.start_date} → {item.end_date}</td><td>{item.reason || "—"}</td><td><span className={`status-pill ${item.status.toLowerCase()}`}>{item.status}</span></td></tr>)}</tbody></table></div> : <div className="empty-state compact-empty">No requests submitted yet.</div>}</section></>;
}

function ComplianceApprovalsPage({ initialRegistrationId }) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState(initialRegistrationId ? "ALL" : "PENDING_APPROVAL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const load = () => { setLoading(true); setError(""); api(`/compliance-approvals/?status=${filter}`).then((data) => { setItems(data); if (initialRegistrationId) setSelected(data.find((item) => item.id === initialRegistrationId) || null); }).catch((err) => setError(err.message)).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [filter]);
  const formatRemaining = (seconds) => { if (seconds === null || seconds === undefined) return "—"; if (seconds <= 0) return "Overdue"; const minutes = Math.ceil(seconds / 60); return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`; };
  const approve = async (item) => { if (!window.confirm(`Approve Diligent registration for ${item.employee_name}?`)) return; try { await api(`/compliance-approvals/${item.id}/approve/`, { method: "POST" }); setSelected(null); load(); } catch { /* api toast already shown */ } };
  const reject = async (item) => { const reason = window.prompt(`Reason for sending ${item.employee_name}'s form back:`, item.rejection_reason || ""); if (!reason) return; try { await api(`/compliance-approvals/${item.id}/reject/`, { method: "POST", body: JSON.stringify({ reason }) }); setSelected(null); load(); } catch { /* api toast already shown */ } };
  const downloadAdminPdf = (item) => downloadFile(`/employees/${item.employee?.id}/compliance/pdf/`, `Diligent - ${item.employee_name || "Guard"}.pdf`).catch((err) => setError(err.message));
  const requestResubmission = async (item) => { const reason = window.prompt(`Why should ${item.employee_name}'s form be submitted again?`, "Please review your registration and submit it again."); if (!reason?.trim()) return; try { await api(`/compliance-approvals/${item.id}/request-resubmission/`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }); setSelected(null); load(); } catch { /* api toast already shown */ } };
  const statusLabel = (status) => ({ PENDING_APPROVAL: "In process", APPROVED: "Approved", REJECTED: "Changes required" }[status] || status);
  return <><div className="page-heading"><div><p className="eyebrow">DILIGENT BUSINESS SERVICES</p><h2>Compliance approvals</h2><p className="muted">Review guard registrations submitted for approval. The target review window is 60 minutes.</p></div><div className="report-filters"><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="PENDING_APPROVAL">In process</option><option value="APPROVED">Approved</option><option value="REJECTED">Changes required</option><option value="ALL">All forms</option></select><CheckUpdatesButton api={api} paths={`/compliance-approvals/?status=${filter}`} currentData={items} onUpdate={setItems} setError={setError} disabled={loading} /></div></div>{error && <p className="error page-error">{error}</p>}<section className="panel compliance-approvals-panel"><div className="panel-header"><div><h3>Guard registration queue</h3><p className="muted">Open a form to check every submitted detail, then approve or request corrections.</p></div><span className="muted">{items.length} forms</span></div>{loading ? <div className="empty-state">Loading approval queue...</div> : items.length ? <div className="table-wrap"><table><thead><tr><th>Guard</th><th>Form ID</th><th>Submitted</th><th>Review window</th><th>Status</th><th>Action</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.employee_name}</strong><small className="table-subtext">{item.job_role || item.employee?.position || "Guard"}</small></td><td>{item.form_id}</td><td>{item.submitted_at ? new Date(item.submitted_at).toLocaleString() : "—"}</td><td><span className={item.approval_remaining_seconds > 0 ? "approval-time" : "approval-time overdue"}>{formatRemaining(item.approval_remaining_seconds)}</span></td><td><span className={`status-pill ${item.status.toLowerCase()}`}>{statusLabel(item.status)}</span>{item.rejection_reason && <small className="table-subtext">{item.rejection_reason}</small>}</td><td><div className="row-actions"><button className="mini-button" onClick={() => setSelected(item)}>View form</button>{item.status === "PENDING_APPROVAL" && <><button className="mini-button approve" onClick={() => approve(item)}><CheckCircle2 size={13} /> Approve</button><button className="mini-button reject" onClick={() => reject(item)}>Send back</button></>}{item.status === "APPROVED" && <><button className="mini-button" onClick={() => downloadAdminPdf(item)}><Download size={13} /> Download PDF</button><button className="mini-button reject" onClick={() => requestResubmission(item)}>Request resubmission</button><span className="status-pill active">PDF unlocked</span></>}</div></td></tr>)}</tbody></table></div> : <div className="empty-state"><ShieldCheck size={30} /><strong>No forms in this queue</strong><span>Submitted guard forms will appear here.</span></div>}</section>{selected && <ComplianceReviewModal item={selected} onClose={() => setSelected(null)} onApprove={approve} onReject={reject} onRequestResubmission={requestResubmission} onDownloadPdf={downloadAdminPdf} />}</>;
}

function ComplianceReviewModal({ item, onClose, onApprove, onReject, onRequestResubmission, onDownloadPdf }) {
  const value = (field) => field === null || field === undefined || String(field).trim() === "" ? "—" : String(field);
  const yesNo = (field) => field === true ? "Yes" : field === false ? "No" : value(field);
  const fields = [
    ["Employee ID", item.employee?.employee_id], ["Full name", item.employee?.name || item.employee_name], ["Email", item.employee?.email],
    ["Date of birth", item.employee?.date_of_birth], ["Nationality", item.employee?.nationality], ["Phone", item.employee?.phone],
    ["Address line 1", item.address_line_1 || item.employee?.address], ["City", item.city], ["Postcode", item.postcode],
    ["National Insurance Number", item.national_insurance_number], ["Previously unemployed", item.previously_unemployed],
    ["Main mode of transport", item.main_mode_of_transport], ["Type of employment", item.employment_type],
    ["Additional certifications / qualifications", item.additional_certifications], ["Job role", item.job_role || item.employee?.position],
    ["Qualifications", item.qualifications], ["Next of kin name", item.next_of_kin_name], ["Next of kin relationship", item.next_of_kin_relationship],
    ["Next of kin phone", item.next_of_kin_phone], ["Gender", item.gender],
    ["Declaration accepted", yesNo(item.declaration_accepted)], ["Typed signature", item.signature_name], ["Signed date", item.signed_at],
  ];
  const statusLabel = { PENDING_APPROVAL: "In process", APPROVED: "Approved", REJECTED: "Changes required" }[item.status] || item.status;
  return <div className="modal-backdrop"><section className="modal-card compliance-review-modal"><div className="modal-header"><div><p className="eyebrow">REGISTRATION FORM</p><h3>{item.employee_name}</h3><p className="muted">{item.form_id} · {statusLabel}</p></div><button type="button" className="icon-button" onClick={onClose}><X size={19} /></button></div><div className="compliance-review-grid">{fields.map(([label, field]) => <div key={label}><span>{label}</span><strong>{value(field)}</strong></div>)}</div><div className="compliance-review-meta"><span>Submitted: {item.submitted_at ? new Date(item.submitted_at).toLocaleString() : "Not submitted"}</span><span>Review window: {item.approval_remaining_seconds > 0 ? `${Math.ceil(item.approval_remaining_seconds / 60)} minutes remaining` : "—"}</span></div>{item.rejection_reason && <p className="error">Changes requested: {item.rejection_reason}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Close</button>{item.status === "PENDING_APPROVAL" && <><button type="button" className="secondary-button" onClick={() => onReject(item)}>Send back</button><button type="button" className="primary-button" onClick={() => onApprove(item)}><CheckCircle2 size={15} /> Approve</button></>}{item.status === "APPROVED" && <><button type="button" className="secondary-button" onClick={() => onDownloadPdf(item)}><Download size={15} /> Download PDF</button><button type="button" className="secondary-button" onClick={() => onRequestResubmission(item)}>Request resubmission</button></>}</div></section></div>;
}

function ComplianceRegistrationPage() {
  const blankForm = {
    national_insurance_number: "", address_line_1: "", city: "", postcode: "", previously_unemployed: "", main_mode_of_transport: "", employment_type: "", additional_certifications: "", next_of_kin_name: "", next_of_kin_relationship: "", next_of_kin_phone: "", job_role: "", qualifications: "", ethnicity: "", religion: "", gender: "", sexuality: "", disability_health_condition: "", declaration_accepted: false, signature_name: "", status: "DRAFT",
  };
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(blankForm);
  const [employee, setEmployee] = useState(null);
  const [registration, setRegistration] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const transportOptions = ["Car", "Motorcycle / scooter", "Bus", "Train", "Bicycle", "Walking", "Taxi / ride-hailing"];
  const relationshipOptions = ["Parent", "Spouse / partner", "Son / daughter", "Brother / sister", "Relative", "Friend"];
  const employmentOptions = ["Full-time", "Part-time", "Casual", "Zero-hours", "Self-employed", "Temporary / contract"];
  const [transportOther, setTransportOther] = useState("");
  const [relationshipOther, setRelationshipOther] = useState("");
  const [employmentOther, setEmploymentOther] = useState("");
  const declaration = "I can confirm all information is correct and I understand my details will be sent to Diligent.";
  const steps = ["Personal details", "Employment", "Next of kin", "Declaration"];

  useEffect(() => {
    api("/employees/me/compliance/")
      .then((data) => {
        setEmployee(data.employee || null);
        setDocuments(data.documents || []);
        setRegistration(data.registration || null);
        const profile = data.employee || {};
        const saved = data.registration || {};
        const ni = (data.documents || []).find((item) => item.document_type === "National Insurance Number (NI)");
        const nextOfKinName = profile.emergency_contact_name || profile.emergency_contact || "";
        const savedTransport = saved.main_mode_of_transport || "";
        const savedRelationship = saved.next_of_kin_relationship || profile.emergency_contact_relationship || "";
        const savedEmployment = saved.employment_type || "";
        setTransportOther(transportOptions.includes(savedTransport) || savedTransport === "Other" ? "" : savedTransport);
        setRelationshipOther(relationshipOptions.includes(savedRelationship) || savedRelationship === "Other" ? "" : savedRelationship);
        setEmploymentOther(employmentOptions.includes(savedEmployment) || savedEmployment === "Other" ? "" : savedEmployment);
        setForm({ ...blankForm, ...saved, address_line_1: saved.address_line_1 || profile.address || "", national_insurance_number: saved.national_insurance_number || ni?.document_number || ni?.notes || "", next_of_kin_name: saved.next_of_kin_name || nextOfKinName, next_of_kin_relationship: savedRelationship, next_of_kin_phone: saved.next_of_kin_phone || profile.emergency_contact_phone || "", job_role: saved.job_role || profile.position || "", signature_name: saved.signature_name || profile.name || "" });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const choiceValue = (value, options, customValue) => options.includes(value) ? value : (customValue || value) ? "Other" : "";
  const updateChoice = (key, value, options, setOther) => {
    if (value === "Other") {
      setOther((current) => current || (!options.includes(form[key]) && form[key] !== "Other" ? form[key] : ""));
      update(key, "Other");
    } else {
      setOther("");
      update(key, value);
    }
  };
  const saveDraft = async (nextStep = step, final = false) => {
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await api("/employees/me/compliance/", { method: registration ? "PATCH" : "POST", body: JSON.stringify({ ...form, status: final ? "PENDING_APPROVAL" : "DRAFT" }) });
      setRegistration(result.registration || null);
      if (result.employee) setEmployee(result.employee);
      if (final) {
        setForm((current) => ({ ...current, status: "PENDING_APPROVAL" }));
        setNotice("Registration submitted. It is now in process for office approval within 60 minutes.");
      } else {
        setStep(nextStep);
        setNotice("Progress saved.");
      }
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const previous = () => setStep((current) => Math.max(0, current - 1));
  const next = () => canEdit ? saveDraft(Math.min(steps.length - 1, step + 1)) : setStep((current) => Math.min(steps.length - 1, current + 1));
  const inProcess = registration?.status === "PENDING_APPROVAL" || form.status === "PENDING_APPROVAL";
  const approved = registration?.status === "APPROVED" || form.status === "APPROVED";
  const rejected = registration?.status === "REJECTED" || form.status === "REJECTED";
  const canEdit = !inProcess && !approved;
  const saved = inProcess || approved;
  const documentValue = (...types) => { const item = documents.find((document) => types.includes(document.document_type)); return item ? (item.document_number || item.notes || "—") : "Not provided"; };
  if (loading) return <><div className="page-heading"><div><p className="eyebrow">REGISTRATION FORM</p><h2>Registration Form</h2></div></div><section className="panel empty-state">Loading your registration form...</section></>;
  return <>
    <div className="page-heading">
      <div><p className="eyebrow">REGISTRATION FORM</p><h2>Registration Form</h2><p className="muted">{approved ? "Your form is approved. You can view all four steps and save your PDF." : "Complete each step carefully. Your Form ID is generated automatically and cannot be edited."}</p></div>
      <span className={`status-pill ${approved ? "active" : rejected ? "rejected" : "pending"}`}>{approved ? "Approved" : rejected ? "Changes required" : inProcess ? "In process" : "Draft"}</span>
    </div>
    {error && <p className="error page-error">{error}</p>}
    {notice && <p className="success page-success">{notice}</p>}
    {inProcess && <section className="panel compliance-status-card"><div><span className="eyebrow">IN PROCESS</span><h3>Your form is with the office for approval</h3><p className="muted">The office target is 60 minutes. You will receive a notification when the decision is made.</p></div><span className="approval-time">{registration?.approval_deadline ? new Date(registration.approval_deadline).toLocaleString() : "Within 60 minutes"}</span></section>}
    {approved && <section className="panel compliance-status-card approved"><div><span className="eyebrow">APPROVED</span><h3>Your registration is approved</h3><p className="muted">You can now save your official Diligent PDF.</p></div><button className="primary-button" onClick={() => downloadFile("/employees/me/compliance/pdf/", `Diligent - ${employee?.name || "Guard"}.pdf`).catch((err) => setError(err.message))}><Download size={15} /> Save PDF</button></section>}
    {rejected && <section className="panel compliance-status-card rejected"><div><span className="eyebrow">CHANGES REQUIRED</span><h3>Please update and submit again</h3><p className="muted">{registration?.rejection_reason || "The office requested changes."}</p></div></section>}
    <section className="panel compliance-form-shell">
      <div className="compliance-form-top"><div><strong>Form ID</strong><span className="compliance-form-id">{registration?.form_id || "Generated when saved"}</span></div><div className="compliance-stepper">{steps.map((label, index) => <button type="button" key={label} className={`compliance-step ${index === step ? "active" : ""} ${index < step ? "completed" : ""}`} aria-current={index === step ? "step" : undefined} disabled={saving || (!approved && (!canEdit || index >= step))} onClick={() => (approved || (canEdit && index < step)) && setStep(index)}><span>{index < step ? "✓" : index + 1}</span><small>{label}</small></button>)}</div></div>
      <div className="compliance-form-card">
        {step === 0 && <><div className="panel-header"><div><h3>Personal details</h3><p className="muted">These details come from your guard profile. Update your profile if anything is incorrect.</p></div></div><div className="form-grid"><label>Full name<input value={employee?.name || ""} disabled /></label><label>Date of birth<input value={employee?.date_of_birth || "Not provided"} disabled /></label><label>Nationality<input value={employee?.nationality || "Not provided"} disabled /></label><label>Gender<input disabled={!canEdit} value={form.gender} onChange={(event) => update("gender", event.target.value)} placeholder="Optional" /></label><label>Email<input value={employee?.email || "Not provided"} disabled /></label><label>Phone number<input value={employee?.phone || "Not provided"} disabled /></label><label>National Insurance Number<input disabled={!canEdit} value={form.national_insurance_number} onChange={(event) => update("national_insurance_number", event.target.value)} placeholder="Enter NI number" /></label><label className="full-width">Address line 1<input disabled={!canEdit} value={form.address_line_1} onChange={(event) => update("address_line_1", event.target.value)} placeholder="House number and street" /></label><label>City<input disabled={!canEdit} value={form.city} onChange={(event) => update("city", event.target.value)} /></label><label>Postcode<input disabled={!canEdit} value={form.postcode} onChange={(event) => update("postcode", event.target.value)} /></label></div><div className="compliance-readonly-grid"><div><span>SIA card number</span><strong>{documentValue("SIA Card (Front)", "SIA Card (Front & Back)")}</strong></div><div><span>CSCS card number</span><strong>{documentValue("CSCS Card (Front)", "CSCS Card (Front & Back)")}</strong></div></div></>}
        {step === 1 && <><div className="panel-header"><div><h3>Employment details</h3><p className="muted">Tell Diligent about your work background and current arrangements.</p></div></div><div className="form-grid"><label>Previously unemployed<select disabled={!canEdit} value={form.previously_unemployed} onChange={(event) => update("previously_unemployed", event.target.value)}><option value="">Select an answer</option><option value="Yes">Yes</option><option value="No">No</option><option value="Prefer not to say">Prefer not to say</option></select></label><label>Main mode of transport<select disabled={!canEdit} value={choiceValue(form.main_mode_of_transport, transportOptions, transportOther)} onChange={(event) => updateChoice("main_mode_of_transport", event.target.value, transportOptions, setTransportOther)}><option value="">Select transport</option>{transportOptions.map((option) => <option value={option} key={option}>{option}</option>)}<option value="Other">Other</option></select></label>{(choiceValue(form.main_mode_of_transport, transportOptions, transportOther) === "Other") && <label>Other transport<input disabled={!canEdit} value={transportOther || (form.main_mode_of_transport !== "Other" ? form.main_mode_of_transport : "")} onChange={(event) => { setTransportOther(event.target.value); update("main_mode_of_transport", event.target.value); }} placeholder="Type your transport" /></label>}<label>Type of employment<select disabled={!canEdit} value={choiceValue(form.employment_type, employmentOptions, employmentOther)} onChange={(event) => updateChoice("employment_type", event.target.value, employmentOptions, setEmploymentOther)}><option value="">Select employment type</option>{employmentOptions.map((option) => <option value={option} key={option}>{option}</option>)}<option value="Other">Other</option></select></label>{(choiceValue(form.employment_type, employmentOptions, employmentOther) === "Other") && <label>Other employment type<input disabled={!canEdit} value={employmentOther || (form.employment_type !== "Other" ? form.employment_type : "")} onChange={(event) => { setEmploymentOther(event.target.value); update("employment_type", event.target.value); }} placeholder="Type employment type" /></label>}<label>Job role<input disabled={!canEdit} value={form.job_role} onChange={(event) => update("job_role", event.target.value)} /></label><label className="full-width">Additional certifications / qualifications<textarea disabled={!canEdit} rows="3" value={form.additional_certifications} onChange={(event) => update("additional_certifications", event.target.value)} placeholder="List any relevant certificates" /></label><label className="full-width">Qualifications<textarea disabled={!canEdit} rows="3" value={form.qualifications} onChange={(event) => update("qualifications", event.target.value)} placeholder="List your qualifications or write None" /></label></div></>}
        {step === 2 && <><div className="panel-header"><div><h3>Next of kin</h3><p className="muted">Please provide someone we can contact in an emergency.</p></div></div><div className="form-grid"><label>Full name<input disabled={!canEdit} value={form.next_of_kin_name} onChange={(event) => update("next_of_kin_name", event.target.value)} /></label><label>Relationship<select disabled={!canEdit} value={choiceValue(form.next_of_kin_relationship, relationshipOptions, relationshipOther)} onChange={(event) => updateChoice("next_of_kin_relationship", event.target.value, relationshipOptions, setRelationshipOther)}><option value="">Select relationship</option>{relationshipOptions.map((option) => <option value={option} key={option}>{option}</option>)}<option value="Other">Other</option></select></label>{(choiceValue(form.next_of_kin_relationship, relationshipOptions, relationshipOther) === "Other") && <label>Other relationship<input disabled={!canEdit} value={relationshipOther || (form.next_of_kin_relationship !== "Other" ? form.next_of_kin_relationship : "")} onChange={(event) => { setRelationshipOther(event.target.value); update("next_of_kin_relationship", event.target.value); }} placeholder="Type relationship" /></label>}<label>Contact phone<input disabled={!canEdit} value={form.next_of_kin_phone} onChange={(event) => update("next_of_kin_phone", event.target.value)} /></label></div></>}
        {step === 3 && <><div className="panel-header"><div><h3>Declaration & signature</h3><p className="muted">Check the information before sending it for approval.</p></div></div><div className="compliance-declaration"><label className="checkbox-row"><input type="checkbox" disabled={!canEdit} checked={form.declaration_accepted} onChange={(event) => update("declaration_accepted", event.target.checked)} /><span>{declaration}</span></label></div><label className="signature-input">Typed name (signature)<input disabled={!canEdit} value={form.signature_name} onChange={(event) => update("signature_name", event.target.value)} placeholder={employee?.name || "Type your full name"} /></label><p className="form-help">After approval, the PDF will be saved as <strong>Diligent - {employee?.name || "Guard Full Name"}.pdf</strong>.</p></>}
      </div>
      <div className="compliance-actions"><button type="button" className="secondary-button" onClick={previous} disabled={step === 0 || saving}>Back</button>{(canEdit || approved) && (step < steps.length - 1 ? <button type="button" className="primary-button" onClick={next} disabled={saving}>{saving ? "Saving..." : approved ? "Next" : "Save & next"}</button> : canEdit && <button type="button" className="primary-button" onClick={() => saveDraft(step, true)} disabled={saving || !form.declaration_accepted || !form.signature_name.trim()}>{saving ? "Submitting..." : "Submit for approval"}</button>)}</div>
    </section>
  </>;
}

const guardLinkedPages = ["profile", "documents", "notifications", "induction", "cortex-itime", "timegate", "rota"];

function GuardPortal({ user, onSignOut, unreadNotifications, initialPage = "home" }) {
  const [page, setPage] = useState(() => { const requested = new URLSearchParams(window.location.search).get("page"); return guardLinkedPages.includes(requested) ? requested : initialPage; }); const [mobileNav, setMobileNav] = useState(false);
  const [notificationTarget, setNotificationTarget] = useState({});
  const openNotification = (target, context) => { setNotificationTarget((current) => ({ ...context, page: target, visit: (current.visit || 0) + 1 })); setPage(target); };
  useEffect(() => {
    const url = new URL(window.location.href);
    if (guardLinkedPages.includes(page)) url.searchParams.set("page", page);
    else url.searchParams.delete("page");
    if (page !== "rota") url.searchParams.delete("week_start");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
  }, [page]);
  const [complianceEnabled, setComplianceEnabled] = useState(Boolean(user.compliance_registration_enabled));
  const [cortexEnabled, setCortexEnabled] = useState(false);
  const [timeGateEnabled, setTimeGateEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    const loadProfile = () => api("/employees/me/", { silentLoading: true, silentError: true }).then((profile) => {
      if (!active) return;
      setComplianceEnabled(Boolean(profile.compliance_registration_enabled));
      setCortexEnabled(profile.status === "ACTIVE" && Boolean(profile.cortex_itime_enabled));
      setTimeGateEnabled(profile.status === "ACTIVE" && Boolean(profile.timegate_pin_saved));
    }).catch(() => {});
    loadProfile();
    window.addEventListener("focus", loadProfile);
    return () => { active = false; window.removeEventListener("focus", loadProfile); };
  }, []);
  useEffect(() => { const openNotifications = () => setPage("notifications"); window.addEventListener("rota:notifications-open", openNotifications); return () => window.removeEventListener("rota:notifications-open", openNotifications); }, []);
  const items = [{ id: "home", label: "Home", icon: LayoutDashboard }, { id: "rota", label: "My rota", icon: CalendarDays }, { id: "induction", label: "Induction", icon: ClipboardList }, { id: "attendance", label: "Book on / off", icon: CheckCircle2 }, { id: "leave", label: "Leave & replacement", icon: CalendarDays }, ...(complianceEnabled ? [{ id: "external-compliance", label: "Compliance registration", icon: ExternalLink, section: "Compliance", external: true, href: COMPLIANCE_REGISTRATION_URL }] : []), ...(cortexEnabled ? [{ id: "cortex-itime", label: "Cortex iTime", icon: Clock3, section: "Compliance" }] : []), ...(timeGateEnabled ? [{ id: "timegate", label: "TimeGate", icon: Clock3, section: "Compliance" }] : []), { id: "security-screening", label: "Security Screening", icon: ShieldCheck, section: "Compliance" }, { id: "diligent-registration", label: "Registration", icon: ShieldCheck, section: "Compliance" }, { id: "profile", label: "My profile", icon: Users, section: "Account" }, { id: "password", label: "Change password", icon: ShieldCheck, section: "Account" }, { id: "documents", label: "Documents", icon: FileText, section: "Account" }, { id: "notifications", label: "Notifications", icon: Bell }];
  const content = page === "timegate" ? <GuardTimeGate api={api} /> : page === "cortex-itime" ? <GuardCortexITime api={api} /> : page === "security-screening" ? <GuardScreening api={api} downloadFile={downloadFile} FilePreview={ProtectedFilePreview} /> : page === "home" ? <GuardHomePage onNavigate={setPage} unreadNotifications={unreadNotifications} /> : page === "rota" ? <GuardRotaPage key={notificationTarget.visit} initialDate={notificationTarget.page === "rota" ? notificationTarget.event_date : undefined} /> : page === "attendance" ? <EmployeeAttendancePage key={notificationTarget.visit} initialDate={notificationTarget.page === "attendance" ? notificationTarget.event_date : undefined} initialOperationId={notificationTarget.page === "attendance" ? notificationTarget.operation_id : undefined} /> : page === "induction" ? <GuardSiteInductions api={api} /> : page === "leave" ? <GuardLeavePage /> : page === "diligent-registration" ? <ComplianceRegistrationPage /> : page === "profile" ? <EmployeeProfilePage section="profile" /> : page === "password" ? <EmployeeProfilePage section="password" /> : page === "documents" ? <EmployeeProfilePage key={notificationTarget.visit} section="documents" onProfile={() => setPage("profile")} initialDocumentId={notificationTarget.page === "documents" ? notificationTarget.document_id : undefined} /> : <GuardNotifications api={api} onNavigate={openNotification} />;
  return <><ToastHost /><div className="app-shell guard-portal-shell"><aside className={mobileNav ? "sidebar open" : "sidebar"}><div className="sidebar-brand"><div className="brand-lockup"><img className="brand-logo" src="/branding/rotaops-logo.jpg" alt="RotaOps" /></div><button className="icon-button close-nav" onClick={() => setMobileNav(false)}><X size={20} /></button></div><nav>{items.map((item, index) => { const Icon = item.icon; const showSection = item.section && (index === 0 || items[index - 1].section !== item.section); const navClass = page === item.id ? "nav-item active" : "nav-item"; return <div className="guard-nav-entry" key={item.id}>{showSection && <span className="sidebar-section-label">{item.section}</span>}{item.external ? <a className={navClass} href={item.href} target="_blank" rel="noreferrer" onClick={() => setMobileNav(false)}><Icon size={18} /><span>{item.label}</span><ExternalLink className="nav-external-icon" size={13} /></a> : <button className={navClass} onClick={() => { setNotificationTarget({}); setPage(item.id); setMobileNav(false); }}><Icon size={18} /><span>{item.label}</span>{item.id === "notifications" && unreadNotifications > 0 && <b className="nav-notification-badge">{unreadNotifications > 99 ? "99+" : unreadNotifications}</b>}</button>}</div>; })}</nav><div className="sidebar-footer"><div className="user-badge"><div className="avatar">{(user.first_name || user.username || "G").slice(0, 1).toUpperCase()}</div><div><strong>{user.first_name || user.username}</strong><span>Guard</span></div></div><button className="logout-button" onClick={onSignOut}><LogOut size={17} /> Sign out</button></div></aside>{mobileNav && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}<main className="main-area"><header className="topbar"><button className="icon-button menu-button" onClick={() => setMobileNav(true)}><Menu size={21} /></button><div className="breadcrumb">Guard portal <span>/</span> <strong>{items.find((item) => item.id === page)?.label}</strong></div><GuardNotificationBell unreadCount={unreadNotifications} onNavigate={openNotification} /></header><div className="page-content"><GuardLocationMonitor api={api} />{content}</div></main></div></>;
}

function GuardAttendanceOnly({ user, onSignOut }) {
  return <div className="attendance-only-shell"><header className="attendance-only-header"><div><div className="attendance-only-brand"><div className="brand-mark"><ShieldCheck size={18} /></div><strong>ROTA</strong></div><span>Secure attendance</span></div><div className="attendance-only-user"><span>{user.first_name || user.username}</span><button className="secondary-button" onClick={onSignOut}>Sign out</button></div></header><main className="attendance-only-content"><GuardLocationMonitor api={api} /><EmployeeAttendancePage /></main></div>;
}

function LegacyAttendanceReviewPage() {
  const [date, setDate] = useState(todayIso()); const [items, setItems] = useState([]); const [error, setError] = useState("");
  const load = () => api(`/operations/?operation_date=${date}`).then(setItems).catch((err) => setError(err.message));
  useEffect(() => { load(); }, [date]);
  const eventsFor = (item) => item.attendance_events || []; const eventTime = (item, type) => { const event = eventsFor(item).find((entry) => entry.event_type === type); return event ? new Date(event.captured_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"; }; const formatCapturedAt = (value) => value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—"; const locationLabel = (event) => event && event.latitude !== null && event.longitude !== null ? `${Number(event.latitude).toFixed(6)}, ${Number(event.longitude).toFixed(6)}` : "Not recorded"; const exceptions = items.reduce((total, item) => total + eventsFor(item).filter((event) => event.location_status !== "VERIFIED").length, 0);
  return <><div className="page-heading"><div><p className="eyebrow">CONTROL ROOM</p><h2>Shift attendance</h2><p className="muted">Review Book On, hourly photo checks and Book Off across all sites.</p></div><div className="report-filters"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /><CheckUpdatesButton api={api} paths={`/operations/?operation_date=${date}`} currentData={items} onUpdate={setItems} setError={setError} /></div></div>{error && <p className="error page-error">{error}</p>}<section className="stats-grid"><StatCard label="Assigned shifts" value={items.filter((item) => item.employee).length} detail={date} icon={Users} tone="blue" /><StatCard label="On duty" value={items.filter((item) => item.attendance_status === "ON_DUTY").length} detail="Book On received" icon={CheckCircle2} tone="teal" /><StatCard label="Booked off" value={items.filter((item) => item.attendance_status === "BOOKED_OFF").length} detail="Shift closed" icon={Clock3} tone="amber" /><StatCard label="Location exceptions" value={exceptions} detail="Outside or unverified" icon={ClipboardList} tone="rose" /></section><section className="panel"><div className="panel-header"><div><h3>Attendance evidence</h3><p className="muted">Open every submitted guard picture and review its timestamp, GPS result and missed-photo reasons.</p></div><span className="muted">{items.length} records</span></div>{items.length ? <div className="table-wrap"><table><thead><tr><th>Site</th><th>Shift</th><th>Guard</th><th>Book On</th><th>Hourly checks</th><th>Book Off</th><th>Pictures & evidence</th><th>Status</th></tr></thead><tbody>{items.map((item) => { const events = eventsFor(item); const hourlyEvents = events.filter((event) => event.event_type === "HOURLY"); const missedReasons = (item.hourly_checkins || []).filter((checkin) => checkin.status === "EXPIRED"); const exceptionsForItem = events.filter((event) => event.location_status !== "VERIFIED"); return <tr key={item.id}><td><strong>{item.site_name}</strong></td><td>{item.shift_name}<small className="table-subtext">{item.operation_date}</small></td><td>{item.employee_name || "Unassigned"}</td><td>{eventTime(item, "BOOK_ON")}</td><td>{hourlyEvents.length ? `${hourlyEvents.length} completed` : "Not submitted"}<small className="table-subtext">{item.expected_hourly_checkins} scheduled · {missedReasons.length} missed</small></td><td>{eventTime(item, "BOOK_OFF")}</td><td><div className="attendance-evidence-links">{events.length ? events.map((event) => event.photo_url ? <div className="attendance-evidence-item" key={event.id}><ProtectedFilePreview value={event.photo_url} label={`${item.employee_name || "Guard"} · ${event.event_label}`} buttonLabel={`View ${event.event_label}`} /><small className="table-subtext">{formatCapturedAt(event.captured_at)} · GPS {locationLabel(event)}</small></div> : null) : "—"}{missedReasons.filter((checkin) => checkin.missed_reason).map((checkin) => <div className="attendance-missed-reason" key={`reason-${checkin.sequence}`}><strong>Hourly {checkin.sequence} reason</strong><span>{checkin.missed_reason}</span></div>)}</div></td><td>{exceptionsForItem.length ? <span className="status-pill outside_site">Review required</span> : <span className={`status-pill ${item.attendance_status === "BOOKED_OFF" ? "active" : item.attendance_status === "ON_DUTY" ? "present" : "pending"}`}>{item.attendance_status.replaceAll("_", " ")}</span>}</td></tr>; })}</tbody></table></div> : <div className="empty-state"><ClipboardList size={30} /><strong>No attendance records</strong><span>Published assigned shifts will appear here.</span></div>}</section></>;
}

function AttendanceReviewPage({ target = {}, canTrack = true }) {
  const [tab, setTab] = useState(canTrack && target.location_tracking ? "location" : "attendance");
  useEffect(() => { if (canTrack && target.location_tracking) setTab("location"); }, [canTrack, target.operation_id, target.location_tracking]);
  if (!canTrack) return <AttendanceSummaryPage target={target} canTrack={false} />;
  return <><div className="control-room-tabs" role="tablist" aria-label="Control Room views"><button role="tab" aria-selected={tab === "attendance"} onClick={() => setTab("attendance")}>Shift attendance</button><button role="tab" aria-selected={tab === "location"} onClick={() => setTab("location")}>Location tracker</button></div>{tab === "location" ? <LocationTracker api={api} target={target} /> : <AttendanceSummaryPage target={target} canTrack={canTrack} />}</>;
}

function AttendanceSummaryPage({ target = {}, canTrack = true }) {
  const [date, setDate] = useState(target.event_date || ukDate());
  const [items, setItems] = useState([]);
  const [selectedShift, setSelectedShift] = useState(target.location_tracking ? null : target.operation_id || null);
  const [siteFilter, setSiteFilter] = useState(target.site_id ? String(target.site_id) : "ALL");
  const [search, setSearch] = useState(target.employee_name || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError("");
    api(`/operations/?operation_date=${date}&view=attendance`)
      .then(setItems)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [date]);

  const eventsFor = (item) => item.attendance_events || [];
  const eventFor = (item, type) => eventsFor(item).find((event) => event.event_type === type);
  const timeFor = (event) => formatUkAttendanceTime(event?.captured_at);
  const formatTime = formatUkAttendanceTime;
  const formatShiftTime = (item) => `${String(item.scheduled_start || "").slice(0, 5)}–${String(item.scheduled_end || "").slice(0, 5)}`;
  const isArrived = (item) => item.attendance_status === "ON_DUTY" || item.attendance_status === "BOOKED_OFF" || Boolean(eventFor(item, "BOOK_ON"));
  const isCompleted = (item) => item.attendance_status === "BOOKED_OFF" || Boolean(eventFor(item, "BOOK_OFF"));

  const assignedItems = items.filter((item) => item.employee);
  const arrivedItems = assignedItems.filter(isArrived);
  const completedItems = assignedItems.filter(isCompleted);
  const pendingItems = assignedItems.filter((item) => !isArrived(item));
  const unfilledItems = items.filter((item) => !item.employee);
  const exceptions = items.reduce((total, item) => total + eventsFor(item).filter((event) => event.location_status !== "VERIFIED").length, 0);
  const progress = assignedItems.length ? Math.round((arrivedItems.length / assignedItems.length) * 100) : 0;

  const grouped = items.reduce((groups, item) => {
    const name = item.site_name || "Unassigned site";
    if (!groups[name]) groups[name] = [];
    groups[name].push(item);
    return groups;
  }, {});
  const siteNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  const visibleSites = siteNames.filter((siteName) => {
    if (siteFilter !== "ALL" && siteName !== siteFilter) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return siteName.toLowerCase().includes(query) || grouped[siteName].some((item) => (item.employee_name || "").toLowerCase().includes(query) || (item.shift_name || "").toLowerCase().includes(query));
  });

  const statusFor = (item) => {
    if (!item.employee) return { label: "Unfilled shift", className: "pending", hint: "Guard still needed" };
    if (isCompleted(item)) return { label: item.completion_summary?.timesheet_status === "REVIEW_REQUIRED" ? "Completed · Review required" : "Completed", className: item.completion_summary?.timesheet_status === "REVIEW_REQUIRED" ? "pending" : "active", hint: `Book Off ${timeFor(eventFor(item, "BOOK_OFF"))}` };
    if (isArrived(item)) return { label: "Arrived / on duty", className: "present", hint: `Book On ${timeFor(eventFor(item, "BOOK_ON"))}` };
    return { label: "Awaiting arrival", className: "pending", hint: "Book On not received" };
  };

  return <>
    <div className="page-heading control-room-heading">
      <div><p className="eyebrow">CONTROL ROOM</p><h2>Shift attendance</h2><p className="muted">Track today’s guards by site: who is assigned, who has arrived and who is still outstanding. Times shown in Europe/London (GMT/BST).</p></div>
      <div className="report-filters"><input type="date" value={date} onChange={(event) => { setSelectedShift(null); setDate(event.target.value); }} /><CheckUpdatesButton api={api} paths={`/operations/?operation_date=${date}&view=attendance`} currentData={items} onUpdate={setItems} setError={setError} disabled={loading} /></div>
    </div>
    {error && <p className="error page-error">{error}</p>}

    <section className="control-room-overview panel">
      <div className="panel-header"><div><h3>{date === ukDate() ? "Today’s operations" : "Operations for selected date"}</h3><p className="muted">Assigned guards and unfilled positions for this date, using current staffing requirements.</p></div><span className="status-pill present">{date === ukDate() ? "Live today" : date}</span></div>
      <div className="control-room-progress-row"><div><strong>{arrivedItems.length} of {assignedItems.length} guards arrived</strong><span>{pendingItems.length ? `${pendingItems.length} still awaiting Book On` : "All assigned guards have checked in"}</span></div><strong className="control-room-progress-value">{progress}%</strong></div>
      <div className="control-room-progress-track"><span style={{ width: `${progress}%` }} /></div>
      <div className="attendance-legend"><span><i className="legend-dot arrived" /> Arrived / on duty</span><span><i className="legend-dot pending" /> Awaiting arrival</span><span><i className="legend-dot completed" /> Completed</span><span><i className="legend-dot unfilled" /> Unfilled</span></div>
    </section>

    <section className="stats-grid control-room-stats">
      <StatCard label="Assigned guards" value={assignedItems.length} detail={`${siteNames.length} site${siteNames.length === 1 ? "" : "s"} on selected date`} icon={Users} tone="blue" />
      <StatCard label="Arrived / Booked on" value={arrivedItems.length} detail={`${progress}% of assigned guards`} icon={CheckCircle2} tone="teal" />
      <StatCard label="Still pending" value={pendingItems.length} detail="Book On not received" icon={Clock3} tone="amber" />
      <StatCard label="Booked off" value={completedItems.length} detail={`${unfilledItems.length} unfilled shift${unfilledItems.length === 1 ? "" : "s"}`} icon={ClipboardList} tone="rose" />
    </section>

    <section className="panel attendance-site-tracker">
      <div className="panel-header"><div><h3>Site attendance tracker</h3><p className="muted">Selected date only. Unfilled shifts are calculated for each site and shift; they are not the weekly gap total.</p></div><span className="muted">{items.length} shift records</span></div>
      <div className="attendance-filter-row"><div className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search site, guard or shift..." /></div><select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}><option value="ALL">All sites</option>{siteNames.map((siteName) => <option key={siteName} value={siteName}>{siteName}</option>)}</select></div>
      {visibleSites.length ? <div className="attendance-site-grid">{visibleSites.map((siteName) => {
        const siteItems = grouped[siteName];
        const siteAssigned = siteItems.filter((item) => item.employee);
        const siteArrived = siteAssigned.filter(isArrived).length;
        const siteCompleted = siteAssigned.filter(isCompleted).length;
        const siteMissing = siteItems.filter((item) => !item.employee);
        const siteUnfilled = siteMissing.length;
        const siteState = siteUnfilled ? "Needs cover" : siteAssigned.length && siteArrived === siteAssigned.length ? "All arrived" : "In progress";
        const renderGuard = (item) => {
            const state = statusFor(item); const bookOn = eventFor(item, "BOOK_ON"); const bookOff = eventFor(item, "BOOK_OFF"); const hourly = (item.hourly_checkins || []).filter((checkin) => checkin.status === "COMPLETED").length;
            return <div className="attendance-guard-row" key={item.id}><div className="attendance-guard-avatar">{item.employee_name ? item.employee_name.slice(0, 1).toUpperCase() : "?"}</div><div className="attendance-guard-details"><strong>{item.employee_name || "Unfilled shift"}</strong><small className="attendance-mode-label">{siteAttendanceLabel(item)}</small><span>{item.shift_name || "Shift"} · {formatShiftTime(item)}</span><div className="attendance-time-row"><span>{bookOn ? `Book On ${formatTime(bookOn.captured_at)}` : "Book On pending"}</span>{bookOff && <span>Book Off {formatTime(bookOff.captured_at)}</span>}{item.employee && item.expected_hourly_checkins > 0 && <span>{hourly}/{item.expected_hourly_checkins} hourly checks</span>}</div>{bookOn?.late_reason && <div className="attendance-book-on-reason"><strong>Late Book On reason</strong><span>{bookOn.late_reason}</span></div>}</div><div className="attendance-status-block">{item.employee && <button type="button" className="mini-button complete-shift-button" onClick={() => setSelectedShift(item.id)}><History size={13} />View complete shift</button>}<span className={`status-pill ${state.className}`}>{state.label}</span><small>{state.hint}</small>{(bookOn?.photo_url || bookOff?.photo_url) && <div className="attendance-quick-evidence">{bookOn?.photo_url && <ProtectedFilePreview value={bookOn.photo_url} label={`${item.employee_name} · Book On`} buttonLabel="View Book On" />}{bookOff?.photo_url && <ProtectedFilePreview value={bookOff.photo_url} label={`${item.employee_name} · Book Off`} buttonLabel="View Book Off" />}</div>}</div></div>;
        };
        return <article className={`attendance-site-card ${siteUnfilled ? "needs-attention" : ""}`} key={siteName}>
          <div className="attendance-site-header"><div><p className="eyebrow">SITE</p><h3>{siteName}</h3><span>{siteItems.length} shift{siteItems.length === 1 ? "" : "s"} scheduled</span></div><span className={`status-pill ${siteUnfilled ? "pending" : siteArrived === siteAssigned.length ? "present" : "neutral"}`}>{siteState}</span></div>
          <div className="attendance-site-summary"><span><strong>{siteArrived}</strong> arrived</span><span><strong>{Math.max(siteAssigned.length - siteArrived, 0)}</strong> pending</span><span><strong>{siteCompleted}</strong> completed</span></div>
          <div className="attendance-guard-list">{siteAssigned.sort((a, b) => `${a.scheduled_start || ""}${a.employee_name || ""}`.localeCompare(`${b.scheduled_start || ""}${b.employee_name || ""}`)).map(renderGuard)}</div>
          {siteUnfilled > 0 && <details className="attendance-unfilled"><summary>{siteUnfilled} unfilled shift{siteUnfilled === 1 ? "" : "s"}<span>View details</span></summary><div className="attendance-guard-list">{siteMissing.map(renderGuard)}</div></details>}
        </article>;
      })}</div> : <div className="empty-state compact-empty"><ClipboardList size={28} /><strong>No matching site records</strong><span>Try another site, guard or date.</span></div>}
    </section>

    <section className="control-room-bottom-grid">
      <div className="panel"><div className="panel-header"><div><h3>Still to arrive</h3><p className="muted">Assigned guards without a Book On event.</p></div><span className="status-pill pending">{pendingItems.length}</span></div>{pendingItems.length ? <div className="attention-list">{pendingItems.map((item) => <div className="attention-item" key={item.id}><div><strong>{item.employee_name}</strong><span>{item.site_name} · {item.shift_name} · {formatShiftTime(item)}</span></div><span className="status-pill pending">Awaiting</span></div>)}</div> : <div className="tracker-empty"><CheckCircle2 size={18} /><span>Everyone assigned has arrived.</span></div>}</div>
      <div className="panel"><div className="panel-header"><div><h3>Control room alerts</h3><p className="muted">Items that may need an operator’s attention.</p></div><span className={`status-pill ${unfilledItems.length || exceptions ? "pending" : "present"}`}>{unfilledItems.length + exceptions}</span></div>{unfilledItems.length || exceptions ? <div className="attention-list">{unfilledItems.length > 0 && <div className="attention-item"><div><strong>{unfilledItems.length} unfilled shift{unfilledItems.length === 1 ? "" : "s"}</strong><span>Assign cover from Weekly rota.</span></div><span className="status-pill pending">Action needed</span></div>}{exceptions > 0 && <div className="attention-item"><div><strong>{exceptions} location exception{exceptions === 1 ? "" : "s"}</strong><span>Review attendance evidence and GPS status.</span></div><span className="status-pill outside_site">Review</span></div>}</div> : <div className="tracker-empty"><CheckCircle2 size={18} /><span>No alerts for this date.</span></div>}</div>
    </section>
    {selectedShift && <CompleteShiftReview key={selectedShift} operationId={selectedShift} api={api} FilePreview={ProtectedFilePreview} canTrack={canTrack} onUpdate={(updated) => setItems((current) => current.map((item) => item.id === updated.id ? updated : item))} onClose={() => setSelectedShift(null)} />}
  </>;
}

function NotificationsPage() {
  const [items, setItems] = useState([]); const [error, setError] = useState(""); const load = () => api("/notifications/").then(setItems).catch((err) => setError(err.message)); useEffect(() => { load(); }, []); const markRead = async (id) => { try { await api(`/notifications/${id}/mark_read/`, { method: "POST", body: "{}", silentToast: true }); window.dispatchEvent(new Event("rota:notifications-changed")); load(); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">INBOX</p><h2>Notifications</h2><p className="muted">Operational alerts and workflow updates.</p></div></div>{error && <p className="error page-error">{error}</p>}<section className="panel notification-panel">{items.length === 0 ? <div className="empty-state"><Bell size={30} /><strong>No notifications</strong><span>New approvals and operational alerts will appear here.</span></div> : items.map((item) => <div className={item.is_read ? "notification-row read" : "notification-row"} key={item.id}><div className={`notification-icon ${item.notification_type.toLowerCase()}`}><Bell size={16} /></div><div className="notification-copy"><strong>{item.title}</strong><p>{item.message}</p><small>{new Date(item.created_at).toLocaleString()}</small></div>{!item.is_read && <button className="mini-button approve" onClick={() => markRead(item.id)}>Mark read</button>}</div>)}</section></>;
}

function AuditPage() {
  const [items, setItems] = useState([]); const [error, setError] = useState(""); useEffect(() => { api("/audit-logs/").then(setItems).catch((err) => setError(err.message)); }, []);
  return <><div className="page-heading"><div><p className="eyebrow">CONTROL</p><h2>Activity log</h2><p className="muted">Trace important operational changes and approvals.</p></div></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div><h3>Audit events</h3><p className="muted">Newest events appear first.</p></div><span className="muted">{items.length} events</span></div>{items.length === 0 ? <div className="empty-state"><History size={30} /><strong>No activity yet</strong><span>Changes will be recorded as the team uses the system.</span></div> : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Module</th><th>User</th><th>Summary</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{new Date(item.created_at).toLocaleString()}</td><td><span className="status-pill neutral">{item.action}</span></td><td>{item.model_name}</td><td>{item.user_name}</td><td>{item.summary}</td></tr>)}</tbody></table></div>}</section></>;
}

function ClientsPage() {
  const empty = { client_id: "", name: "", contact_name: "", email: "", phone: "", address: "", status: "ACTIVE" };
  const [items, setItems] = useState([]); const [form, setForm] = useState(empty); const [open, setOpen] = useState(false); const [editingId, setEditingId] = useState(null); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const load = () => api("/clients/").then(setItems).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); try { await api(`/clients/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(form) }); setOpen(false); setEditingId(null); setForm(empty); load(); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  const remove = async (id) => { if (!confirm("Deactivate this client?")) return; try { await api(`/clients/${id}/`, { method: "PATCH", body: JSON.stringify({ status: "INACTIVE" }) }); load(); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">CLIENT MANAGEMENT</p><h2>Clients</h2><p className="muted">Add clients, then link each client’s sites and reports.</p></div><button className="primary-button" onClick={() => { setEditingId(null); setForm(empty); setOpen(true); }}><BriefcaseBusiness size={15} /> Add client</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div><h3>Client accounts</h3><p className="muted">Each Client Admin will only see sites belonging to their own client.</p></div><span className="muted">{items.length} clients</span></div>{items.length ? <div className="table-wrap"><table><thead><tr><th>Client ID</th><th>Client</th><th>Contact</th><th>Sites</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.client_id}</td><td><strong>{item.name}</strong><small className="table-subtext">{item.email || "No email"}</small></td><td>{item.contact_name || item.phone || "—"}</td><td>{item.sites_count}</td><td><span className={`status-pill ${item.status === "ACTIVE" ? "active" : "inactive"}`}>{item.status === "ACTIVE" ? "Active" : "Inactive"}</span></td><td><div className="row-actions"><button className="mini-button" onClick={() => { setEditingId(item.id); setForm(item); setOpen(true); }}><Pencil size={13} /> Edit</button>{item.status === "ACTIVE" && <button className="mini-button reject" onClick={() => remove(item.id)}><Trash2 size={13} /> Deactivate</button>}</div></td></tr>)}</tbody></table></div> : <div className="empty-state"><BriefcaseBusiness size={30} /><strong>No clients found</strong><span>Add your first client before creating client sites.</span></div>}</section>{open && <div className="modal-backdrop"><form className="modal-card" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EDIT CLIENT" : "NEW CLIENT"}</p><h3>{editingId ? "Edit client" : "Add client"}</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Client ID<input required value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} placeholder="CLIENT-001" /></label><label>Company name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Contact name<input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} /></label><label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label><label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label><label className="full-width">Address<textarea rows="2" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save client"}</button></div></form></div>}</>;
}

function ClientPortal({ user, onSignOut }) {
  const [data, setData] = useState(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); api("/client-portal/summary/").then(setData).catch((err) => setError(err.message)).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, []);
  const assignments = (data?.published_rotas || []).flatMap((item) => item.assignments.map((assignment) => ({ ...assignment, week_start: item.rota_week.week_start })));
  return <main className="client-portal-shell"><header className="client-portal-header"><div className="sidebar-brand"><div className="brand-lockup"><img className="brand-logo" src="/branding/rotaops-logo.jpg" alt="RotaOps" /></div></div><div className="client-portal-user"><span>{user.role_label || "Client Admin"}</span><strong>{data?.client?.name || "Client"}</strong><button className="logout-button" onClick={onSignOut}><LogOut size={16} /> Sign out</button></div></header><div className="client-portal-content"><div className="page-heading"><div><p className="eyebrow">CLIENT PORTAL</p><h1>{data?.client?.name || "Your operations"}</h1><p className="muted">View your sites, published rota, attendance and daily reports.</p></div><CheckUpdatesButton api={api} paths="/client-portal/summary/" currentData={data} onUpdate={setData} setError={setError} disabled={loading} /></div>{error && <p className="error page-error">{error}</p>}{loading ? <section className="panel"><div className="empty-state">Loading client information...</div></section> : <><section className="client-portal-stats"><article><span>Sites</span><strong>{data?.sites?.length || 0}</strong><small>Active client sites</small></article><article><span>Published shifts</span><strong>{assignments.length}</strong><small>Available rota assignments</small></article><article><span>Attendance records</span><strong>{data?.operations?.length || 0}</strong><small>Recent and upcoming shifts</small></article><article><span>Reports</span><strong>{data?.reports?.length || 0}</strong><small>Last 30 days</small></article></section><section className="panel"><div className="panel-header"><div><h3>My sites</h3><p className="muted">Sites linked to this client account.</p></div></div><div className="table-wrap"><table><thead><tr><th>Site</th><th>Address</th><th>Required guards</th><th>Contact</th><th>Status</th></tr></thead><tbody>{(data?.sites || []).map((site) => <tr key={site.id}><td><strong>{site.name}</strong><small className="table-subtext">{site.site_id}</small></td><td>{site.address || "—"}</td><td>{site.required_guards}</td><td>{site.contact_name || site.contact_phone || "—"}</td><td><span className="status-pill active">Active</span></td></tr>)}</tbody></table></div></section><section className="panel"><div className="panel-header"><div><h3>Published weekly rota</h3><p className="muted">Read-only rota shared by the operations team.</p></div><span className="status-pill neutral">READ ONLY</span></div><div className="table-wrap"><table><thead><tr><th>Week</th><th>Date</th><th>Shift</th><th>Site</th><th>Guard</th></tr></thead><tbody>{assignments.length ? assignments.map((assignment) => <tr key={`${assignment.week_start}-${assignment.id}`}><td>{assignment.week_start}</td><td>{assignment.work_date}</td><td>{assignment.shift_name}</td><td>{assignment.site_name}</td><td>{assignment.employee_name || "Unfilled"}</td></tr>) : <tr><td colSpan="5"><div className="empty-state compact-empty">No published rota available.</div></td></tr>}</tbody></table></div></section><section className="panel"><div className="panel-header"><div><h3>Attendance & reached-at-site</h3><p className="muted">Guard attendance status and evidence summary for your sites.</p></div></div><div className="table-wrap"><table><thead><tr><th>Date</th><th>Site</th><th>Shift</th><th>Guard</th><th>Status</th><th>Book on</th><th>Book off</th></tr></thead><tbody>{(data?.operations || []).map((operation) => <tr key={operation.id}><td>{operation.operation_date}</td><td>{operation.site_name}</td><td>{operation.shift_name}</td><td>{operation.employee_name || "Unassigned"}</td><td><span className={`status-pill ${operation.attendance_status === "BOOKED_OFF" ? "active" : operation.attendance_status === "ON_DUTY" ? "present" : "pending"}`}>{operation.attendance_status.replaceAll("_", " ")}</span></td><td>{operation.attendance_events?.find((event) => event.event_type === "BOOK_ON")?.captured_at ? new Date(operation.attendance_events.find((event) => event.event_type === "BOOK_ON").captured_at).toLocaleString() : "—"}</td><td>{operation.attendance_events?.find((event) => event.event_type === "BOOK_OFF")?.captured_at ? new Date(operation.attendance_events.find((event) => event.event_type === "BOOK_OFF").captured_at).toLocaleString() : "—"}</td></tr>)}</tbody></table></div></section><section className="panel"><div className="panel-header"><div><h3>Daily reports</h3><p className="muted">Private day/night PDF reports for this client only.</p></div></div><div className="table-wrap"><table><thead><tr><th>Date</th><th>Shift</th><th>Scheduled</th><th>Reached</th><th>Not reached</th><th>PDF</th></tr></thead><tbody>{(data?.reports || []).map((report) => <tr key={report.id}><td>{report.report_date}</td><td>{report.shift_name}</td><td>{report.scheduled_count}</td><td>{report.reached_count}</td><td>{report.not_reached_count}</td><td>{report.pdf_url ? <button type="button" className="file-link-button" onClick={() => openProtectedFile(report.pdf_url, "Report PDF").catch((err) => setError(err.message))}>Open PDF</button> : "—"}</td></tr>)}</tbody></table></div></section></>}</div></main>;
}

function UsersPage() {
  const empty = { username: "", first_name: "", last_name: "", email: "", role: "OPERATOR", managed_site_ids: [], client_id: "", password: "", is_active: true };
  const roleLabels = { SUPER_ADMIN: "Super Admin", ADMIN: "Admin", MANAGER: "Manager", OPERATOR: "Operator", RECEPTIONIST: "Operator (legacy)", EMPLOYEE: "Guard", CLIENT_ADMIN: "Client Admin" };
  const [items, setItems] = useState([]); const [sites, setSites] = useState([]); const [clients, setClients] = useState([]); const [form, setForm] = useState(empty); const [open, setOpen] = useState(false); const [editingId, setEditingId] = useState(null); const [error, setError] = useState("");
  const load = () => api("/users/").then(setItems).catch((err) => setError(err.message));
  useEffect(() => { load(); api("/sites/").then(setSites).catch(() => {}); api("/clients/").then(setClients).catch(() => {}); }, []);
  const save = async (event) => { event.preventDefault(); setError(""); const payload = { ...form, managed_site_ids: form.role === "MANAGER" ? form.managed_site_ids : [], client_id: form.role === "CLIENT_ADMIN" ? (form.client_id ? Number(form.client_id) : null) : null }; if (!payload.password) delete payload.password; try { await api(`/users/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) }); setOpen(false); setEditingId(null); setForm(empty); load(); } catch (err) { setError(err.message); } };
  const remove = async (id) => { if (!confirm("Deactivate this account?")) return; try { await api(`/users/${id}/`, { method: "PATCH", body: JSON.stringify({ is_active: false }) }); load(); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h2>User management</h2><p className="muted">Super Admin controls staff accounts and least-privilege roles.</p></div><button className="primary-button" onClick={() => { setEditingId(null); setForm(empty); setOpen(true); }}><UserPlus size={15} /> Add user</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div><h3>Accounts</h3><p className="muted">Super Admin → Admin → Manager → Operator → Guard · Client Admin.</p></div><span className="muted">{items.length} users</span></div><div className="table-wrap"><table><thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>Scope</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.username}</strong></td><td>{[item.first_name, item.last_name].filter(Boolean).join(" ") || "—"}</td><td>{item.email || "—"}</td><td><span className="status-pill neutral">{roleLabels[item.role_display] || item.role_display || "Operator"}</span></td><td>{item.role_display === "MANAGER" ? `${(item.managed_site_ids || []).length} site(s)` : item.role_display === "CLIENT_ADMIN" ? `${clients.find((client) => client.id === item.client_id)?.name || "Client"}` : item.role_display === "SUPER_ADMIN" ? "All system" : "—"}</td><td><span className={`status-pill ${item.is_active ? "active" : "inactive"}`}>{item.is_active ? "Active" : "Inactive"}</span></td><td><div className="row-actions"><button className="mini-button" onClick={() => { setEditingId(item.id); setForm({ ...empty, ...item, role: item.role_display || "OPERATOR", managed_site_ids: item.managed_site_ids || [], client_id: item.client_id || "", password: "" }); setOpen(true); }}><Pencil size={13} /> Edit</button>{item.is_active && <button className="mini-button reject" onClick={() => remove(item.id)}><Trash2 size={13} /> Deactivate</button>}</div></td></tr>)}</tbody></table></div></section>{open && <div className="modal-backdrop"><form className="modal-card" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EDIT ACCOUNT" : "NEW ACCOUNT"}</p><h3>{editingId ? "Edit user" : "Create user"}</h3></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Username<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label><label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>First name<input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></label><label>Last name<input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></label><label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="SUPER_ADMIN">Super Admin</option><option value="ADMIN">Admin</option><option value="MANAGER">Manager</option><option value="OPERATOR">Operator</option><option value="EMPLOYEE">Guard</option><option value="CLIENT_ADMIN">Client Admin</option></select></label>{form.role === "MANAGER" && <label className="full-width">Managed sites<select multiple value={form.managed_site_ids} onChange={(e) => setForm({ ...form, managed_site_ids: Array.from(e.target.selectedOptions, (option) => Number(option.value)) })}>{sites.map((site) => <option key={site.id} value={site.id}>{site.site_id} · {site.name}</option>)}</select><small className="muted">Hold Ctrl/Cmd to select multiple sites.</small></label>}{form.role === "CLIENT_ADMIN" && <label className="full-width">Client<select required value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}><option value="">Select client</option>{clients.filter((client) => client.status === "ACTIVE").map((client) => <option key={client.id} value={client.id}>{client.client_id} · {client.name}</option>)}</select></label>}<label>Password<input type="password" minLength="8" required={!editingId} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={editingId ? "Leave blank to keep current" : "Minimum 8 characters"} /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button">Save account</button></div></form></div>}</>;
}

const employeeDocumentChecklist = [
  { key: "passport", label: "Passport (First 2 pages)", hint: "Upload the first two passport pages.", required: true, expiry: true },
  { key: "sia_front", label: "SIA Card (Front)", hint: "Upload the front and enter the card number.", required: true, expiry: true, number: true },
  { key: "sia_back", label: "SIA Card (Back)", hint: "Upload the back of the SIA card.", required: true },
  { key: "proof_address_1", label: "Proof of Address 1 (last 3 months)", hint: "Driving licence, utility bill or council tax bill dated within 3 months.", required: true },
  { key: "proof_address_2", label: "Proof of Address 2 (last 3 months)", hint: "A second address proof dated within 3 months.", required: true },
  { key: "share_code", label: "Share Code", hint: "Upload evidence or enter the code in notes.", required: true, expiry: true },
  { key: "ni_number", label: "National Insurance Number (NI)", hint: "Upload evidence or enter the number in notes.", required: true },
  { key: "photograph", label: "Personal Photograph", hint: "Upload a recent clear photograph.", required: true, accept: "image/*" },
  { key: "act_certificate", label: "ACT certificate", hint: "Optional — upload if you have one.", required: false, expiry: true },
  { key: "cscs_front", label: "CSCS Card (Front)", hint: "Upload the front and enter the card number.", required: true, expiry: true, number: true },
  { key: "cscs_back", label: "CSCS Card (Back)", hint: "Upload the back of the CSCS card.", required: true },
  { key: "driving_front", label: "Driving License (Front)", hint: "Upload the front of the driving license.", required: true },
  { key: "driving_back", label: "Driving License (Back)", hint: "Upload the back of the driving license.", required: true },
  { key: "ppac_code", label: "PPAC Code", hint: "Upload evidence or enter the code in notes.", required: true },
];

function profileDocumentUrl(item) {
  if (!item) return "";
  return item.secure_file_url || (item.file ? absoluteFileUrl(item.file) : item.file_url || "");
}

function PasswordChange() {
  const [form, setForm] = useState({ current_password: "", new_password: "", new_password_confirmation: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try { await api("/employees/change-password/", { method: "POST", body: JSON.stringify(form) }); setForm({ current_password: "", new_password: "", new_password_confirmation: "" }); setNotice("Password changed successfully."); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  return <form className="panel password-panel" onSubmit={submit}><div className="panel-header"><div><h3>Change password</h3><p className="muted">Keep your portal account secure. Use at least 8 characters.</p></div></div><div className="form-grid"><label>Current password<input required type="password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} /></label><label>New password<input required minLength="8" type="password" value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} /></label><label>Confirm new password<input required minLength="8" type="password" value={form.new_password_confirmation} onChange={(e) => setForm({ ...form, new_password_confirmation: e.target.value })} /></label></div>{error && <p className="error">{error}</p>}{notice && <p className="success">{notice}</p>}<div className="modal-actions"><button className="primary-button" disabled={saving}>{saving ? "Updating..." : "Change password"}</button></div></form>;
}

function EmployeeProfilePage({ section = "profile", onProfile, initialDocumentId }) {
  return <div className="profile-page-shell">{section === "profile" ? <GuardProfileWizard api={api} Image={ProtectedImage} /> : section === "documents" ? <GuardDocumentsWizard api={api} Image={ProtectedImage} FilePreview={ProtectedFilePreview} onProfile={onProfile} initialDocumentId={initialDocumentId} /> : <EmployeeProfileContentV2 section={section} />}</div>;
}

function EmployeeProfileContent({ section = "profile" }) {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ name: "", date_of_birth: "", nationality: "", position: "", phone: "", email: "", address: "", emergency_contact_name: "", emergency_contact_phone: "", emergency_contact_relationship: "", joining_date: "" });
  const [documents, setDocuments] = useState([]);
  const [documentDrafts, setDocumentDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [documentSaving, setDocumentSaving] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setLoading(true); setError("");
    try {
      const data = await api("/employees/me/");
      setProfile(data);
      setForm({ name: data.name || "", date_of_birth: data.date_of_birth || "", nationality: data.nationality || "", position: data.position || "", phone: data.phone || "", email: data.email || "", address: data.address || "", emergency_contact_name: data.emergency_contact_name || "", emergency_contact_phone: data.emergency_contact_phone || "", emergency_contact_relationship: data.emergency_contact_relationship || "", joining_date: data.joining_date || "" });
      setDocuments(await api(`/documents/?employee=${data.id}`));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const save = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try { const data = await api("/employees/me/", { method: "PATCH", body: JSON.stringify(form) }); setProfile(data); setNotice("Profile updated successfully."); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const updateDocumentDraft = (key, changes) => setDocumentDrafts((current) => ({ ...current, [key]: { ...(current[key] || {}), ...changes } }));
  const exactDocument = (item) => documents.find((document) => document.document_type === item.label);
  const displayDocument = (item) => exactDocument(item) || ((item.key === "sia_front" || item.key === "sia_back") ? documents.find((document) => document.document_type === "SIA Card (Front & Back)") : null);
  const saveDocument = async (item, silent = false) => {
    const draft = documentDrafts[item.key] || {};
    const existing = exactDocument(item);
    const note = (draft.notes ?? existing?.notes ?? "").trim();
    const issueDate = draft.issue_date ?? existing?.issue_date ?? "";
    const documentNumber = draft.document_number ?? existing?.document_number ?? "";
    const hasChanges = Boolean(draft.file || documentNumber || Object.prototype.hasOwnProperty.call(draft, "document_number") || Object.prototype.hasOwnProperty.call(draft, "notes") || Object.prototype.hasOwnProperty.call(draft, "issue_date") || Object.prototype.hasOwnProperty.call(draft, "expiry_date"));
    if (!hasChanges) return false;
    setDocumentSaving(item.key); setError(""); setNotice("");
    const payload = new FormData();
    payload.append("employee", String(profile.id));
    payload.append("document_type", item.label);
    if (documentNumber) payload.append("document_number", documentNumber.trim());
    payload.append("notes", note);
    if (issueDate) payload.append("issue_date", issueDate);
    const expiryDate = draft.expiry_date ?? existing?.expiry_date ?? "";
    if (expiryDate) payload.append("expiry_date", expiryDate);
    if (draft.file) payload.append("file", draft.file);
    try {
      const saved = await api(existing ? `/documents/${existing.id}/` : "/documents/", { method: existing ? "PATCH" : "POST", body: payload });
      setDocuments((current) => existing ? current.map((document) => document.id === existing.id ? saved : document) : [...current, saved]);
      setDocumentDrafts((current) => ({ ...current, [item.key]: { document_number: "", notes: "", file: null, issue_date: "", expiry_date: "" } }));
      if (!silent) setNotice(`${item.label} saved successfully.`);
      return true;
    } catch (err) { setError(err.message); throw err; } finally { setDocumentSaving(""); }
  };
  const saveAllDocuments = async () => {
    setDocumentSaving("all"); setError(""); setNotice("");
    try {
      for (const item of employeeDocumentChecklist) await saveDocument(item, true);
      setDocumentDrafts({}); setNotice("All document updates saved successfully.");
    } catch (err) {
      setError(err.message);
    } finally { setDocumentSaving(""); }
  };
  if (loading) return <div className="empty-view"><RotaLoader label="Loading your profile…" /></div>;
  const completedRequiredDocuments = employeeDocumentChecklist.filter((item) => item.required && displayDocument(item)).length;
  const documentsCompletion = { completed: completedRequiredDocuments, required: employeeDocumentChecklist.filter((item) => item.required).length, percentage: Math.round(completedRequiredDocuments / employeeDocumentChecklist.filter((item) => item.required).length * 100) };
  const sectionTitle = section === "password" ? "Change password" : section === "documents" ? "Documents" : "My profile";
  const sectionDescription = section === "password" ? "Update your portal password regularly to keep your account secure." : section === "documents" ? "Upload and update your compliance documents in one place." : "Keep your personal details up to date.";
  return <><div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>{sectionTitle}</h2><p className="muted">{sectionDescription}</p></div><span className="profile-progress-badge">{section === "documents" ? `${documentsCompletion.completed}/${documentsCompletion.required} required` : section === "password" ? "Account security" : `${profile?.profile_completion || 0}% details`}</span></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}{section === "profile" && <section className="profile-layout"><article className="panel profile-card"><div className="profile-card-header"><div className="profile-avatar">{profile?.profile_photo_url ? <ProtectedImage src={profile.profile_photo_url} alt={`${profile?.name || "Guard"} profile`} /> : (profile?.name || "?").slice(0, 1).toUpperCase()}</div><div><h3>{profile?.name}</h3><p className="muted">{profile?.employee_id} · {profile?.position || "Guard"}</p></div></div><div className="profile-progress"><div><strong>Personal details</strong><span>{profile?.profile_completion || 0}%</span></div><div className="progress-track"><span style={{ width: `${profile?.profile_completion || 0}%` }} /></div><small>Complete your contact and emergency fields so the office can reach you.</small></div><div className="profile-progress document-progress"><div><strong>Required documents</strong><span>{documentsCompletion.completed}/{documentsCompletion.required}</span></div><div className="progress-track"><span style={{ width: `${documentsCompletion.percentage}%` }} /></div><small>ACT certificate is optional and is not included in this count.</small></div></article><form className="panel profile-form" onSubmit={save}><div className="panel-header"><div><h3>Personal details</h3><p className="muted">Email and emergency contact details are kept with your profile.</p></div></div><div className="form-grid"><label>Employee ID<input value={profile?.employee_id || ""} disabled /></label><label>Full name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Position<input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} /></label><label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+92..." /></label><label>Email address<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Joining date<input type="date" value={form.joining_date} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} /></label><label className="full-width">Address<textarea rows="3" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Emergency contact name<input value={form.emergency_contact_name} onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })} /></label><label>Emergency contact phone<input value={form.emergency_contact_phone} onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })} /></label><label>Relationship<input value={form.emergency_contact_relationship} onChange={(e) => setForm({ ...form, emergency_contact_relationship: e.target.value })} placeholder="Parent, spouse, sibling..." /></label></div><div className="modal-actions"><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save profile"}</button></div></form></section>}{section === "password" && <PasswordChange />}{section === "documents" && <section className="panel profile-documents-panel"><div className="panel-header"><div><h3>Documents</h3><p className="muted">Upload all documents above, then save them together once at the bottom.</p></div><span className="muted">{documentsCompletion.completed}/{documentsCompletion.required} required</span></div><div className="document-checklist">{employeeDocumentChecklist.map((item) => { const existing = displayDocument(item); const draft = documentDrafts[item.key] || {}; const completed = Boolean(existing); const reviewStatus = existing?.verification_status || ""; const reviewLabel = { PENDING: "Pending review", VERIFIED: "Verified", REJECTED: "Rejected" }[reviewStatus] || "Not submitted"; const proofAddress = item.key.startsWith("proof_address"); const textOnly = item.key === "share_code" || item.key === "ni_number" || item.key === "ppac_code"; return <article className={`document-checklist-card ${completed ? "complete" : "missing"}`} key={item.key}><div className="document-card-top"><div><strong>{item.label}</strong><small>{item.hint}</small></div><span className={`status-pill ${completed ? "active" : item.required ? "pending" : "neutral"}`}>{completed ? "Uploaded" : item.required ? "Required" : "Optional"}</span></div>{existing && <div className={`document-review-state ${reviewStatus.toLowerCase() || "missing"}`}><span className="document-review-icon">{reviewStatus === "VERIFIED" ? "✓" : reviewStatus === "REJECTED" ? "!" : "•"}</span><div><strong>{reviewLabel}</strong>{existing.rejection_reason && <small>{existing.rejection_reason}</small>}</div></div>}{existing && <div className="document-existing">{profileDocumentUrl(existing) ? <ProtectedFilePreview value={profileDocumentUrl(existing)} label={item.label} buttonLabel="View current file" /> : <span><FileText size={13} /> Saved in notes</span>}</div>}{proofAddress && <label className="document-notes-label">Document date<input type="date" value={draft.issue_date ?? exactDocument(item)?.issue_date ?? ""} max={new Date().toISOString().slice(0, 10)} onChange={(e) => updateDocumentDraft(item.key, { issue_date: e.target.value })} /></label>}{item.expiry && <label className="document-notes-label">Expiry date<input type="date" value={draft.expiry_date ?? exactDocument(item)?.expiry_date ?? ""} onChange={(e) => updateDocumentDraft(item.key, { expiry_date: e.target.value })} /></label>}<label className="document-file-input">{existing ? "Replace file" : "Upload document"}<input type="file" accept={item.accept || ".pdf,.jpg,.jpeg,.png"} onChange={(e) => updateDocumentDraft(item.key, { file: e.target.files?.[0] || null })} /></label>{(textOnly || existing?.notes) && <label className="document-notes-label">Code / notes<textarea rows="2" value={draft.notes ?? exactDocument(item)?.notes ?? ""} onChange={(e) => updateDocumentDraft(item.key, { notes: e.target.value })} placeholder={item.key === "share_code" ? "Enter share code" : item.key === "ni_number" ? "Enter NI number" : item.key === "ppac_code" ? "Enter PPAC code" : "Add a note"} /></label>}</article>; })}</div><div className="document-save-all"><p className="muted">Check each card, then save all new files and updates together.</p><button type="button" className="primary-button" disabled={documentSaving === "all"} onClick={saveAllDocuments}>{documentSaving === "all" ? "Saving documents..." : "Save all documents"}</button></div></section>}</>;
}

function EmployeeProfileContentV2({ section = "profile" }) {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ name: "", date_of_birth: "", nationality: "", position: "", phone: "", email: "", address: "", emergency_contact_name: "", emergency_contact_phone: "", emergency_contact_relationship: "", joining_date: "" });
  const [documents, setDocuments] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingDocuments, setSavingDocuments] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setLoading(true); setError("");
    try {
      const data = await api("/employees/me/");
      setProfile(data);
      setForm({ name: data.name || "", date_of_birth: data.date_of_birth || "", nationality: data.nationality || "", position: data.position || "", phone: data.phone || "", email: data.email || "", address: data.address || "", emergency_contact_name: data.emergency_contact_name || "", emergency_contact_phone: data.emergency_contact_phone || "", emergency_contact_relationship: data.emergency_contact_relationship || "", joining_date: data.joining_date || "" });
      setDocuments(await api(`/documents/?employee=${data.id}`));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const setDraft = (key, changes) => setDrafts((current) => ({ ...current, [key]: { ...(current[key] || {}), ...changes } }));
  const exactDocument = (item) => documents.find((document) => document.document_type === item.label);
  const displayDocument = (item) => exactDocument(item) || ((item.key === "sia_front" || item.key === "sia_back") ? documents.find((document) => document.document_type === "SIA Card (Front & Back)") : null);
  const saveProfile = async (event) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try { const data = await api("/employees/me/", { method: "PATCH", body: JSON.stringify(form) }); setProfile(data); setNotice("Profile updated successfully."); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const saveDocument = async (item, silent = false) => {
    const draft = drafts[item.key] || {};
    const existing = exactDocument(item);
    const documentNumber = draft.document_number ?? existing?.document_number ?? "";
    const notes = (draft.notes ?? existing?.notes ?? "").trim();
    const issueDate = draft.issue_date ?? existing?.issue_date ?? "";
    const expiryDate = draft.expiry_date ?? existing?.expiry_date ?? "";
    if (!draft.file && !documentNumber && !Object.prototype.hasOwnProperty.call(draft, "document_number") && !Object.prototype.hasOwnProperty.call(draft, "notes") && !Object.prototype.hasOwnProperty.call(draft, "issue_date") && !Object.prototype.hasOwnProperty.call(draft, "expiry_date")) return;
    const payload = new FormData(); payload.append("employee", String(profile.id)); payload.append("document_type", item.label); payload.append("notes", notes);
    if (documentNumber) payload.append("document_number", documentNumber.trim());
    if (issueDate) payload.append("issue_date", issueDate); if (expiryDate) payload.append("expiry_date", expiryDate); if (draft.file) payload.append("file", draft.file);
    const saved = await api(existing ? `/documents/${existing.id}/` : "/documents/", { method: existing ? "PATCH" : "POST", body: payload });
    setDocuments((current) => existing ? current.map((document) => document.id === existing.id ? saved : document) : [...current, saved]);
    setDrafts((current) => ({ ...current, [item.key]: {} }));
    if (!silent) setNotice(`${item.label} saved successfully.`);
  };
  const saveAllDocuments = async () => {
    setSavingDocuments(true); setError(""); setNotice("");
    try { for (const item of employeeDocumentChecklist) await saveDocument(item, true); setNotice("All document updates saved successfully."); }
    catch (err) { setError(err.message); } finally { setSavingDocuments(false); }
  };
  if (loading) return <div className="empty-view"><RotaLoader label="Loading your profile…" /></div>;
  const completed = employeeDocumentChecklist.filter((item) => item.required && displayDocument(item)).length;
  const required = employeeDocumentChecklist.filter((item) => item.required).length;
  const sectionTitle = section === "password" ? "Change password" : section === "documents" ? "Documents" : "My profile";
  if (section === "password") return <><div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>{sectionTitle}</h2></div></div><PasswordChange /></>;
  return <><div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>{sectionTitle}</h2><p className="muted">{section === "documents" ? "Upload your compliance documents and keep your induction information up to date." : "Keep your personal, contact and emergency details up to date."}</p></div><span className="profile-progress-badge">{section === "documents" ? `${completed}/${required} required` : `${profile?.profile_completion || 0}% details`}</span></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}{section === "profile" && <section className="profile-layout"><article className="panel profile-card"><div className="profile-card-header"><div className="profile-avatar">{profile?.profile_photo_url ? <ProtectedImage src={profile.profile_photo_url} alt={`${profile?.name || "Guard"} profile`} /> : (profile?.name || "?").slice(0, 1).toUpperCase()}</div><div><h3>{profile?.name}</h3><p className="muted">{profile?.employee_id} · {profile?.position || "Guard"}</p></div></div><div className="profile-progress"><div><strong>Personal details</strong><span>{profile?.profile_completion || 0}%</span></div><div className="progress-track"><span style={{ width: `${profile?.profile_completion || 0}%` }} /></div><small>Complete these details so the office can prepare your site induction.</small></div></article><form className="panel profile-form" onSubmit={saveProfile}><div className="panel-header"><div><h3>Personal details</h3><p className="muted">Use your legal name, current address and emergency contact details.</p></div></div><div className="form-grid"><label>Employee ID<input value={profile?.employee_id || ""} disabled /></label><label>Full name (first name + surname)<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="First name Surname" /></label><label>Date of birth<input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></label><label>Nationality<input value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} placeholder="Select nationality" /></label><label>Position<input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} /></label><label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+92..." /></label><label>Email address<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Joining date<input type="date" value={form.joining_date} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} /></label><label className="full-width">Address<textarea rows="3" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Emergency contact name<input value={form.emergency_contact_name} onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })} /></label><label>Emergency contact phone<input value={form.emergency_contact_phone} onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })} /></label><label>Relationship<input value={form.emergency_contact_relationship} onChange={(e) => setForm({ ...form, emergency_contact_relationship: e.target.value })} placeholder="Parent, spouse, sibling..." /></label></div><div className="modal-actions"><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save profile"}</button></div></form></section>}{section === "documents" && <section className="panel profile-documents-panel"><div className="panel-header"><div><h3>Documents</h3><p className="muted">Add card numbers and expiry dates where required, then save everything together.</p></div><span className="muted">{completed}/{required} required</span></div><div className="document-checklist">{employeeDocumentChecklist.map((item) => { const existing = displayDocument(item); const draft = drafts[item.key] || {}; const reviewStatus = existing?.verification_status || ""; const textOnly = ["share_code", "ni_number", "ppac_code"].includes(item.key); const proofAddress = item.key.startsWith("proof_address"); return <article className={`document-checklist-card ${existing ? "complete" : "missing"}`} key={item.key}><div className="document-card-top"><div><strong>{item.label}</strong><small>{item.hint}</small></div><span className={`status-pill ${existing ? "active" : item.required ? "pending" : "neutral"}`}>{existing ? "Uploaded" : item.required ? "Required" : "Optional"}</span></div>{existing && <div className={`document-review-state ${reviewStatus.toLowerCase() || "missing"}`}><span className="document-review-icon">{reviewStatus === "VERIFIED" ? "✓" : reviewStatus === "REJECTED" ? "!" : "•"}</span><div><strong>{{ PENDING: "Pending review", VERIFIED: "Verified", REJECTED: "Rejected" }[reviewStatus] || "Not submitted"}</strong>{existing.rejection_reason && <small>{existing.rejection_reason}</small>}</div></div>}{item.number && <label className="document-notes-label">Card number<input value={draft.document_number ?? existing?.document_number ?? ""} onChange={(e) => setDraft(item.key, { document_number: e.target.value })} placeholder="Enter card number" /></label>}{proofAddress && <label className="document-notes-label">Document date<input type="date" value={draft.issue_date ?? existing?.issue_date ?? ""} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDraft(item.key, { issue_date: e.target.value })} /></label>}{item.expiry && <label className="document-notes-label">Expiry date<input type="date" value={draft.expiry_date ?? existing?.expiry_date ?? ""} onChange={(e) => setDraft(item.key, { expiry_date: e.target.value })} /></label>}<label className="document-file-input">{existing ? "Replace file" : "Upload document"}<input type="file" accept={item.accept || ".pdf,.jpg,.jpeg,.png"} onChange={(e) => setDraft(item.key, { file: e.target.files?.[0] || null })} /></label>{(textOnly || existing?.notes) && <label className="document-notes-label">Code / notes<textarea rows="2" value={draft.notes ?? existing?.notes ?? ""} onChange={(e) => setDraft(item.key, { notes: e.target.value })} placeholder={item.key === "ppac_code" ? "Enter PPAC code" : item.key === "share_code" ? "Enter share code" : item.key === "ni_number" ? "Enter NI number" : "Add a note"} /></label>}{existing && profileDocumentUrl(existing) && <ProtectedFilePreview value={profileDocumentUrl(existing)} label={item.label} buttonLabel="View current file" />}</article>; })}</div><div className="document-save-all"><p className="muted">Save all uploaded documents, card numbers and updates together.</p><button type="button" className="primary-button" disabled={savingDocuments} onClick={saveAllDocuments}>{savingDocuments ? "Saving documents..." : "Save all documents"}</button></div></section>}</>;
}

function GuardInductionPageV2({ canManageCortex = false }) {
  const [sites, setSites] = useState([]); const [employees, setEmployees] = useState([]); const [inductions, setInductions] = useState([]); const [documents, setDocuments] = useState([]); const [siteFilter, setSiteFilter] = useState("");
  const [form, setForm] = useState({ site: "", employee: "", induction_date: new Date().toISOString().slice(0, 10), induction_time: "", status: "PLANNED", notes: "" }); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const load = async () => { setLoading(true); setError(""); try { setInductions(await api(`/site-inductions/${siteFilter ? `?site=${siteFilter}` : ""}`)); } catch (err) { setError(err.message); } finally { setLoading(false); } };
  useEffect(() => { Promise.all([api("/sites/"), api("/employees/?status=ACTIVE")]).then(([siteItems, employeeItems]) => { setSites(siteItems); setEmployees(employeeItems); }).catch((err) => setError(err.message)); }, []);
  useEffect(() => { load(); }, [siteFilter]);
  useEffect(() => { if (!form.employee) { setDocuments([]); return; } api(`/documents/?employee=${form.employee}`).then(setDocuments).catch((err) => setError(err.message)); }, [form.employee]);
  const portalReadyEmployees = employees.filter((employee) => employee.portal_status === "ACTIVE"); const selectedGuard = portalReadyEmployees.find((employee) => String(employee.id) === String(form.employee));
  const selectedSite = sites.find((site) => String(site.id) === form.site);
  const needsCortexActivation = canManageCortex && form.status !== "CANCELLED" && selectedGuard && selectedSite?.is_active
    && selectedSite.cortex_itime_enabled && (!selectedGuard.cortex_itime_enabled
      || !selectedGuard.cortex_itime_sites?.some((entry) => entry.id === selectedSite.id));
  const [activationNotice, setActivationNotice] = useState("");
  const documentFor = (...types) => documents.find((document) => types.includes(document.document_type)); const documentDetails = (...types) => { const matches = documents.filter((document) => types.includes(document.document_type)); return { document_number: matches.find((document) => document.document_number)?.document_number || "", expiry_date: matches.find((document) => document.expiry_date)?.expiry_date || "" }; }; const sia = documentDetails("SIA Card (Front)", "SIA Card (Front & Back)", "SIA Card (Back)"), cscs = documentDetails("CSCS Card (Front)", "CSCS Card (Front & Back)", "CSCS Card (Back)"), ppac = documentFor("PPAC Code");
  const display = (value) => value || "Not added yet"; const emergencyName = selectedGuard?.emergency_contact_name || selectedGuard?.emergency_contact || "";
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); setNotice(""); setActivationNotice(""); try { const induction = await api("/site-inductions/", { method: "POST", body: JSON.stringify({ ...form, site: Number(form.site), employee: Number(form.employee), induction_time: form.induction_time || null }) }); setNotice("Induction saved. The guard is now linked to this site in Weekly Rota.");
      if (induction.cortex_activation_required) setActivationNotice(cortexActivationWarning(selectedGuard || { name: induction.employee_name }, selectedSite || { name: induction.site_name })); setForm((current) => ({ ...current, employee: "", induction_time: "", notes: "" })); await load(); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  const downloadInduction = async (induction) => { setError(""); try { const safeName = (induction.employee_name || "Guard").replace(/[^a-z0-9 ._-]/gi, "").trim() || "Guard"; await downloadFile(`/site-inductions/${induction.id}/download-csv/`, `${safeName} - induction.csv`); setNotice(`${induction.employee_name} induction downloaded.`); } catch (err) { setError(err.message); } };
  return <><div className="page-heading"><div><p className="eyebrow">SITE COMPLIANCE</p><h2>Guard induction</h2><p className="muted">Capture each guard’s personal and compliance information before assigning them to a site.</p></div></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}{activationNotice && <p className="cortex-itime-warning" role="status">{activationNotice}</p>}<section className="panel induction-page-form"><div className="panel-header"><div><h3>Add induction</h3><p className="muted">Only guards with active portal access can be inducted. Their profile and document details appear below when selected.</p></div></div><form className="form-grid" onSubmit={save}><label>Site<select required value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })}><option value="">Select site</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name} · {site.site_id}</option>)}</select></label><label>Guard<select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}><option value="">Select guard</option>{portalReadyEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.employee_id}</option>)}</select></label><label>Induction date<input required type="date" value={form.induction_date} onChange={(e) => setForm({ ...form, induction_date: e.target.value })} /></label><label>Induction time<input type="time" value={form.induction_time} onChange={(e) => setForm({ ...form, induction_time: e.target.value })} /></label><label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="PLANNED">Planned</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option></select></label><label className="full-width">Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Induction notes" /></label>
      {needsCortexActivation && <p className="cortex-itime-warning full-width" role="status">{cortexActivationWarning(selectedGuard, selectedSite)}</p>}
      <div className="form-actions full-width"><button className="primary-button" disabled={saving || !portalReadyEmployees.length}>{saving ? "Saving..." : "Save induction"}</button></div></form>{selectedGuard && <div className="induction-guard-summary"><div className="panel-header"><div><h3>Guard induction information</h3><p className="muted">Review the information the guard entered in their profile and documents.</p></div><span className="status-pill active">Profile linked</span></div><div className="induction-detail-grid"><div><span>First name / surname</span><strong>{display(selectedGuard.name)}</strong></div><div><span>Date of birth</span><strong>{display(selectedGuard.date_of_birth)}</strong></div><div><span>Nationality</span><strong>{display(selectedGuard.nationality)}</strong></div><div><span>Contact number</span><strong>{display(selectedGuard.phone)}</strong></div><div><span>Email</span><strong>{display(selectedGuard.email)}</strong></div><div><span>Emergency contact</span><strong>{display([emergencyName, selectedGuard.emergency_contact_phone, selectedGuard.emergency_contact_relationship].filter(Boolean).join(" · "))}</strong></div><div className="full-width"><span>Address</span><strong>{display(selectedGuard.address)}</strong></div><div><span>SIA card number / expiry</span><strong>{display([sia?.document_number, sia?.expiry_date].filter(Boolean).join(" · "))}</strong></div><div><span>CSCS card number / expiry</span><strong>{display([cscs?.document_number, cscs?.expiry_date].filter(Boolean).join(" · "))}</strong></div><div><span>Compliant / PPAC code</span><strong>{display(ppac?.notes || ppac?.document_number)}</strong></div></div><p className="form-help">Missing information? Ask the guard to update My profile or Documents, then refresh this page before completing the induction.</p></div>}{!portalReadyEmployees.length && <p className="muted form-help">No guards with completed portal access are available yet. Create the employee first, then send the portal invite and finish activation.</p>}</section><section className="panel"><div className="panel-header"><div><h3>Induction records</h3><p className="muted">These records control which guards appear for each site in Weekly Rota.</p></div><div className="document-toolbar"><select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}><option value="">All sites</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select><span className="muted">{inductions.length} records</span></div></div>{loading ? <div className="empty-state compact-empty">Loading induction records...</div> : inductions.length ? <div className="table-wrap"><table><thead><tr><th>Site</th><th>Guard</th><th>Induction date/time</th><th>Status</th><th>Notes</th><th>Download</th></tr></thead><tbody>{inductions.map((induction) => <tr key={induction.id}><td><strong>{induction.site_name}</strong></td><td>{induction.employee_name}<small className="table-subtext">{induction.employee_code}</small></td><td>{induction.induction_date}{induction.induction_time ? ` · ${induction.induction_time.slice(0, 5)}` : ""}</td><td><span className={`status-pill ${induction.status === "COMPLETED" ? "active" : induction.status === "CANCELLED" ? "inactive" : "pending"}`}>{induction.status.toLowerCase()}</span>{induction.cortex_activation_required && <small className="table-subtext">Cortex iTime PIN activation required</small>}</td><td>{induction.notes || "—"}</td><td><button type="button" className="mini-button" onClick={() => downloadInduction(induction)}><Download size={13} /> CSV</button></td></tr>)}</tbody></table></div> : <div className="empty-state compact-empty">No induction records found.</div>}</section></>;
}

function LegacyGuardProfileContent() {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ name: "", date_of_birth: "", nationality: "", phone: "", email: "", address: "", emergency_contact_name: "", emergency_contact_phone: "", emergency_contact_relationship: "", joining_date: "" });
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  useEffect(() => { api("/employees/me/").then((data) => { setProfile(data); setForm({ name: data.name || "", date_of_birth: data.date_of_birth || "", nationality: data.nationality || "", phone: data.phone || "", email: data.email || "", address: data.address || "", emergency_contact_name: data.emergency_contact_name || "", emergency_contact_phone: data.emergency_contact_phone || "", emergency_contact_relationship: data.emergency_contact_relationship || "", joining_date: data.joining_date || "" }); }).catch((err) => setError(err.message)).finally(() => setLoading(false)); }, []);
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); setNotice(""); try { const data = await api("/employees/me/", { method: "PATCH", body: JSON.stringify(form) }); setProfile(data); setNotice("Profile updated successfully."); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  if (loading) return <div className="empty-view"><RotaLoader label="Loading your profile…" /></div>;
  return <><div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>My profile</h2><p className="muted">Update your personal and emergency details. Position is managed by the office.</p></div><span className="profile-progress-badge">{profile?.profile_completion || 0}% details</span></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}<section className="profile-layout"><article className="panel profile-card"><div className="profile-card-header"><div className="profile-avatar">{profile?.profile_photo_url ? <ProtectedImage src={profile.profile_photo_url} alt={`${profile?.name || "Guard"} profile`} /> : (profile?.name || "?").slice(0, 1).toUpperCase()}</div><div><h3>{profile?.name}</h3><p className="muted">{profile?.employee_id} · {profile?.position || "Guard"}</p></div></div><div className="profile-progress"><div><strong>Personal details</strong><span>{profile?.profile_completion || 0}%</span></div><div className="progress-track"><span style={{ width: `${profile?.profile_completion || 0}%` }} /></div><small>Keep your contact and emergency details current.</small></div></article><form className="panel profile-form" onSubmit={save}><div className="panel-header"><div><h3>Personal details</h3><p className="muted">Position can only be changed by an authorised office user.</p></div></div><div className="form-grid"><label>Employee ID<input value={profile?.employee_id || ""} disabled /></label><label>Full name (first name + surname)<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Position<input value={profile?.position || "Guard"} disabled /></label><label>Date of birth<input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></label><label>Nationality<input value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} placeholder="Select nationality" /></label><label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+92..." /></label><label>Email address<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Joining date<input type="date" value={form.joining_date} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} /></label><label className="full-width">Address<textarea rows="3" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Emergency contact name<input value={form.emergency_contact_name} onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })} /></label><label>Emergency contact phone<input value={form.emergency_contact_phone} onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })} /></label><label>Relationship<input value={form.emergency_contact_relationship} onChange={(e) => setForm({ ...form, emergency_contact_relationship: e.target.value })} placeholder="Parent, spouse, sibling..." /></label></div><div className="modal-actions"><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save profile"}</button></div></form></section></>;
}

function GuardProfileContent() {
  const [profile, setProfile] = useState(null); const [form, setForm] = useState({ name: "", date_of_birth: "", nationality: "", phone: "", email: "", address: "", emergency_contact_name: "", emergency_contact_phone: "", emergency_contact_relationship: "" }); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  useEffect(() => { api("/employees/me/").then((data) => { setProfile(data); setForm({ name: data.name || "", date_of_birth: data.date_of_birth || "", nationality: data.nationality || "", phone: data.phone || "", email: data.email || "", address: data.address || "", emergency_contact_name: data.emergency_contact_name || "", emergency_contact_phone: data.emergency_contact_phone || "", emergency_contact_relationship: data.emergency_contact_relationship || "" }); }).catch((err) => setError(err.message)).finally(() => setLoading(false)); }, []);
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); setNotice(""); try { const data = await api("/employees/me/", { method: "PATCH", body: JSON.stringify(form) }); setProfile(data); setNotice("Profile updated successfully."); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  if (loading) return <div className="empty-view"><RotaLoader label="Loading your profile…" /></div>;
  return <><div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>My profile</h2><p className="muted">Update your personal and emergency details. Position and joining date are managed by the office.</p></div><span className="profile-progress-badge">{profile?.profile_completion || 0}% details</span></div>{error && <p className="error page-error">{error}</p>}{notice && <p className="success page-success">{notice}</p>}<section className="profile-layout"><article className="panel profile-card"><div className="profile-card-header"><div className="profile-avatar">{profile?.profile_photo_url ? <ProtectedImage src={profile.profile_photo_url} alt={`${profile?.name || "Guard"} profile`} /> : (profile?.name || "?").slice(0, 1).toUpperCase()}</div><div><h3>{profile?.name}</h3><p className="muted">{profile?.employee_id} · {profile?.position || "Guard"}</p></div></div><div className="profile-progress"><div><strong>Personal details</strong><span>{profile?.profile_completion || 0}%</span></div><div className="progress-track"><span style={{ width: `${profile?.profile_completion || 0}%` }} /></div><small>Keep your contact and emergency details current.</small></div></article><form className="panel profile-form" onSubmit={save}><div className="panel-header"><div><h3>Personal details</h3><p className="muted">Position and joining date can only be changed by an authorised office user.</p></div></div><div className="form-grid"><label>Employee ID<input value={profile?.employee_id || ""} disabled /></label><label>Full name (first name + surname)<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Position<input value={profile?.position || "Guard"} disabled /></label><label>Date of birth<input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></label><label>Nationality<input value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} placeholder="Select nationality" /></label><label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+92..." /></label><label>Email address<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Joining date<input type="date" value={profile?.joining_date || ""} disabled /></label><label className="full-width">Address<textarea rows="3" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Emergency contact name<input value={form.emergency_contact_name} onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })} /></label><label>Emergency contact phone<input value={form.emergency_contact_phone} onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })} /></label><label>Relationship<input value={form.emergency_contact_relationship} onChange={(e) => setForm({ ...form, emergency_contact_relationship: e.target.value })} placeholder="Parent, spouse, sibling..." /></label></div><div className="modal-actions"><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save profile"}</button></div></form></section></>;
}

function LegacyEmployeeRecords() {
  const empty = { name: "", email: "", position: "Security Guard", status: "ACTIVE", compliance_registration_enabled: false };
  const [items, setItems] = useState([]); const [search, setSearch] = useState(""); const [open, setOpen] = useState(false); const [editingId, setEditingId] = useState(null); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [invite, setInvite] = useState(null); const [copied, setCopied] = useState(false);
  const employeeQuery = useQuery({ queryKey: ["rota", "employees", search], queryFn: () => api(`/employees/?search=${encodeURIComponent(search)}`) });
  const load = () => employeeQuery.refetch().then((result) => setItems(result.data || [])).catch((err) => setError(err.message));
  useEffect(() => { if (employeeQuery.data) setItems(employeeQuery.data); if (employeeQuery.error) setError(employeeQuery.error.message); }, [employeeQuery.data, employeeQuery.error]);
  const editForm = (item) => ({ employee_id: item.employee_id || "", name: item.name || "", date_of_birth: item.date_of_birth || "", nationality: item.nationality || "", position: item.position || "", phone: item.phone || "", email: item.email || "", address: item.address || "", emergency_contact: item.emergency_contact || "", emergency_contact_name: item.emergency_contact_name || "", emergency_contact_phone: item.emergency_contact_phone || "", emergency_contact_relationship: item.emergency_contact_relationship || "", joining_date: item.joining_date || "", status: item.status || "ACTIVE", compliance_registration_enabled: Boolean(item.compliance_registration_enabled) });
  const save = async (event) => { event.preventDefault(); setSaving(true); setError(""); try { await api(`/employees/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(form) }); setOpen(false); setEditingId(null); setForm(empty); await load(); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  const createPortalAccount = async (employee) => { if (!confirm(`${employee.portal_status === "INVITE_PENDING" ? "Resend" : "Create"} secure portal invite for ${employee.name}?`)) return; setError(""); try { const result = await api(`/employees/${employee.id}/create_portal_account/`, { method: "POST", body: JSON.stringify({ frontend_url: PORTAL_ORIGIN }) }); setInvite({ employee: employee.name, url: result.activation_url }); setCopied(false); try { await navigator.clipboard.writeText(result.activation_url); setCopied(true); } catch { /* The link remains available for manual copy. */ } await load(); } catch (err) { setError(err.message); } }; const employeeInviteUrl = (employee) => employee.portal_invite_token ? `${PORTAL_ORIGIN}/guard?activate=${employee.portal_invite_token}` : employee.portal_invite_url || ""; const copyEmployeeInvite = async (employee) => { const url = employeeInviteUrl(employee); if (!url) return; try { await navigator.clipboard.writeText(url); notifyToast(`${employee.name} invite link copied.`); } catch { setInvite({ employee: employee.name, url }); setCopied(false); } };
  const copyInvite = async () => { if (!invite?.url) return; try { await navigator.clipboard.writeText(invite.url); setCopied(true); } catch { setCopied(false); } };
  return <><div className="page-heading"><div><p className="eyebrow">PEOPLE MANAGEMENT</p><h2>Employees</h2><p className="muted">Create a guard record quickly, then let the guard complete the remaining profile details from the portal.</p></div><button className="primary-button" onClick={() => { setEditingId(null); setForm(empty); setError(""); setOpen(true); }}>Add employee</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div className="search-box"><Search size={17} /><input placeholder="Search employees..." value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} /></div><span className="muted">{items.length} records</span></div>{items.length === 0 ? <div className="empty-state"><Users size={30} /><strong>No employees found</strong><span>Use Add employee to create the first guard record.</span></div> : <div className="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Position</th><th>Profile</th><th>Portal access</th><th>Invite link</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.employee_id}</td><td><strong>{item.name}</strong><small className="table-subtext">{item.email || "Profile details pending"}</small></td><td>{item.position || "—"}</td><td><span className="profile-completion-inline">{item.profile_completion || 0}%</span></td><td>{item.portal_status === "ACTIVE" ? <span className="status-pill active">Active</span> : <button className="mini-button" onClick={() => createPortalAccount(item)}>{item.portal_status === "INVITE_PENDING" ? "Resend invite" : "Invite guard"}</button>}</td><td>{employeeInviteUrl(item) ? <div className="invite-link-cell"><input readOnly value={employeeInviteUrl(item)} aria-label={`${item.name} invite link`} /><button type="button" className="mini-button" onClick={() => copyEmployeeInvite(item)}>Copy</button></div> : <span className="muted">No active invite</span>}</td><td><span className={`status-pill ${item.status.toLowerCase()}`}>{item.status === "ON_HOLD" ? "On hold" : item.status.replace("_", " ")}</span></td><td><div className="row-actions"><button className="mini-button" onClick={() => { setEditingId(item.id); setForm(editForm(item)); setError(""); setOpen(true); }}><Pencil size={13} /> View / edit</button></div></td></tr>)}</tbody></table></div>}</section>{open && <div className="modal-backdrop"><form className="modal-card" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EMPLOYEE RECORD" : "NEW RECORD"}</p><h3>{editingId ? "View / edit employee" : "Add employee"}</h3><p className="muted">{editingId ? "Profile data entered by the guard is shown here." : "Only these fields are needed now. The guard will complete the rest after activation."}</p></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Employee ID<input value={form.employee_id || "System will generate"} disabled /></label><label>Full name (first name + surname)<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="First name Surname" /></label><label>Email (portal login)<input required={!editingId} type="email" value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="guard@example.com" /></label><label>Position<select required value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}><option value="">Select position</option>{positionOptions.map((position) => <option value={position} key={position}>{position}</option>)}</select></label><label>Status<select required value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="ON_HOLD">On hold</option></select></label>{editingId && <><label>Date of birth<input type="date" value={form.date_of_birth || ""} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></label><label>Nationality<input value={form.nationality || ""} onChange={(e) => setForm({ ...form, nationality: e.target.value })} /></label><label>Phone<input value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label><label>Joining date<input type="date" value={form.joining_date || ""} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} /></label><label className="full-width">Address<textarea rows="2" value={form.address || ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Emergency contact name<input value={form.emergency_contact_name || ""} onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })} /></label><label>Emergency contact phone<input value={form.emergency_contact_phone || ""} onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })} /></label><label>Relationship<input value={form.emergency_contact_relationship || ""} onChange={(e) => setForm({ ...form, emergency_contact_relationship: e.target.value })} /></label></>}</div>{!editingId && <p className="form-help">Employee ID will be generated automatically after saving.</p>}{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save employee"}</button></div></form></div>}{invite && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setInvite(null)}><section className="modal-card invite-modal"><div className="modal-header"><div><p className="eyebrow">GUARD PORTAL INVITE</p><h3>Invite link ready</h3><p className="muted">Send this one-time link to {invite.employee}. It expires in 48 hours.</p></div><button type="button" className="icon-button" onClick={() => setInvite(null)}><X size={19} /></button></div><div className="invite-link-box"><input readOnly value={invite.url} onFocus={(event) => event.target.select()} /><button className="primary-button" onClick={copyInvite}>{copied ? "Copied" : "Copy link"}</button></div>{copied ? <p className="success invite-success">Invite link copied to clipboard successfully.</p> : <p className="muted invite-help">Select the link above and copy it manually if needed.</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setInvite(null)}>Done</button></div></section></div>}</>;
}

function EmployeeRecords({ canManagePins = false }) {
  const empty = { name: "", email: "", position: "Security Guard", roles: ["Security Guard"], status: "ACTIVE", compliance_registration_enabled: false, cortex_itime_enabled: false, cortex_itime_site: "", cortex_itime_pin: "", timegate_pin: "", whatsapp_number: "" };
  const [items, setItems] = useState([]); const [search, setSearch] = useState(""); const [open, setOpen] = useState(false); const [editingId, setEditingId] = useState(null); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [invite, setInvite] = useState(null); const [copied, setCopied] = useState(false); const [customRoles, setCustomRoles] = useState(() => readCustomEmployeeRoles());
  const load = async () => { try { setItems(await api(`/employees/?search=${encodeURIComponent(search)}`)); } catch (err) { setError(err.message); } };
  useEffect(() => { load(); }, []);
  const editForm = (item) => { const roles = employeeRoles(item); return { ...empty, timegate_pin_saved: Boolean(item.timegate_pin_saved), cortex_itime_enabled: Boolean(item.cortex_itime_enabled), cortex_itime_sites: item.cortex_itime_sites || [], cortex_itime_pin_saved: Boolean(item.cortex_itime_pin_saved), employee_id: item.employee_id || "", name: item.name || "", email: item.email || "", whatsapp_number: item.whatsapp_number || "", position: roles[0] || item.position || "", roles, status: item.status || "ACTIVE", compliance_registration_enabled: Boolean(item.compliance_registration_enabled), date_of_birth: item.date_of_birth || "", nationality: item.nationality || "", phone: item.phone || "", joining_date: item.joining_date || "", address: item.address || "", emergency_contact_name: item.emergency_contact_name || "", emergency_contact_phone: item.emergency_contact_phone || "", emergency_contact_relationship: item.emergency_contact_relationship || "" }; };
  const addCustomRole = (role) => { const value = role.trim().replace(/\s+/g, " "); if (!value || positionOptions.includes(value) || customRoles.includes(value)) return; const next = [...customRoles, value]; setCustomRoles(next); try { localStorage.setItem(CUSTOM_ROLE_STORAGE_KEY, JSON.stringify(next)); } catch { /* Custom roles still work for this session if storage is unavailable. */ } };
  const editCustomRole = (oldRole, nextRole) => { const value = nextRole.trim().replace(/\s+/g, " "); if (!value || positionOptions.includes(value) || (customRoles.includes(value) && value !== oldRole)) return; const next = customRoles.map((role) => role === oldRole ? value : role); setCustomRoles(next); try { localStorage.setItem(CUSTOM_ROLE_STORAGE_KEY, JSON.stringify(next)); } catch { /* Custom roles still work for this session if storage is unavailable. */ } };
  const deleteCustomRole = (role) => { const next = customRoles.filter((item) => item !== role); setCustomRoles(next); try { localStorage.setItem(CUSTOM_ROLE_STORAGE_KEY, JSON.stringify(next)); } catch { /* Custom roles still work for this session if storage is unavailable. */ } };
  const save = async (event) => {
    event.preventDefault(); setSaving(true); setError("");
    const { cortex_itime_enabled, cortex_itime_site, cortex_itime_pin, cortex_itime_sites, cortex_itime_pin_saved, timegate_pin, timegate_pin_saved, whatsapp_number, ...payload } = form;
    if (canManagePins) {
      payload.whatsapp_number = whatsapp_number;
      payload.cortex_itime_enabled = cortex_itime_enabled;
      if (timegate_pin) payload.timegate_pin = timegate_pin;
      if (cortex_itime_enabled) {
        if (cortex_itime_site) payload.cortex_itime_site = Number(cortex_itime_site);
        if (cortex_itime_pin) payload.cortex_itime_pin = cortex_itime_pin;
      }
    }
    try { await api(`/employees/${editingId ? `${editingId}/` : ""}`, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) }); setOpen(false); setEditingId(null); setForm(empty); await load(); notifyToast("Employee saved successfully."); } catch (err) { setError(err.message); } finally { setSaving(false); } };
  const createPortalAccount = async (employee) => { if (!confirm(`${employee.portal_status === "INVITE_PENDING" ? "Resend" : "Create"} secure portal invite for ${employee.name}?`)) return; try { const result = await api(`/employees/${employee.id}/create_portal_account/`, { method: "POST", body: JSON.stringify({ frontend_url: PORTAL_ORIGIN }) }); setInvite({ employee: employee.name, url: result.activation_url }); setCopied(false); await load(); } catch (err) { setError(err.message); } };
  const employeeInviteUrl = (employee) => employee.portal_invite_token ? `${PORTAL_ORIGIN}/guard?activate=${employee.portal_invite_token}` : employee.portal_invite_url || "";
  const copyEmployeeInvite = async (employee) => { const url = employeeInviteUrl(employee); if (!url) return; try { await navigator.clipboard.writeText(url); notifyToast(`${employee.name} invite link copied.`); } catch { setInvite({ employee: employee.name, url }); setCopied(false); } };
  const copyInvite = async () => { if (!invite?.url) return; try { await navigator.clipboard.writeText(invite.url); setCopied(true); } catch { setCopied(false); } };
  return <><div className="page-heading"><div><p className="eyebrow">PEOPLE MANAGEMENT</p><h2>Employees</h2><p className="muted">Create a guard record, then control portal access. The Diligent form appears automatically after activation.</p></div><button className="primary-button" onClick={() => { setEditingId(null); setForm(empty); setError(""); setOpen(true); }}>Add employee</button></div>{error && <p className="error page-error">{error}</p>}<section className="panel"><div className="toolbar"><div className="search-box"><Search size={17} /><input placeholder="Search employees..." value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === "Enter" && load()} /></div><span className="muted">{items.length} records</span></div>{items.length ? <div className="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Position</th><th>Portal access</th><th>Compliance form</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.employee_id}</td><td><strong>{item.name}</strong><small className="table-subtext">{item.email || "Profile details pending"}</small></td><td>{formatEmployeeRoles(item)}</td><td>{item.portal_status === "ACTIVE" ? <span className="status-pill active">Active</span> : <button className="mini-button" onClick={() => createPortalAccount(item)}>{item.portal_status === "INVITE_PENDING" ? "Resend invite" : "Invite guard"}</button>}</td><td><span className="status-pill active">Available after login</span></td><td><span className={`status-pill ${String(item.status || "").toLowerCase()}`}>{item.status === "ON_HOLD" ? "On hold" : String(item.status || "").replace("_", " ")}</span></td><td><div className="row-actions"><button className="mini-button" onClick={() => { setEditingId(item.id); setForm(editForm(item)); setError(""); setOpen(true); }}><Pencil size={13} /> View / edit</button>{employeeInviteUrl(item) && <button className="mini-button" onClick={() => copyEmployeeInvite(item)}>Copy invite</button>}</div></td></tr>)}</tbody></table></div> : <div className="empty-state"><Users size={30} /><strong>No employees found</strong><span>Use Add employee to create a guard record.</span></div>}</section>{open && <div className="modal-backdrop"><form className={canManagePins ? "modal-card employee-access-modal" : "modal-card"} onSubmit={save}><div className="modal-header"><div><p className="eyebrow">{editingId ? "EMPLOYEE RECORD" : "NEW RECORD"}</p><h3>{editingId ? "View / edit employee" : "Add employee"}</h3><p className="muted">{editingId ? "Update office-controlled access and guard details." : "Only the basic record is needed now."}</p></div><button type="button" className="icon-button" onClick={() => setOpen(false)}><X size={19} /></button></div><div className="form-grid"><label>Employee ID<input value={form.employee_id || "System will generate"} disabled /></label><label>Full name (first name + surname)<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="First name Surname" /></label><label>Email (portal login)<input required={!editingId} type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="guard@example.com" /></label><RoleMultiSelect value={form.roles || employeeRoles(form)} customRoles={customRoles} onAddCustomRole={addCustomRole} onEditCustomRole={editCustomRole} onDeleteCustomRole={deleteCustomRole} onChange={(roles) => setForm({ ...form, roles, position: roles[0] || "" })} /><label>Status<select required value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="ON_HOLD">On hold</option></select></label><label className="full-width checkbox-field"><span className="checkbox-control"><input type="checkbox" checked={Boolean(form.compliance_registration_enabled)} onChange={(event) => setForm({ ...form, compliance_registration_enabled: event.target.checked })} /><span><strong>Enable compliance registration</strong><small>Show the external Compliance registration link in this guard's portal sidebar.</small></span></span></label>
      {canManagePins && <label>WhatsApp number<input type="tel" value={form.whatsapp_number} maxLength={40} onChange={(event) => setForm({ ...form, whatsapp_number: event.target.value })} placeholder="+44 7700 900123" /><small className="form-help">Include the country code.</small></label>}
      {canManagePins && <>
        <EmployeeCortexITimeFields form={form} setForm={setForm} api={api} />
        <EmployeeTimeGateFields form={form} setForm={setForm} />
      </>}
      {editingId && <><label>Date of birth<input type="date" value={form.date_of_birth} onChange={(event) => setForm({ ...form, date_of_birth: event.target.value })} /></label><label>Nationality<input value={form.nationality} onChange={(event) => setForm({ ...form, nationality: event.target.value })} /></label><label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label><label>Joining date<input type="date" value={form.joining_date} onChange={(event) => setForm({ ...form, joining_date: event.target.value })} /></label><label className="full-width">Address<textarea rows="2" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label><label>Emergency contact name<input value={form.emergency_contact_name} onChange={(event) => setForm({ ...form, emergency_contact_name: event.target.value })} /></label><label>Emergency contact phone<input value={form.emergency_contact_phone} onChange={(event) => setForm({ ...form, emergency_contact_phone: event.target.value })} /></label><label>Relationship<input value={form.emergency_contact_relationship} onChange={(event) => setForm({ ...form, emergency_contact_relationship: event.target.value })} /></label></>}</div>{!editingId && <p className="form-help">Employee ID will be generated automatically after saving.</p>}{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save employee"}</button></div></form></div>}{invite && <div className="modal-backdrop"><section className="modal-card invite-modal"><div className="modal-header"><div><p className="eyebrow">GUARD PORTAL INVITE</p><h3>Invite link ready</h3><p className="muted">Send this one-time link to {invite.employee}.</p></div><button type="button" className="icon-button" onClick={() => setInvite(null)}><X size={19} /></button></div><div className="invite-link-box"><input readOnly value={invite.url} /><button className="primary-button" onClick={copyInvite}>{copied ? "Copied" : "Copy link"}</button></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setInvite(null)}>Done</button></div></section></div>}</>;
}

function App() {
  const [notificationTarget, setNotificationTarget] = useState({});
  const [user, setUser] = useState(null);
  const [guardInitialPage, setGuardInitialPage] = useState("home");
  const [authLoading, setAuthLoading] = useState(() => Boolean(getToken()));
  const [page, setPage] = useState("dashboard");
  const dataVersion = 0;
  const [mobileNav, setMobileNav] = useState(false);
  const [stats, setStats] = useState({ active_employees: 0, active_sites: 0, employees_on_leave: 0, unfilled_shifts: 0, documents_expiring_soon: 0 });
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [controlUnread, setControlUnread] = useState(0);
  const guardPath = window.location.pathname === "/guard" || window.location.pathname.startsWith("/guard/");
  const attendanceOnlyPath = window.location.pathname === "/guard-attendance" || window.location.pathname.startsWith("/guard-attendance/");
  const clientPath = window.location.pathname === "/client" || window.location.pathname.startsWith("/client/");
  const controlPath = isControlPortal();
  const resetPath = window.location.pathname === "/reset-password";
  useEffect(() => {
    const token = getToken();
    if (!token) { setAuthLoading(false); return undefined; }
    api(controlPath ? "/control/profile/" : clientPath ? "/auth/client-me/" : guardPath || attendanceOnlyPath ? "/auth/guard-me/" : "/auth/me/").then((data) => { syncAdminSession(data.admin_session); setUser(controlPath ? { role: "CONTROL_TEAM" } : data); }).catch(() => clearAuth()).finally(() => setAuthLoading(false));
    return undefined;
  }, []);
  useEffect(() => {
    if (!user || clientPath || controlPath || user.role === "EMPLOYEE" || user.role_display === "EMPLOYEE") return undefined;
    const loadDashboard = () => api("/dashboard/").then(setStats).catch(() => {});
    loadDashboard();
    window.addEventListener("rota:live-refresh", loadDashboard);
    return () => window.removeEventListener("rota:live-refresh", loadDashboard);
  }, [user, clientPath, controlPath]);
  useEffect(() => {
    if (!user) return;
    const role = user.role || user.role_display;
    const driveResult = new URLSearchParams(window.location.search).get("google_drive");
    if ((role === "ADMIN" || role === "SUPER_ADMIN" || user.is_superuser) && (driveResult === "authorize" || driveResult === "cancelled")) {
      setPage("documents");
    } else {
      setPage(role === "EMPLOYEE" ? "profile" : "dashboard");
    }
  }, [user]);
  useEffect(() => {
    setUnreadNotifications(0);
    setControlUnread(0);
    if (!user || clientPath) return undefined;
    let active = true;
    let seen = null;
    let loading = false;
    let queued = false;
    const loadNotifications = async () => {
      if (loading) { queued = true; return; }
      loading = true;
      try {
        const items = await api(controlPath ? "/control/notifications/" : "/notifications/", { silentLoading: true, silentError: true });
        if (!active) return;
        const unread = items.filter((item) => !item.is_read);
        if (seen) {
          unread.filter((item) => !seen.has(item.id)).reverse().forEach((item) => notifyToast(`${item.title}: ${item.message}`, item.notification_type?.toLowerCase() || "info"));
        }
        seen = new Set(items.map((item) => item.id));
        setUnreadNotifications(unread.length);
        setControlUnread(unread.filter((item) => item.link === "control-team").length);
      } catch { /* Retry on the next background check. */ }
      finally {
        loading = false;
        if (active && queued) { queued = false; void loadNotifications(); }
      }
    };
    loadNotifications();
    const timer = window.setInterval(loadNotifications, 30000);
    window.addEventListener("rota:notifications-changed", loadNotifications);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("rota:notifications-changed", loadNotifications); };
  }, [user, clientPath, controlPath]);
  useEffect(() => {
    const ended = (event) => { queryClient.clear(); setUser(null); setGuardInitialPage("home"); setUnreadNotifications(0); if (event.detail?.message) notifyToast(event.detail.message, "info"); };
    window.addEventListener("rota:session-ended", ended);
    return () => window.removeEventListener("rota:session-ended", ended);
  }, []);
  const activationToken = new URLSearchParams(window.location.search).get("activate");
  const resetParams = new URLSearchParams(window.location.search);
  const resetPortal = resetParams.get("portal") || "admin";
  if (resetPath) return <><ToastHost /><ForgotPasswordPage guardMode={resetPortal === "guard"} clientMode={resetPortal === "client"} onBack={() => { window.location.href = resetPortal === "guard" ? "/guard" : resetPortal === "client" ? "/client" : "/"; }} /></>;
  if (authLoading) return <><ToastHost /><RotaLoader overlay label="Securing your portal…" /></>;
  if (!user) return <><ToastHost />{activationToken && !controlPath ? <ActivationPage token={activationToken} onActivated={(activatedUser) => { setGuardInitialPage("profile"); setUser(activatedUser); }} /> : <Login onLogin={setUser} guardMode={guardPath || attendanceOnlyPath} clientMode={clientPath} controlMode={controlPath} />}</>;
  const signOut = async () => {
    try { await api(controlPath ? "/control/logout/" : "/auth/logout/", { method: "POST", silentLoading: true, silentError: true }); }
    catch (error) { if (getToken()) { notifyToast("Could not sign out on the server. Check your connection and try again.", "error"); return; } }
    clearAuth(); queryClient.clear(); setGuardInitialPage("home"); setUser(null); setUnreadNotifications(0);
  };
  const role = user.role || user.role_display;
  const isEmployee = role === "EMPLOYEE";
  const isSuperAdmin = role === "SUPER_ADMIN" || Boolean(user.is_superuser);
  const isOperator = role === "OPERATOR" || role === "RECEPTIONIST";
  const canShareWhatsApp = isSuperAdmin || role === "ADMIN";
  const isClientAdmin = role === "CLIENT_ADMIN";
  if (controlPath) return <><ToastHost /><ControlPortal api={api} Photo={ProtectedImage} FilePreview={ProtectedFilePreview} onSignOut={signOut} unread={controlUnread} /></>;
  if (clientPath && !isClientAdmin) return <><ToastHost /><main className="login-shell"><section className="login-card"><div className="brand-mark"><ShieldCheck size={22} /></div><p className="eyebrow">ROTA CLIENT PORTAL</p><h1>Client access only</h1><p className="muted">This portal is reserved for linked Client Admin accounts.</p><button className="primary-button" onClick={signOut}>Sign out</button></section></main></>;
  if (isClientAdmin) return <><ToastHost /><ClientPortal user={user} onSignOut={signOut} /></>;
  if ((guardPath || attendanceOnlyPath) && !isEmployee) return <><ToastHost /><main className="login-shell"><section className="login-card"><div className="brand-mark"><ShieldCheck size={22} /></div><p className="eyebrow">ROTA GUARD PORTAL</p><h1>Guard access only</h1><p className="muted">This link is reserved for guard accounts. Admin users should use the main operations portal.</p><button className="primary-button" onClick={signOut}>Sign out</button></section></main></>;
  if (attendanceOnlyPath) return <GuardAttendanceOnly user={user} onSignOut={signOut} />;
  if (isEmployee) return <GuardPortal user={user} onSignOut={signOut} unreadNotifications={unreadNotifications} initialPage={guardInitialPage} />;
  const content = page === "control-team" ? <ControlTeamAdmin api={api} Photo={ProtectedImage} FilePreview={ProtectedFilePreview}
    unread={controlUnread} initialTarget={notificationTarget.page === "control-team" ? notificationTarget : undefined} /> : page === "security" ? <AdminSecurity api={api} user={user} /> : page === "security-screening" ? <AdminScreening api={api} downloadFile={downloadFile} FilePreview={ProtectedFilePreview} initialCaseId={notificationTarget.screening_id} /> : page === "profile" ? <EmployeeProfilePage /> : page === "attendance" ? <EmployeeAttendancePage /> : page === "attendance-review" ? <AttendanceReviewPage canTrack={!isOperator} target={notificationTarget.page === "attendance-review" ? notificationTarget : {}} /> : page === "dashboard" ? <Dashboard stats={stats} onCreateRota={() => setPage("rota")} /> : page === "employees" ? <EmployeeRecords canManagePins={isSuperAdmin || role === "ADMIN"} /> : page === "clients" ? <ClientsPage /> : page === "sites" ? <SiteRecords /> : page === "whatsapp-announcements" && canShareWhatsApp ? <StaffAnnouncements api={api} /> : (page === "rota" || (page === "whatsapp-rota" && canShareWhatsApp)) ? <Rota canShareWhatsApp={canShareWhatsApp} target={notificationTarget.page === "rota" ? notificationTarget : {}} /> : page === "guard-availability" ? <GuardAvailability api={api} /> : page === "guard-induction" ? <GuardInductionPageV2 canManageCortex={isSuperAdmin || role === "ADMIN"} /> : page === "coverage-staffing" ? <CoverageStaffingPage /> : page === "rota-confirmation" ? <RotaConfirmationPage /> : page === "leave" ? <LeavePage initialLeaveId={notificationTarget.leave_id} /> : page === "documents" ? <DocumentsPage onNavigate={setPage} isOfficeAdmin={isSuperAdmin || role === "ADMIN"} target={notificationTarget.page === "documents" ? notificationTarget : {}} /> : page === "compliance-approvals" ? <ComplianceApprovalsPage initialRegistrationId={notificationTarget.registration_id} /> : page === "timesheets" ? <TimesheetsPage canApprove={!isOperator} initialTimesheetId={notificationTarget.timesheet_id} /> : page === "reports" ? <ReportsPage /> : page === "arrival-report" ? <ArrivalReportPage canRegenerate={isSuperAdmin || role === "ADMIN"} /> : page === "operations" ? <OperationsPage canEdit={!isOperator} canTrack={!isOperator} /> : page === "notifications" ? ((isSuperAdmin || role === "ADMIN") ? <AdminNotifications api={api} onNavigate={(target, context) => { setNotificationTarget({ ...context, page: target }); setPage(target); }} /> : <NotificationsPage />) : page === "audit" ? <AuditPage /> : <UsersPage />;
  return <><ToastHost />{(isSuperAdmin || role === "ADMIN") && <AdminSessionMonitor api={api} />}<div className="app-shell"><aside className={mobileNav ? "sidebar open" : "sidebar"}><div className="sidebar-brand"><div className="brand-lockup"><img className="brand-logo" src="/branding/rotaops-logo.jpg" alt="RotaOps" /></div><button className="icon-button close-nav" onClick={() => setMobileNav(false)}><X size={20} /></button></div><nav>{navItems.filter((item) => isEmployee ? item.employeeOnly : !item.employeeOnly && (!item.superAdminOnly || isSuperAdmin) && (!item.adminOnly || isSuperAdmin || role === "ADMIN") && (!item.operatorHidden || !isOperator)).map(({ id, label, icon: Icon, disabled, groupHeading, whatsapp }) => <Fragment key={id}>{groupHeading && <div className="whatsapp-nav-heading">{groupHeading}</div>}<button className={["nav-item", page === id ? "active" : "", whatsapp ? "whatsapp-nav-item" : ""].filter(Boolean).join(" ")} disabled={disabled} onClick={() => { setNotificationTarget({}); setPage(id); setMobileNav(false); }}><Icon size={18} /><span>{label}</span>{id === "notifications" && unreadNotifications > 0 && <b className="nav-notification-badge">{unreadNotifications > 99 ? "99+" : unreadNotifications}</b>}{disabled && <small>soon</small>}</button></Fragment>)}</nav><div className="sidebar-footer"><div className="user-badge"><div className="avatar">{isEmployee ? (user.first_name || "G").slice(0, 1).toUpperCase() : (user.first_name || "S").slice(0, 1).toUpperCase()}</div><div><strong>{isEmployee ? (user.first_name || "Guard") : (user.first_name || "System")}</strong><span>{user.role_label || user.role_display || role || "ADMIN"}</span></div></div><button className="logout-button" onClick={signOut}><LogOut size={17} /> Sign out</button></div></aside>{mobileNav && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}<main className="main-area"><header className="topbar"><button className="icon-button menu-button" onClick={() => setMobileNav(true)}><Menu size={21} /></button><div className="breadcrumb">Workspace <span>/</span> <strong>{navItems.find((item) => item.id === page)?.label || "Dashboard"}</strong></div><div className="topbar-right"><span className="online-dot" /> System online</div></header><div className="page-content" key={dataVersion}>{content}</div></main></div></>;
}

export default App;
