import assert from "node:assert/strict";
import test from "node:test";
import { siteRequiresHourly, siteAttendanceLabel, hourlyCheckinsFor, bookOnIsLate } from "../src/siteAttendance.js";

test("book on/off mode removes hourly steps even if old check-ins are cached", () => {
  const item = { attendance_mode: "BOOK_ON_OFF", hourly_pictures_required: false, hourly_checkins: [{ sequence: 1, status: "EXPIRED" }] };
  assert.equal(siteRequiresHourly(item), false);
  assert.deepEqual(hourlyCheckinsFor(item), []);
  assert.equal(siteAttendanceLabel(item), "Book On / Book Off only");
});

test("hourly mode keeps the server's available and missed-picture steps", () => {
  const steps = [{ sequence: 1, status: "EXPIRED" }, { sequence: 2, status: "AVAILABLE" }];
  const item = { attendance_mode: "WITH_HOURLY", hourly_pictures_required: true, hourly_checkins: steps };
  assert.equal(siteRequiresHourly(item), true);
  assert.deepEqual(hourlyCheckinsFor(item), steps);
});

test("older API responses retain the existing hourly workflow during deployment", () => {
  assert.equal(siteRequiresHourly({}), true);
  assert.deepEqual(hourlyCheckinsFor({ hourly_checkins: [{ sequence: 1 }] }), [{ sequence: 1 }]);
  assert.deepEqual(hourlyCheckinsFor({ attendance_mode: "BOOK_ON_OFF" }), []);
});

test("late Book On appears after the scheduled instant even if the page opened early", () => {
  const item = { book_on_due_at: "2026-11-02T08:00:00+00:00", book_on_is_late: false };
  assert.equal(bookOnIsLate(item, Date.parse("2026-11-02T07:59:00Z")), false);
  assert.equal(bookOnIsLate(item, Date.parse("2026-11-02T08:00:00Z")), false);
  assert.equal(bookOnIsLate(item, Date.parse("2026-11-02T08:10:00Z")), true);
});

test("a completed on-time Book On stays on time and a legacy late event can be explained", () => {
  const item = { book_on_due_at: "2026-11-02T08:00:00Z", book_on_is_late: false, attendance_events: [{ event_type: "BOOK_ON", captured_at: "2026-11-02T08:00:00Z" }] };
  assert.equal(bookOnIsLate(item, Date.parse("2026-11-02T14:00:00Z")), false);
  assert.equal(bookOnIsLate({ ...item, book_on_is_late: true, attendance_events: [{ event_type: "BOOK_ON", captured_at: "2026-11-02T08:10:00Z", late_reason: "" }] }), true);
});

test("server timing wins when the guard device clock is behind", () => {
  assert.equal(bookOnIsLate({ book_on_is_late: true, book_on_due_at: "2026-11-02T08:00:00Z" }, Date.parse("2026-11-02T07:00:00Z")), true);
});

test("overnight and offset timestamps use actual instants without inventing device-local times", () => {
  const item = { book_on_due_at: "2026-11-02T20:00:00+01:00" };
  assert.equal(bookOnIsLate(item, Date.parse("2026-11-02T18:59:00Z")), false);
  assert.equal(bookOnIsLate(item, Date.parse("2026-11-03T00:10:00Z")), true);
  assert.equal(bookOnIsLate({}), false);
});
