export function positionFailure(error) {
  return error?.code === 1 ? "PERMISSION_DENIED" : error?.code === 3 ? "TIMEOUT" : "UNAVAILABLE";
}

export function requestDutyPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject({ code: 2 }); return; }
    let done = false;
    const finish = (callback, value) => { if (!done) { done = true; clearTimeout(timer); callback(value); } };
    // An unanswered permission prompt must not leave the monitor in flight forever.
    const timer = setTimeout(() => finish(reject, { code: 3 }), 25000);
    navigator.geolocation.getCurrentPosition((position) => finish(resolve, position), (error) => finish(reject, error),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

export class DutyLocationClient {
  constructor({ api, onChange, getPosition = requestDutyPosition, clock = () => performance.now(), visible = () => document.visibilityState === "visible" }) {
    Object.assign(this, { api, onChange, getPosition, clock, visible });
    this.items = []; this.lastAttempt = new Map(); this.lastHeartbeat = new Map(); this.permission = "unknown";
    this.controller = new AbortController(); this.stopped = false; this.busy = false; this.message = "";
  }
  serverNow() { return this.anchor ? this.anchor.server + this.clock() - this.anchor.client : Date.now(); }
  anchorTime(value) { const parsed = Date.parse(value); if (Number.isFinite(parsed)) this.anchor = { server: parsed, client: this.clock() }; }
  live(id) { return !this.stopped && this.items.find((item) => item.operation_id === id && item.tracking_active && this.serverNow() < Date.parse(item.stop_at)); }
  publish() { if (!this.stopped) this.onChange({ items: this.items, busy: this.busy, message: this.message }); }
  stop() { this.stopped = true; this.items = []; this.controller.abort(); }
  async report(item, payload) {
    if (!this.live(item.operation_id)) return;
    try {
      const data = await this.api(`/location-tracking/${item.operation_id}/report/`, { method: "POST", body: JSON.stringify(payload), signal: this.controller.signal, silentLoading: true, silentToast: true, silentError: true, skipInvalidation: true });
      if (this.stopped) return;
      this.anchorTime(data.server_time);
      if (data.tracking) this.items = this.items.map((row) => row.operation_id === item.operation_id ? data.tracking : row);
      this.message = "";
    } catch (error) {
      if (this.stopped) return;
      if (error.status === 409) this.items = this.items.filter((row) => row.operation_id !== item.operation_id);
      else this.message = "Location update could not reach the office. Check your connection and try again.";
    }
  }
  async tick({ force = false } = {}) {
    if (this.stopped || !this.visible()) return;
    if (this.busy) { this.queued = true; this.queuedForce = this.queuedForce || force; return; }
    this.busy = true; this.publish();
    try {
      const data = await this.api("/location-tracking/active/", { signal: this.controller.signal, silentLoading: true, silentError: true });
      if (this.stopped) return;
      this.anchorTime(data.server_time);
      this.items = (data.results || []).filter((item) => item.tracking_active && this.serverNow() < Date.parse(item.stop_at));
      this.message = ""; this.publish();
      for (const item of [...this.items]) {
        if (!this.live(item.operation_id) || !this.visible()) continue;
        const id = item.operation_id, now = this.clock();
        const canAttempt = force || !this.lastAttempt.has(id) || now - this.lastAttempt.get(id) >= 300000;
        const denied = this.permission === "denied" && item.status !== "PERMISSION_DENIED";
        const due = item.next_due_at && this.serverNow() >= Date.parse(item.next_due_at);
        if (denied || ((force || due) && canAttempt)) {
          this.lastAttempt.set(id, now); this.lastHeartbeat.set(id, now);
          if (this.permission === "denied" && !force) { await this.report(item, { status: "PERMISSION_DENIED" }); continue; }
          let position;
          try { position = await this.getPosition(); }
          catch (error) { if (this.live(id)) await this.report(item, { status: positionFailure(error) }); continue; }
          if (!this.live(id) || !this.visible()) continue;
          await this.report(item, { status: "UPDATED", latitude: position.coords.latitude, longitude: position.coords.longitude,
            accuracy_m: position.coords.accuracy, captured_at: new Date(position.timestamp).toISOString() });
        } else if (!this.lastHeartbeat.has(id) || now - this.lastHeartbeat.get(id) >= 300000) {
          this.lastHeartbeat.set(id, now); await this.report(item, { status: "HEARTBEAT" });
        }
      }
    } catch (error) {
      if (!this.stopped) this.message = this.items.length ? "Location tracking cannot contact the office. Check your connection." : "";
    } finally {
      this.busy = false; this.publish();
      if (this.queued && !this.stopped) {
        const queuedForce = Boolean(this.queuedForce); this.queued = false; this.queuedForce = false;
        queueMicrotask(() => this.tick({ force: queuedForce }));
      }
    }
  }
}
