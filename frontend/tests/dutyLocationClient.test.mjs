import assert from "node:assert/strict";
import test from "node:test";
import { DutyLocationClient, positionFailure } from "../src/dutyLocationClient.js";

const base = Date.parse("2026-11-04T08:00:00Z");
function fixture() {
  let elapsed = 0, visible = true, active = true, captures = 0, failure = null;
  let item = { operation_id: 7, tracking_active: true, stop_at: "2026-11-04T20:00:00Z", next_due_at: "2026-11-04T08:30:00Z", status: "UPDATED", site_name: "Example site" };
  const calls = [], states = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options, body: options.body ? JSON.parse(options.body) : null });
    const server_time = new Date(base + elapsed).toISOString();
    if (path.endsWith("/active/")) return { server_time, results: active ? [item] : [] };
    const body = JSON.parse(options.body);
    if (body.status === "UPDATED") item = { ...item, status: "UPDATED", next_due_at: new Date(base + elapsed + 1800000).toISOString() };
    else if (body.status !== "HEARTBEAT") item = { ...item, status: body.status };
    return { server_time, tracking: item };
  };
  const client = new DutyLocationClient({ api, clock: () => elapsed, visible: () => visible, onChange: (value) => states.push(value),
    getPosition: async () => { captures++; if (failure) throw failure; return { coords: { latitude: 51.5, longitude: -.12, accuracy: 9 }, timestamp: base + elapsed }; } });
  return { client, calls, states, setItem: (value) => { item = { ...item, ...value }; }, setTime: (value) => { elapsed = value; }, setActive: (value) => { active = value; }, setVisible: (value) => { visible = value; }, fail: (value) => { failure = value; }, captures: () => captures };
}

test("a newly enabled session without a current GPS fix captures immediately", async () => {
  const f = fixture(); f.setItem({ status: "WAITING", next_due_at: new Date(base).toISOString() });
  await f.client.tick();
  assert.equal(f.captures(), 1);
  assert.equal(f.calls.at(-1).body.status, "UPDATED");
  f.setTime(60000); await f.client.tick();
  assert.equal(f.captures(), 1);
});

test("a fresh Book On point waits 30 minutes; heartbeat contains no fake location", async () => {
  const f = fixture(); await f.client.tick();
  assert.equal(f.captures(), 0);
  assert.deepEqual(f.calls.at(-1).body, { status: "HEARTBEAT" });
  f.setTime(1800000); await f.client.tick();
  assert.equal(f.captures(), 1);
  assert.equal(f.calls.at(-1).body.status, "UPDATED");
  assert.equal(f.calls.at(-1).body.accuracy_m, 9);
  f.setTime(1860000); await f.client.tick(); assert.equal(f.captures(), 1);
});

test("known permission denial is reported even before the next due fix", async () => {
  const f = fixture(); f.client.permission = "denied"; await f.client.tick();
  assert.equal(f.captures(), 0);
  assert.deepEqual(f.calls.at(-1).body, { status: "PERMISSION_DENIED" });
  assert.equal(f.client.items[0].status, "PERMISSION_DENIED");
});

test("timeouts retry at most every five minutes and manual retry can restore location", async () => {
  const f = fixture(); f.setTime(1800000); f.fail({ code: 3 }); await f.client.tick();
  assert.equal(f.calls.at(-1).body.status, "TIMEOUT");
  f.setTime(1860000); await f.client.tick(); assert.equal(f.captures(), 1);
  f.fail(null); await f.client.tick({ force: true });
  assert.equal(f.captures(), 2); assert.equal(f.client.items[0].status, "UPDATED");
});

test("closed duty and hidden pages never request a GPS location", async () => {
  const f = fixture(); f.setTime(1800000); f.setActive(false); await f.client.tick({ force: true });
  assert.equal(f.captures(), 0);
  const count = f.calls.length; f.setVisible(false); await f.client.tick({ force: true });
  assert.equal(f.calls.length, count);
  f.setVisible(true); f.setActive(true); f.setTime(43200000); await f.client.tick({ force: true });
  assert.equal(f.captures(), 0);
});

test("a position arriving after sign out/unmount is never uploaded", async () => {
  const f = fixture(); f.setTime(1800000);
  let finish;
  f.client.getPosition = () => new Promise((resolve) => { finish = resolve; });
  const work = f.client.tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.client.stop(); finish({ coords: { latitude: 51.5, longitude: -.12, accuracy: 5 }, timestamp: base + 1800000 });
  await work;
  assert.equal(f.calls.filter((call) => call.body?.status === "UPDATED").length, 0);
  assert.equal(f.client.controller.signal.aborted, true);
});

test("server rejection after Book Off removes the pending tracking session", async () => {
  const f = fixture(); f.setTime(1800000); const api = f.client.api;
  f.client.api = async (path, options) => { if (path.endsWith("/report/")) { const error = new Error("Ended"); error.status = 409; throw error; } return api(path, options); };
  await f.client.tick(); assert.deepEqual(f.client.items, []);
});

test("GPS error categories do not claim the guard intentionally disabled location", () => {
  assert.equal(positionFailure({ code: 1 }), "PERMISSION_DENIED");
  assert.equal(positionFailure({ code: 2 }), "UNAVAILABLE");
  assert.equal(positionFailure({ code: 3 }), "TIMEOUT");
  assert.equal(positionFailure(new Error("Offline")), "UNAVAILABLE");
});

test("permission changes during an in-flight GPS read are processed afterward", async () => {
  const f = fixture(); f.setTime(1800000);
  let finish;
  f.client.getPosition = () => new Promise((resolve) => { finish = resolve; });
  const work = f.client.tick(); await new Promise((resolve) => setImmediate(resolve));
  f.client.permission = "denied"; await f.client.tick();
  finish({ coords: { latitude: 51.5, longitude: -.12, accuracy: 5 }, timestamp: base + 1800000 });
  await work; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.at(-1).body.status, "PERMISSION_DENIED");
});
