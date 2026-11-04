import { useEffect, useRef, useState } from "react";
import { MapPin, RefreshCw } from "lucide-react";
import { DutyLocationClient } from "./dutyLocationClient";
import "./locationTracking.css";

export default function GuardLocationMonitor({ api }) {
  const clientRef = useRef(null);
  const [state, setState] = useState({ items: [], busy: false, message: "" });
  useEffect(() => {
    const client = new DutyLocationClient({ api, onChange: setState }); clientRef.current = client;
    let permission, disposed = false;
    const changed = () => { client.permission = permission.state; client.tick({ force: permission.state === "granted" }); };
    navigator.permissions?.query({ name: "geolocation" }).then((result) => {
      if (disposed) return;
      permission = result; client.permission = result.state; result.addEventListener("change", changed);
      client.tick();
    }).catch(() => {});
    client.tick();
    const timer = window.setInterval(() => client.tick(), 60000);
    const resume = () => client.tick();
    const dataChanged = (event) => { if (String(event.detail?.path || "").startsWith("/operations/")) client.tick(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume); window.addEventListener("rota:data-changed", dataChanged);
    return () => { disposed = true; client.stop(); window.clearInterval(timer); permission?.removeEventListener("change", changed); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); window.removeEventListener("rota:data-changed", dataChanged); };
  }, [api]);
  if (!state.items.length) return null;
  const issue = state.message || state.items.some((item) => item.overdue || ["PERMISSION_DENIED", "UNAVAILABLE", "TIMEOUT"].includes(item.status));
  return <section className={`guard-location-banner${issue ? " has-issue" : ""}`} aria-label="Duty location tracking"><MapPin size={21} aria-hidden="true" /><div><strong>Location tracking active</strong><p>{state.items.map((item) => item.site_name).join(", ")} · Every 30 minutes during duty.</p><small>{state.message || (issue ? "Location needs attention. Allow location access, enable GPS and retry." : "Keep this portal open. Updates may pause when your phone is locked or the browser is in the background.")}</small>{state.items.map((item) => <small key={item.operation_id}>{item.site_name}: {item.status_label}{item.last_location_at ? ` · Last update ${new Date(item.last_location_at).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}` : ""}</small>)}</div>{issue && <button className="secondary-button" disabled={state.busy} onClick={() => clientRef.current?.tick({ force: true })}><RefreshCw size={14} />{state.busy ? "Checking…" : "Retry location"}</button>}</section>;
}
