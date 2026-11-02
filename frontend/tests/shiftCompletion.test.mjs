import test from "node:test";
import assert from "node:assert/strict";
import { completionStatus, formatShiftDuration } from "../src/shiftCompletion.js";

test("duration represents overnight and partial hours without wrapping at midnight", () => {
  assert.equal(formatShiftDuration(730), "12h 10m");
  assert.equal(formatShiftDuration(1500), "25h 0m");
  assert.equal(formatShiftDuration(59.9), "0h 59m");
  assert.equal(formatShiftDuration(0), "0h 0m");
});

test("missing legacy timestamps never display invented zero hours", () => {
  for (const value of [null, undefined, NaN, "invalid"]) assert.equal(formatShiftDuration(value), "Not available");
});

test("a submitted draft and historical record are never labelled approved", () => {
  assert.equal(completionStatus({ timesheet_status: "DRAFT" }), "Awaiting office review");
  assert.equal(completionStatus({ timesheet_status: "REVIEW_REQUIRED" }), "Review required");
  assert.equal(completionStatus({ timesheet_status: "NOT_CREATED" }), "Office follow-up required");
  assert.equal(completionStatus({ timesheet_status: "APPROVED" }), "Approved by office");
});
