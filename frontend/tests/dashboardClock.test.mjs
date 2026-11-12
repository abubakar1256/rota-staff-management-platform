import assert from "node:assert/strict";
import test from "node:test";
import { formatDashboardClock, ukDate, formatUkAttendanceTime, formatUkDateTime, formatUkShortDateTime } from "../src/ukTime.js";

test("London winter time uses GMT and summer time uses BST", () => {
  assert.deepEqual(formatDashboardClock("2026-11-04T08:24:01Z"), { time: "08:24:01 am", date: "Wednesday, 4 November 2026", abbreviation: "GMT" });
  assert.equal(formatDashboardClock("2026-07-04T08:24:01Z").time, "09:24:01 am");
  assert.equal(formatDashboardClock("2026-07-04T08:24:01Z").abbreviation, "BST");
});

test("the spring clock change skips forward automatically", () => {
  assert.equal(formatDashboardClock("2026-03-29T00:59:59Z").time, "12:59:59 am");
  assert.equal(formatDashboardClock("2026-03-29T00:59:59Z").abbreviation, "GMT");
  assert.equal(formatDashboardClock("2026-03-29T01:00:00Z").time, "02:00:00 am");
  assert.equal(formatDashboardClock("2026-03-29T01:00:00Z").abbreviation, "BST");
});

test("the autumn clock change moves back automatically", () => {
  assert.equal(formatDashboardClock("2026-10-25T00:59:59Z").time, "01:59:59 am");
  assert.equal(formatDashboardClock("2026-10-25T00:59:59Z").abbreviation, "BST");
  assert.equal(formatDashboardClock("2026-10-25T01:00:00Z").time, "01:00:00 am");
  assert.equal(formatDashboardClock("2026-10-25T01:00:00Z").abbreviation, "GMT");
});

test("the dashboard date stays in London even on a Pakistan device", () => {
  const oldZone = process.env.TZ;
  try {
    process.env.TZ = "Asia/Karachi";
    assert.equal(formatDashboardClock("2026-11-03T23:30:00Z").date, "Tuesday, 3 November 2026");
    assert.equal(formatDashboardClock("2026-11-03T23:30:00Z").time, "11:30:00 pm");
  } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
});

test("control room dates and attendance use London GMT/BST on a Pakistan device", () => {
  const oldZone = process.env.TZ;
  try {
    process.env.TZ = "Asia/Karachi";
    assert.equal(ukDate(new Date("2026-11-03T23:30:00Z")), "2026-11-03");
    assert.equal(formatUkAttendanceTime("2026-11-04T14:48:00+05:00"), "09:48 GMT");
    assert.equal(formatUkAttendanceTime("2026-07-04T09:48:00Z"), "10:48 BST");
    assert.equal(formatUkAttendanceTime(null), "—");
    assert.match(formatUkDateTime("2026-11-04T14:48:00+05:00"), /04 Nov 2026, 09:48 GMT/);
    assert.match(formatUkDateTime("2026-07-04T09:48:00Z"), /04 Jul 2026, 10:48 BST/);
  } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
});

test("short shift times keep both London dates across midnight and omit the year and zone", () => {
  const start = formatUkShortDateTime("2026-11-13T22:00:00+05:00");
  const end = formatUkShortDateTime("2026-11-14T08:00:00+05:00");
  assert.equal(`${start} – ${end}`, "13 Nov, 17:00 – 14 Nov, 03:00");
  assert.equal(formatUkShortDateTime("2026-07-13T23:00:00Z"), "14 Jul, 00:00");
});
