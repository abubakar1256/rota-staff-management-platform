const tokenKey = "rota_token";
const sessionKey = "rota_admin_session";
const controlTokenKey = "rota_control_token";

export function isControlPortal() {
  return /^\/control(?:\/|$)/.test(globalThis.window?.location?.pathname || "");
}

export function getToken() {
  if (isControlPortal()) return sessionStorage.getItem(controlTokenKey);
  return sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey);
}

export function clearAuth() {
  if (isControlPortal()) {
    sessionStorage.removeItem(controlTokenKey);
    return;
  }
  localStorage.removeItem(tokenKey);
  sessionStorage.removeItem(tokenKey);
  sessionStorage.removeItem(sessionKey);
}

export function readAdminSession() {
  if (isControlPortal()) return null;
  try { return JSON.parse(sessionStorage.getItem(sessionKey) || "null"); } catch { return null; }
}

export function syncAdminSession(session) {
  if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
}

export function storeLogin(data) {
  clearAuth();
  if (isControlPortal()) {
    sessionStorage.setItem(controlTokenKey, data.token);
    return;
  }
  if (data.admin_session) {
    sessionStorage.setItem(tokenKey, data.token);
    syncAdminSession(data.admin_session);
  } else localStorage.setItem(tokenKey, data.token);
}

export function sessionRemaining(session, now = Date.now()) {
  if (!session) return 0;
  const deadline = Math.min(Date.parse(session.idle_expires_at), Date.parse(session.expires_at));
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

export function endAdminSession(message) {
  clearAuth();
  window.dispatchEvent(new CustomEvent("rota:session-ended", { detail: { message } }));
}
