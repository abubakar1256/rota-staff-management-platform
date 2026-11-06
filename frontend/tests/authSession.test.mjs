import assert from "node:assert/strict";
import test from "node:test";
import { clearAuth, getToken, readAdminSession, sessionRemaining, storeLogin, syncAdminSession } from "../src/authSession.js";

function storage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key) };
}
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();

test("admin sessions stay in tab storage; switching accounts removes the old credential", () => {
  storeLogin({ token: "guard-token" });
  assert.equal(localStorage.getItem("rota_token"), "guard-token");
  const session = { id: "secure-admin", idle_expires_at: "2026-11-03T12:30:00Z", expires_at: "2026-11-03T20:00:00Z" };
  storeLogin({ token: "admin-token", admin_session: session });
  assert.equal(getToken(), "admin-token");
  assert.equal(localStorage.getItem("rota_token"), null);
  assert.deepEqual(readAdminSession(), session);
  storeLogin({ token: "second-guard" });
  assert.equal(sessionStorage.getItem("rota_token"), null);
  assert.equal(readAdminSession(), null);
  assert.equal(getToken(), "second-guard");
  clearAuth();
  assert.equal(getToken(), null);
});

test("idle expiry cannot exceed the maximum session deadline and invalid metadata expires", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(sessionRemaining({ idle_expires_at: "2026-11-03T12:01:00Z", expires_at: "2026-11-03T20:00:00Z" }, now), 60);
  assert.equal(sessionRemaining({ idle_expires_at: "2026-11-03T13:00:00Z", expires_at: "2026-11-03T12:00:10Z" }, now), 10);
  assert.equal(sessionRemaining({ idle_expires_at: "2026-11-03T11:59:59Z", expires_at: "2026-11-03T20:00:00Z" }, now), 0);
  assert.equal(sessionRemaining({ idle_expires_at: "invalid", expires_at: "invalid" }, now), 0);
  assert.equal(sessionRemaining(null, now), 0);
});

test("Control Team and office credentials stay separate", () => {
  const adminSession = { id: "admin" };
  storeLogin({ token: "office-token", admin_session: adminSession });
  globalThis.window = { location: { pathname: "/control" } };
  try {
    assert.equal(getToken(), null);
    assert.equal(readAdminSession(), null);
    storeLogin({ token: "control-token" });
    assert.equal(getToken(), "control-token");
    clearAuth();
    assert.equal(getToken(), null);
  } finally {
    delete globalThis.window;
  }
  assert.equal(getToken(), "office-token");
  assert.deepEqual(readAdminSession(), adminSession);
  clearAuth();
});

test("reloading restores server-provided session deadlines without extending them", () => {
  const session = { id: "example", idle_expires_at: "2026-11-03T12:30:00Z", expires_at: "2026-11-03T20:00:00Z" };
  syncAdminSession(session);
  assert.equal(sessionRemaining(readAdminSession(), Date.parse("2026-11-03T12:29:30Z")), 30);
  assert.equal(readAdminSession().idle_expires_at, session.idle_expires_at);
  sessionStorage.setItem("rota_admin_session", "{invalid");
  assert.equal(readAdminSession(), null);
  clearAuth();
});
