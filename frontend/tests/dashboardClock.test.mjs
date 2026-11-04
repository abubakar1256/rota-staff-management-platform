import assert from "node:assert/strict";
import test from "node:test";
import { formatDashboardClock } from "../src/ukTime.js";

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
