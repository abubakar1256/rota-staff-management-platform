export const notificationCategories = [
  { key: "DOCUMENT_EXPIRY", label: "Documents Expiry" }, { key: "DOCUMENT_REVIEW", label: "Documents Review" },
  { key: "REGISTRATION_SCREENING", label: "Registration & Screening" }, { key: "ATTENDANCE", label: "Attendance" },
  { key: "ROTA_STAFFING", label: "Rota & Staffing" }, { key: "LEAVE_REPLACEMENT", label: "Leave & Replacement" },
  { key: "TIMESHEETS", label: "Timesheets" }, { key: "SYSTEM", label: "System & Integrations" },
];
export function inboxPath({ category = "ALL", view = "ALL", search = "", page = 1 }) {
  return `/notifications/inbox/?${new URLSearchParams({ category, view, q: search, page: String(page) })}`;
}
export function notificationAction(item) {
  const allowed = new Set(["documents", "security-screening", "compliance-approvals", "attendance-review", "rota", "rota-confirmation", "coverage-staffing", "leave", "timesheets", "control-team"]);
  const link = String(item.link || "").split("?")[0];
  const page = link === "compliance" || link === "diligent-registration" ? "compliance-approvals" : link === "attendance" || link === "operations" ? "attendance-review" : link;
  if (!allowed.has(page)) return null;
  return { page, context: item.context || {}, label: ["documents", "security-screening", "compliance-approvals", "attendance-review", "timesheets"].includes(page) ? "View / Review" : "View details" };
}

export const guardNotificationCategories = [
  { key: "ROTA_STAFFING", label: "My Rota" }, { key: "ATTENDANCE", label: "Attendance" },
  { key: "DOCUMENT_EXPIRY", label: "Documents Expiry" }, { key: "DOCUMENT_REVIEW", label: "Documents Updates" },
  { key: "REGISTRATION_SCREENING", label: "Registration & Screening" },
  { key: "LEAVE_REPLACEMENT", label: "Leave & Replacement" }, { key: "TIMESHEETS", label: "Timesheets" },
];
export function guardInboxPath(filters) {
  return inboxPath(filters).replace("/notifications/inbox/", "/notifications/guard-inbox/");
}

export const controlNotificationCategories = [
  { key: "ATTENDANCE", label: "Attendance" }, { key: "ROTA_STAFFING", label: "Shifts" },
  { key: "LEAVE_REPLACEMENT", label: "Leave & Replacement" }, { key: "SYSTEM", label: "Team & Profile" },
];
export function guardNotificationAction(item) {
  if (item.category === "SYSTEM") return null;
  const original = String(item.link || "").split("?")[0];
  const page = ["compliance", "compliance-approvals", "diligent-registration"].includes(original) ? "diligent-registration" : ["timesheets", "attendance-review", "attendance"].includes(original) ? "attendance" : original;
  if (!["rota", "attendance", "documents", "security-screening", "diligent-registration", "leave"].includes(page)) return null;
  return { page, context: item.context || {}, label: "View / Complete" };
}
