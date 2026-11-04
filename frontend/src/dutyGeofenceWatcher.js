import { attendanceGeofenceCheck } from "./attendanceGeofence.js";
import { requestDutyPosition } from "./dutyLocationClient.js";

export class DutyGeofenceWatcher {
  constructor({ api, onChange, onExit, onEnter = () => {}, notifyChanged = () => window.dispatchEvent(new Event("rota:notifications-changed")),
    watch = (success, failure) => navigator.geolocation?.watchPosition(success, failure, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }),
    clear = (id) => navigator.geolocation?.clearWatch(id), getPosition = requestDutyPosition,
    clock = () => performance.now(), now = () => Date.now(), visible = () => document.visibilityState === "visible" }) {
    Object.assign(this, { api, onChange, onExit, onEnter, notifyChanged, watch, clear, getPosition, clock, now, visible });
    this.items = []; this.phases = new Map(); this.sent = new Map(); this.lastReport = new Map(); this.queues = new Map();
    this.watchId = null; this.stopped = false; this.busy = false; this.issue = ""; this.controller = new AbortController();
  }
  serverNow() { return this.anchor ? this.anchor.server + this.clock() - this.anchor.client : this.now(); }
  active(id) { return !this.stopped && this.items.some((item) => item.operation_id === id && this.serverNow() < Date.parse(item.stop_at)); }
  publish() {
    if (!this.stopped) this.onChange({ outside: this.items.filter((item) => this.phases.get(item.operation_id)?.status === "OUTSIDE")
      .map((item) => ({ ...item, distance_m: this.phases.get(item.operation_id).distance_m })), issue: this.issue, busy: this.busy });
  }
  sync(items, serverTime) {
    if (this.stopped) return;
    const server = Date.parse(serverTime); if (Number.isFinite(server)) this.anchor = { server, client: this.clock() };
    this.items = items || []; this.reconcile();
  }
  reconcile() {
    if (this.stopped) return;
    this.items = this.items.filter((item) => this.serverNow() < Date.parse(item.stop_at));
    for (const id of this.phases.keys()) if (!this.active(id)) { this.phases.delete(id); this.sent.delete(id); }
    const enabled = this.visible() && this.items.length > 0;
    if (!enabled && this.watchId != null) { this.clear(this.watchId); this.watchId = null; }
    if (enabled && this.watchId == null) {
      try { this.watchId = this.watch((position) => this.position(position), (error) => this.failure(error)); if (this.watchId == null) this.failure({ code: 2 }); }
      catch { this.failure({ code: 2 }); }
    }
    if (!this.items.length) this.issue = "";
    this.publish();
  }
  failure(error) {
    if (this.stopped || !this.visible() || !this.items.length) return;
    this.issue = error?.code === 1 ? "Allow location access and enable precise GPS to check your site boundary." : "GPS could not verify your site boundary. Set your location again.";
    this.publish();
  }
  position(position) {
    if (this.stopped || !this.visible()) return;
    this.reconcile();
    if (!position?.coords || !Number.isFinite(position.timestamp) || Math.abs(this.now() - position.timestamp) > 120000) { this.failure({ code: 2 }); return; }
    this.issue = "";
    for (const item of this.items) {
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy };
      const result = attendanceGeofenceCheck(item, point), previous = this.phases.get(item.operation_id)?.status;
      if (result.status === "UNVERIFIED") { this.issue = result.message; continue; }
      this.phases.set(item.operation_id, result);
      if (result.status === "OUTSIDE" && previous !== "OUTSIDE") this.onExit({ ...item, distance_m: result.distance_m });
      if (result.status === "INSIDE" && previous === "OUTSIDE") this.onEnter(item);
      if (result.status === "OUTSIDE" || previous === "OUTSIDE" || item.has_open_alert) this.send(item, result.status, position);
    }
    this.publish();
  }
  send(item, status, position) {
    const id = item.operation_id, last = this.lastReport.get(id);
    if (this.sent.get(id) === status || (last?.status === status && this.clock() - last.time < 60000)) return;
    this.sent.set(id, status); this.lastReport.set(id, { status, time: this.clock() });
    const work = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.active(id) || !this.visible()) {
        if (this.sent.get(id) === status) { this.sent.delete(id); this.lastReport.delete(id); }
        return;
      }
      try {
        const result = await this.api(`/location-tracking/${id}/geofence/`, { method: "POST", body: JSON.stringify({
          latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy_m: position.coords.accuracy,
          captured_at: new Date(position.timestamp).toISOString() }), signal: this.controller.signal,
          silentLoading: true, silentError: true, silentToast: true, skipInvalidation: true });
        if (this.stopped) return;
        if (result.status === "UNVERIFIED") this.sent.delete(id);
        if (result.created || result.resolved) this.notifyChanged();
        if (status === "INSIDE") this.items = this.items.map((row) => row.operation_id === id ? { ...row, has_open_alert: false } : row);
      } catch (error) {
        if (this.stopped) return;
        if (this.sent.get(id) === status) this.sent.delete(id);
        if (error.status === 409) { this.items = this.items.filter((row) => row.operation_id !== id); this.reconcile(); }
        else { this.issue = "Site boundary alert could not reach the office. Check your connection and retry."; this.publish(); }
      }
    });
    this.queues.set(id, work);
  }
  async retry() {
    if (this.stopped || this.busy || !this.visible() || !this.items.length) return;
    this.busy = true; this.lastReport.clear(); this.publish();
    try { this.position(await this.getPosition()); } catch (error) { this.failure(error); }
    finally { this.busy = false; this.publish(); }
  }
  stop() { this.stopped = true; if (this.watchId != null) this.clear(this.watchId); this.watchId = null; this.controller.abort(); this.items = []; }
}
