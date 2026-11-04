import assert from "node:assert/strict";
import test from "node:test";
import { shiftTimeline, evidencePoint, evidenceMapUrl } from "../src/completeShift.js";

test("one shift keeps missed hourly reasons beside the correct numbered picture", () => {
  const operation = {
    attendance_events: [{ id: 1, event_type: "BOOK_ON", late_reason: "Traffic" }, { id: 2, event_type: "HOURLY", sequence: 3, notes: "Patrol complete" }],
    hourly_checkins: [{ sequence: 3, status: "COMPLETED" }, { sequence: 1, status: "EXPIRED", missed_reason: "Site incident" }, { sequence: 2, status: "EXPIRED" }],
    hourly_checkin_notes: [{ sequence: 2, reason: "Camera unavailable", updated_at: "2026-11-04T10:15:00Z" }],
    book_off_status: "EXPIRED", book_off_note: { reason: "Relief guard delayed", updated_at: "2026-11-04T20:00:00Z" },
  };
  const timeline = shiftTimeline(operation);
  assert.deepEqual(timeline.map((step) => step.key), ["book-on", "hourly-1", "hourly-2", "hourly-3", "book-off"]);
  assert.equal(timeline[0].reason, "Traffic");
  assert.equal(timeline[1].reason, "Site incident");
  assert.equal(timeline[2].reason, "Camera unavailable");
  assert.equal(timeline[2].reason_at, "2026-11-04T10:15:00Z");
  assert.equal(timeline[3].event.id, 2);
  assert.equal(timeline[3].event.notes, "Patrol complete");
  assert.equal(timeline[4].reason, "Relief guard delayed");
});

test("retained hourly evidence remains visible after a site switches to Book On/Off only", () => {
  const steps = shiftTimeline({ attendance_mode: "BOOK_ON_OFF", hourly_checkins: [],
    attendance_events: [{ event_type: "HOURLY", sequence: 5, photo_url: "/api/media/attendance/12/" }],
    hourly_checkin_notes: [{ sequence: 2, reason: "Emergency" }] });
  assert.deepEqual(steps.map((step) => step.key), ["book-on", "hourly-2", "hourly-5", "book-off"]);
  assert.equal(steps[2].status, "COMPLETED");
  assert.equal(steps[2].event.photo_url, "/api/media/attendance/12/");
});

test("an unfinished shift never invents Book Off or treats an upcoming slot as missed", () => {
  const steps = shiftTimeline({ hourly_checkins: [{ sequence: 1, status: "AVAILABLE" }, { sequence: 2, status: "UPCOMING" }] });
  assert.deepEqual(steps.map((step) => step.status), ["WAITING", "AVAILABLE", "UPCOMING", "UPCOMING"]);
  assert.ok(steps.every((step) => !step.event));
});

test("recorded Book Off and hourly events override stale window statuses without losing evidence", () => {
  const steps = shiftTimeline({ book_off_status: "EXPIRED", hourly_checkins: [{ sequence: 1, status: "EXPIRED" }],
    attendance_events: [{ event_type: "BOOK_OFF", captured_at: "2026-11-04T19:10:00Z" }, { event_type: "HOURLY", sequence: 1 }] });
  assert.equal(steps[1].status, "COMPLETED");
  assert.equal(steps.at(-1).status, "COMPLETED");
  assert.equal(steps.at(-1).event.captured_at, "2026-11-04T19:10:00Z");
});

test("maps accept zero coordinates and reject missing or invalid locations", () => {
  assert.deepEqual(evidencePoint({ latitude: 0, longitude: 0 }), { latitude: 0, longitude: 0 });
  assert.match(evidenceMapUrl({ latitude: 51.5, longitude: -.12 }), /mlat=51.5&mlon=-0.12/);
  for (const value of [null, { latitude: null, longitude: 0 }, { latitude: "", longitude: "" }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: "nan", longitude: 0 }]) {
    assert.equal(evidencePoint(value), null);
    assert.equal(evidenceMapUrl(value), null);
  }
});
