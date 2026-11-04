import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Clock3, MapPin, X } from "lucide-react";
import { shiftTimeline, evidenceMapUrl, evidencePoint } from "./completeShift.js";
import { formatShiftDuration, completionStatus, reviewFlagLabels } from "./shiftCompletion.js";
import { UK_TIME_ZONE } from "./ukTime.js";
import "./completeShift.css";

const displayTime = (value) => value ? new Date(value).toLocaleString("en-GB", { timeZone: UK_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }) : "Not recorded";
const labels = { COMPLETED: "Received", EXPIRED: "Missed", AVAILABLE: "Window open", UPCOMING: "Upcoming", WAITING: "Awaiting Book On" };
const locationLabels = { UPDATED: "Location received", PERMISSION_DENIED: "Permission denied", UNAVAILABLE: "Location unavailable", TIMEOUT: "Location timed out" };
function MapLink({ value }) {
  const url = evidenceMapUrl(value);
  return url && <a className="mini-button" href={url} target="_blank" rel="noopener noreferrer"><MapPin size={13} />View location</a>;
}

export default function CompleteShiftReview({ operationId, api, FilePreview, onClose, onUpdate, canTrack = true }) {
  const [operation, setOperation] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [history, setHistory] = useState(null), [historyError, setHistoryError] = useState(""), [historyLoading, setHistoryLoading] = useState(canTrack);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const titleId = useId(), dialog = useRef(null), close = useRef(onClose), update = useRef(onUpdate);
  close.current = onClose;
  update.current = onUpdate;

  useEffect(() => {
    const trigger = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector("button")?.focus({ preventScroll: true });
    const keyDown = (event) => {
      // A protected photo preview can open its own dialog above this one.
      if (!dialog.current?.contains(event.target) || dialog.current.querySelector(".protected-file-preview-modal")) return;
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key === "Tab") {
        const controls = [...dialog.current.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keyDown); trigger?.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let active = true, pending = false;
    const load = async (manual = false) => {
      if (pending) return;
      pending = true;
      if (manual) setLoading(true);
      try {
        const value = await api(`/operations/${operationId}/`, { silentLoading: true, silentError: true });
        if (active) { setOperation(value); update.current?.(value); setError(""); }
      } catch (err) { if (active) setError(err.message); }
      finally { pending = false; if (active) setLoading(false); }
    };
    load(true);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, [operationId, api, refresh]);

  useEffect(() => {
    if (!canTrack) return;
    let active = true, pending = false;
    setHistory((current) => current?.pagination.page === page ? current : null);
    setHistoryLoading(true); setHistoryError("");
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await api(`/location-tracking/${operationId}/history/?page=${page}`, { silentLoading: true, silentError: true });
        if (active) { setHistory(value); setHistoryError(""); }
      } catch (err) { if (active) setHistoryError(err.message); }
      finally { pending = false; if (active) setHistoryLoading(false); }
    };
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, [operationId, api, canTrack, page, refresh]);

  const steps = operation ? shiftTimeline(operation) : [];
  const hourly = steps.filter((step) => step.key.startsWith("hourly-"));
  const on = steps[0]?.event, off = steps.at(-1)?.event, summary = operation?.completion_summary;
  return <div className="modal-backdrop"><section className="modal-card complete-shift-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
    <header className="complete-shift-header"><div><p className="eyebrow">COMPLETE SHIFT RECORD</p><h3 id={titleId}>{operation?.employee_name || "Loading shift…"}</h3><p className="muted">{operation && `${operation.site_name} · ${operation.operation_date} · ${operation.shift_name} · ${String(operation.scheduled_start).slice(0, 5)}–${String(operation.scheduled_end).slice(0, 5)}`}</p><small>All times: Europe/London (GMT/BST)</small></div><button type="button" className="icon-button" aria-label="Close complete shift" onClick={onClose}><X size={20} /></button></header>
    <div className="complete-shift-toolbar"><span>{off ? "Shift completed" : on ? "Guard on duty" : "Book On not received"} · Read only</span><button type="button" className="mini-button" disabled={loading || historyLoading} onClick={() => setRefresh((value) => value + 1)}>{loading || historyLoading ? "Checking…" : "Check updates"}</button></div>
    <div className="complete-shift-body">
      {error && <p className="error" role="alert">{error} <button type="button" className="mini-button" onClick={() => setRefresh((value) => value + 1)}>Try again</button></p>}
      {!operation && loading && <p role="status">Loading attendance evidence…</p>}
      {operation && <>
        <dl className="complete-shift-facts"><div><dt>Book On</dt><dd>{displayTime(on?.captured_at)}</dd></div><div><dt>Book Off</dt><dd>{displayTime(off?.captured_at)}</dd></div><div><dt>Hourly pictures</dt><dd>{hourly.filter((step) => step.event).length} / {hourly.length} received</dd></div><div><dt>Missed pictures</dt><dd>{steps.filter((step) => step.status === "EXPIRED").length}</dd></div></dl>
        {summary && <p className="complete-shift-timesheet">Duration: <strong>{formatShiftDuration(summary.duration_minutes)}</strong> · Timesheet: <strong>{completionStatus(summary)}</strong>{summary.review_flags?.length > 0 && <span>For office review: {summary.review_flags.map((flag) => reviewFlagLabels[flag] || flag).join(" · ")}</span>}</p>}
        <h4>Book On to Book Off</h4>
        <ol className="complete-shift-timeline">{steps.map((step) => {
          const event = step.event, point = evidencePoint(event);
          return <li className={`complete-shift-step ${step.status.toLowerCase()}`} key={step.key}>
            <span className="complete-shift-marker" aria-hidden="true">{event ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}</span>
            <div className="complete-shift-step-content"><div className="complete-shift-step-heading"><h5>{step.label}</h5><span className={`status-pill ${event ? "present" : step.status === "EXPIRED" ? "pending" : "neutral"}`}>{labels[step.status] || step.status}</span></div>
              {event ? <><p>Captured: <strong>{displayTime(event.captured_at)}</strong></p><p>GPS: {(event.location_status || "Not recorded").replaceAll("_", " ")}{point && ` · ${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`}{event.accuracy_m != null && ` · Accuracy ±${Math.round(event.accuracy_m)} m`}{event.distance_m != null && ` · ${Math.round(event.distance_m)} m from site`}</p><div className="row-actions">{event.photo_url ? <FilePreview value={event.photo_url} label={`${operation.employee_name} · ${step.label}`} buttonLabel="View picture" /> : <span className="muted">Picture unavailable</span>}<MapLink value={event} /></div>{event.notes && <p className="complete-shift-note"><strong>Notes:</strong> {event.notes}</p>}</> : <p>{step.status === "EXPIRED" ? "Window ended: " : "Scheduled: "}{displayTime(step.status === "EXPIRED" ? step.deadline_at : step.due_at)}{step.deadline_at && step.status !== "EXPIRED" && ` — ${displayTime(step.deadline_at)}`}</p>}
              {step.reason ? <div className="complete-shift-reason"><strong>{step.reason_label}</strong><p>{step.reason}</p>{step.reason_at && <small>Saved: {displayTime(step.reason_at)}</small>}</div> : step.status === "EXPIRED" && <p className="complete-shift-missing-reason">No reason recorded.</p>}
            </div>
          </li>;
        })}</ol>
        {(operation.notes || operation.follow_up) && <section className="complete-shift-office-notes"><h4>Office notes</h4>{operation.notes && <p>{operation.notes}</p>}{operation.follow_up && <p><strong>Follow-up:</strong> {operation.follow_up}</p>}</section>}
      </>}
      {canTrack && <section className="complete-shift-locations"><h4><MapPin size={17} />30-minute location history</h4>{historyError && <p className="error" role="alert">{historyError}</p>}{historyLoading && !history && <p role="status">Loading location updates…</p>}{history && <>
        <p className="muted">{history.tracking.status_label} · Last GPS: {displayTime(history.tracking.last_location_at)} · Last portal contact: {displayTime(history.tracking.last_contact_at)}</p>
        {history.results.length ? <ul className="complete-shift-location-list">{history.results.map((entry) => <li key={entry.id}><div><strong>{locationLabels[entry.status] || entry.status}{entry.source === "BOOK_ON" ? " · Book On" : ""}</strong><span>Received: {displayTime(entry.received_at)}</span>{entry.captured_at && <span>GPS captured: {displayTime(entry.captured_at)}</span>}{entry.accuracy_m != null && <span>Accuracy ±{Math.round(entry.accuracy_m)} m</span>}</div><MapLink value={entry} /></li>)}</ul> : <p className="muted">No automatic location updates recorded for this shift. GPS attached to pictures is shown above.</p>}
        {history.pagination.total_pages > 1 && <nav className="tracking-history-pagination" aria-label="Shift location history pages"><button type="button" className="mini-button" disabled={!history.pagination.has_previous || historyLoading} onClick={() => setPage((value) => value - 1)}>Previous locations</button><span>Page {history.pagination.page} of {history.pagination.total_pages}</span><button type="button" className="mini-button" disabled={!history.pagination.has_next || historyLoading} onClick={() => setPage((value) => value + 1)}>Next locations</button></nav>}
      </>}</section>}
    </div>
    <footer className="complete-shift-footer"><span>Pictures and reasons retain the guard’s recorded evidence.</span><button type="button" className="secondary-button" onClick={onClose}>Close</button></footer>
  </section></div>;
}
