import assert from "node:assert/strict";
import test from "node:test";
import { inboxPath, notificationAction, notificationCategories } from "../src/notificationInbox.js";

test("all eight categories and filters produce a server-filtered inbox request", () => {
  assert.equal(notificationCategories.length, 8);
  assert.equal(new Set(notificationCategories.map((item) => item.key)).size, 8);
  const url = new URL(inboxPath({ category: "DOCUMENT_EXPIRY", view: "UNREAD", search: "Guard & site", page: 2 }), "https://example.invalid");
  assert.equal(url.searchParams.get("q"), "Guard & site");
  assert.equal(url.searchParams.get("category"), "DOCUMENT_EXPIRY");
  assert.equal(url.searchParams.get("view"), "UNREAD");
  assert.equal(url.searchParams.get("page"), "2");
});

test("review actions retain record context and resolve old links to the correct admin page", () => {
  const context = { registration_id: 7, employee_record_id: 12 };
  assert.deepEqual(notificationAction({ link: "compliance", context }), { page: "compliance-approvals", context, label: "View / Review" });
  assert.equal(notificationAction({ link: "attendance" }).page, "attendance-review");
  assert.equal(notificationAction({ link: "security-screening", context: { screening_id: 8 } }).context.screening_id, 8);
  assert.equal(notificationAction({ link: "documents" }).page, "documents");
});

test("notification links cannot open arbitrary URLs or privileged settings", () => {
  for (const link of ["https://example.invalid", "javascript:alert(1)", "users", "audit", "", "//example.invalid"]) assert.equal(notificationAction({ link }), null);
});
