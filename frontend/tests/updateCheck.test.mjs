import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdates } from "../src/updateCheck.js";

function setup({ data = [], paths = "/operations/?operation_date=2026-10-31", api = async () => data, select } = {}) {
  const applied = [], notifications = [], errors = [];
  const snapshot = { active: true, context: JSON.stringify(paths), data, apply: (value) => { applied.push(value); }, setError: (value) => errors.push(value) };
  return { snapshot, applied, notifications, errors, run: () => checkForUpdates({
    api, paths, select, getSnapshot: () => snapshot,
    notify: (message, type) => notifications.push({ message, type }),
  }) };
}

test("unchanged data keeps the mounted page untouched and reports up to date", async () => {
  const calls = [];
  const check = setup({ data: [{ id: 1, status: "ON_DUTY" }], api: async (...args) => {
    calls.push(args);
    return [{ status: "ON_DUTY", id: 1 }];
  } });
  assert.equal(await check.run(), "unchanged");
  assert.equal(check.applied.length, 0);
  assert.deepEqual(calls, [["/operations/?operation_date=2026-10-31", { silentLoading: true, silentError: true }]]);
  assert.deepEqual(check.notifications, [{ message: "You're up to date.", type: "info" }]);
});

test("changed data is applied and reports an update", async () => {
  const next = [{ id: 1, status: "BOOKED_OFF" }];
  const check = setup({ data: [{ id: 1, status: "ON_DUTY" }], api: async () => next });
  assert.equal(await check.run(), "updated");
  assert.deepEqual(check.applied, [next]);
  assert.deepEqual(check.notifications, [{ message: "Latest updates loaded.", type: "success" }]);
});

test("approval countdown ticking does not report a false record update", async () => {
  const check = setup({ data: [{ id: 1, status: "PENDING_APPROVAL", approval_remaining_seconds: 600 }],
    api: async () => [{ id: 1, status: "PENDING_APPROVAL", approval_remaining_seconds: 598 }] });
  assert.equal(await check.run(), "unchanged");
  assert.equal(check.applied.length, 0);
});

test("attendance checks combine previous and selected dates in the existing order", async () => {
  const check = setup({ data: [], paths: ["/today", "/previous"],
    api: async (path) => [{ id: path === "/previous" ? 1 : 2 }],
    select: ([today, previous]) => [...previous, ...today] });
  assert.equal(await check.run(), "updated");
  assert.deepEqual(check.applied, [[{ id: 1 }, { id: 2 }]]);
});

test("a failed multi-request check keeps all previously displayed data", async () => {
  const check = setup({ data: [[{ id: 1 }], [{ id: 2 }]], paths: ["/summary", "/reports"], api: async (path) => {
    if (path === "/reports") throw new Error("Service unavailable");
    return [{ id: 3 }];
  } });
  assert.equal(await check.run(), "error");
  assert.equal(check.applied.length, 0);
  assert.deepEqual(check.errors, ["Service unavailable"]);
  assert.deepEqual(check.notifications, [{ message: "Service unavailable", type: "error" }]);
});

test("an old date/filter response cannot replace the newly selected page data", async () => {
  let complete;
  const check = setup({ api: () => new Promise((resolve) => { complete = resolve; }) });
  const running = check.run();
  check.snapshot.context = JSON.stringify("/operations/?operation_date=2026-11-01");
  complete([{ id: 1 }]);
  assert.equal(await running, "ignored");
  assert.equal(check.applied.length, 0);
  assert.equal(check.notifications.length, 0);
});

test("navigating away discards late responses and notifications", async () => {
  let fail;
  const check = setup({ api: () => new Promise((_, reject) => { fail = reject; }) });
  const running = check.run();
  check.snapshot.active = false;
  fail(new Error("Old request failed"));
  assert.equal(await running, "ignored");
  assert.equal(check.notifications.length, 0);
  assert.equal(check.errors.length, 0);
});

test("the latest update handler can defer applying results to protect unsaved edits", async () => {
  let complete;
  const check = setup({ data: { status: "DRAFT" }, api: () => new Promise((resolve) => { complete = resolve; }) });
  const running = check.run();
  let deferred;
  check.snapshot.apply = (result) => { deferred = result; return "New updates found. Your unsaved changes have been kept."; };
  complete({ status: "CHANGES_REQUIRED" });
  assert.equal(await running, "updated");
  assert.deepEqual(deferred, { status: "CHANGES_REQUIRED" });
  assert.equal(check.applied.length, 0);
  assert.match(check.notifications[0].message, /unsaved changes have been kept/);
});
