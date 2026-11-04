import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, MapPin, RefreshCw, X } from "lucide-react";
import { DutyGeofenceWatcher } from "./dutyGeofenceWatcher.js";
import "./guardGeofence.css";

const empty = [];
const address = (item) => item.site_address || "Site address not provided. Contact the office.";
function BoundaryDialog({ item, onClose, onRetry, busy }) {
  const title = useId(), dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; dialog.current?.querySelector("button")?.focus({ preventScroll: true });
    const keyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = [...dialog.current.querySelectorAll("button:not(:disabled)")], first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keyDown); previous?.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className="guard-geofence-backdrop"><section className="guard-geofence-dialog" role="alertdialog" aria-modal="true" aria-labelledby={title} ref={dialog}>
    <button className="icon-button geofence-close" aria-label="Close site boundary warning" onClick={onClose}><X size={20} /></button>
    <div className="geofence-warning-icon"><AlertTriangle size={28} /></div><p className="eyebrow">SITE BOUNDARY ALERT</p><h2 id={title}>Please return to your site</h2>
    <p>You are outside your assigned site boundary. Please return to your assigned location to continue.</p>
    <div className="geofence-site-details"><strong>{item.site_name}</strong><span><MapPin size={17} />{address(item)}</span><small>Allowed radius: {item.site_geofence_radius_m}m{item.distance_m != null && ` · Current distance: about ${Math.ceil(item.distance_m)}m`}</small></div>
    <p className="geofence-block-note">Book On, Book Off and hourly pictures can only be submitted inside the site boundary.</p>
    <div className="geofence-dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>I understand</button>{onRetry && <button type="button" className="primary-button" disabled={busy} onClick={onRetry}><RefreshCw size={15} />{busy ? "Checking…" : "Check my location"}</button>}</div>
  </section></div>, document.body);
}

export default function GuardGeofenceWarning({ api, sessions = empty, serverTime }) {
  const watcher = useRef(null), [state, setState] = useState({ outside: [], issue: "", busy: false }), [popup, setPopup] = useState(null);
  useEffect(() => {
    const client = new DutyGeofenceWatcher({ api,
      onChange: (value) => { setState(value); setPopup((current) => current?.source === "watch" && !value.outside.some((item) => item.operation_id === current.operation_id) ? null : current); },
      onExit: (item) => { setPopup({ ...item, source: "watch" }); window.dispatchEvent(new CustomEvent("rota:toast", { detail: { type: "error", message: `Please return to ${item.site_name} to continue. Address: ${address(item)}` } })); },
    });
    watcher.current = client;
    const manualWarning = ({ detail }) => { if (detail?.site_name) setPopup({ ...detail, source: "attendance" }); };
    const resume = () => client.reconcile();
    const timer = window.setInterval(resume, 15000);
    document.addEventListener("visibilitychange", resume); window.addEventListener("rota:geofence-outside", manualWarning);
    return () => { client.stop(); window.clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("rota:geofence-outside", manualWarning); };
  }, [api]);
  useEffect(() => { watcher.current?.sync(sessions, serverTime); }, [sessions, serverTime]);
  const retry = () => watcher.current?.retry();
  return <>{state.outside.map((item) => <section className="guard-geofence-banner" role="alert" key={item.operation_id}><AlertTriangle size={24} /><div><strong>Outside your site boundary</strong><p>Please return to {item.site_name} to continue.</p><span>{address(item)}</span><small>Stay within {item.site_geofence_radius_m}m of the assigned site.</small>{state.issue && <small>{state.issue}</small>}</div><button type="button" className="secondary-button" disabled={state.busy} onClick={retry}>{state.busy ? "Checking…" : "Check location"}</button></section>)}
    {!state.outside.length && state.issue && <p className="geofence-gps-issue" role="status">{state.issue}</p>}
    {popup && <BoundaryDialog key={`${popup.operation_id}-${popup.source}`} item={popup} onClose={() => setPopup(null)} onRetry={sessions.some((item) => item.operation_id === popup.operation_id) ? retry : undefined} busy={state.busy} />}
  </>;
}
