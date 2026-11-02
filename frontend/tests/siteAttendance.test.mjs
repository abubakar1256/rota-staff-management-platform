import assert from "node:assert/strict";
import test from "node:test";
import { siteRequiresHourly, siteAttendanceLabel, hourlyCheckinsFor } from "../src/siteAttendance.js";

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
