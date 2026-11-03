import assert from "node:assert/strict";
import test from "node:test";
import { guardInboxPath, guardNotificationAction, guardNotificationCategories } from "../src/notificationInbox.js";

test("guard inbox exposes seven personal categories without office integrations", () => {
  assert.equal(guardNotificationCategories.length, 7);
  assert.ok(!guardNotificationCategories.some((item) => item.key === "SYSTEM"));
  assert.equal(guardNotificationCategories.find((item) => item.key === "ROTA_STAFFING").label, "My Rota");
  assert.equal(guardNotificationCategories.find((item) => item.key === "DOCUMENT_REVIEW").label, "Documents Updates");
  const url = new URL(guardInboxPath({ category: "ATTENDANCE", view: "URGENT", page: 2, search: "My site" }), "https://example.invalid");
  assert.equal(url.pathname, "/notifications/guard-inbox/");
  assert.equal(url.searchParams.get("q"), "My site");
  assert.equal(url.searchParams.get("view"), "URGENT");
});

test("guard actions open personal forms and shift dates instead of office review pages", () => {
  const context = { operation_id: 17, event_date: "2026-11-03" };
  assert.deepEqual(guardNotificationAction({ link: "attendance", context }), { page: "attendance", context, label: "View / Complete" });
  assert.equal(guardNotificationAction({ link: "timesheets" }).page, "attendance");
  assert.equal(guardNotificationAction({ link: "compliance-approvals" }).page, "diligent-registration");
  assert.equal(guardNotificationAction({ link: "security-screening" }).page, "security-screening");
  assert.equal(guardNotificationAction({ link: "documents", context: { document_id: 4 } }).context.document_id, 4);
});

test("office-only, privileged and external destinations never become guard actions", () => {
  for (const link of ["users", "audit", "coverage-staffing", "operations", "https://example.invalid", "javascript:alert(1)"]) assert.equal(guardNotificationAction({ link }), null);
  assert.equal(guardNotificationAction({ category: "SYSTEM", link: "documents" }), null);
});
