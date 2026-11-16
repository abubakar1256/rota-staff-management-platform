import assert from "node:assert/strict";
import test from "node:test";
import { actualTimes, formatTimesheetDuration, weeklyTimesheetTotals } from "../src/timesheetHours.js";

test("weekly totals group sites, count unique worked days and add overtime once", () => {
  const shared = { employee: 1, employee_name: "Fixture guard", site: 1, site_name: "First site", work_date: "2026-11-16" };
  const result = weeklyTimesheetTotals([
    { ...shared, id: 1, actual_seconds: 3600, overtime_minutes: 15 },
    { ...shared, id: 2, actual_seconds: 1800, overtime_minutes: 0 },
    { ...shared, id: 3, site: 2, site_name: "Second site", actual_seconds: 1800, overtime_minutes: 0 },
    { ...shared, id: 4, work_date: "2026-11-17", actual_seconds: 0, overtime_minutes: 0 },
  ]);
  assert.equal(result.guards[0].days.size, 1);
  assert.equal(result.sites[0].guards[0].days.size, 1);
  assert.equal(result.sites[0].guards[0].entries.length, 3);
  assert.deepEqual(result.total, { actual: 7200, overtime: 900, total: 8100 });
  assert.equal(formatTimesheetDuration(result.sites[0].total), "1h 45m");
  assert.equal(formatTimesheetDuration(result.guards[0].total), "2h 15m");
});

test("corrected timestamps display UK time with both dates and retain the original ISO instants for submission", () => {
  const sheet = { corrected_start_at: "2026-07-13T21:58:31Z", corrected_end_at: "2026-07-14T05:16:04Z" };
  assert.deepEqual(actualTimes(sheet), {
    start: "2026-07-13T22:58", end: "2026-07-14T06:16",
    startAt: sheet.corrected_start_at, endAt: sheet.corrected_end_at,
  });
  assert.deepEqual(actualTimes({ work_date: "2026-11-16", actual_start: "19:00:00", actual_end: "07:00:00" }), {
    start: "2026-11-16T19:00", end: "2026-11-17T07:00",
  });
});
