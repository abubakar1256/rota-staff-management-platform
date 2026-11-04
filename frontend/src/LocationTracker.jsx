import { useEffect, useState } from "react";
import { MapPin, History, X, ExternalLink } from "lucide-react";
import "./locationTracking.css";

export function ukTrackingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
const formatTime = (value) => value ? new Date(value).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }) : "Not received";
const statusLabel = { UPDATED: "Updated", PERMISSION_DENIED: "Permission denied", UNAVAILABLE: "Location unavailable", TIMEOUT: "Location timed out" };
const mapUrl = (point) => `https://www.openstreetmap.org/?mlat=${encodeURIComponent(point.latitude)}&mlon=${encodeURIComponent(point.longitude)}#map=17/${encodeURIComponent(point.latitude)}/${encodeURIComponent(point.longitude)}`;
function MapLink({ point }) { return point && <a className="mini-button" href={mapUrl(point)} target="_blank" rel="noopener noreferrer"><MapPin size={14} />Map<ExternalLink size={12} /></a>; }

export default function LocationTracker({ api, target = {} }) {
  const [date, setDate] = useState(target.event_date || ukTrackingDate());
  const [items, setItems] = useState([]), [site, setSite] = useState(target.site_id ? String(target.site_id) : "ALL"), [search, setSearch] = useState("");
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null), [history, setHistory] = useState(null), [historyPage, setHistoryPage] = useState(1);
  const [historyError, setHistoryError] = useState(""), [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async (initial = false) => {
      if (initial) setLoading(true);
      try { const data = await api(`/location-tracking/tracker/?date=${date}`, { silentLoading: true, silentError: true }); if (active) { setItems(data.results); setError(""); } }
      catch (err) { if (active) setError(err.message); } finally { if (active) setLoading(false); }
    };
    load(true); const timer = window.setInterval(() => load(), 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, [date, api]);
  const manualLoad = async () => { setLoading(true); try { const data = await api(`/location-tracking/tracker/?date=${date}`, { silentLoading: true }); setItems(data.results); setError(""); } catch (err) { setError(err.message); } finally { setLoading(false); } };
  useEffect(() => {
    if (!target.operation_id) return;
    setSelected(target.operation_id); setHistoryPage(1);
  }, [target.operation_id]);
  useEffect(() => {
    if (!selected) { setHistory(null); return; }
    let active = true; setHistoryLoading(true); setHistoryError(""); setHistory(null);
    api(`/location-tracking/${selected}/history/?page=${historyPage}`, { silentLoading: true, silentError: true }).then((data) => { if (active) setHistory(data); }).catch((err) => { if (active) setHistoryError(err.message); }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [selected, historyPage, api]);
  const visible = items.filter((item) => (site === "ALL" || String(item.site_id) === site) && `${item.employee_name} ${item.site_name}`.toLowerCase().includes(search.toLowerCase()));
  const sites = [...new Map(items.map((item) => [item.site_id, item.site_name])).entries()];
  return <div className="duty-tracker"><div className="page-heading"><div><p className="eyebrow">CONTROL ROOM</p><h2>Location tracker</h2><p className="muted">Duty location evidence · 30-minute updates · Times shown in Europe/London.</p></div><div className="report-filters"><input aria-label="Location tracking date" type="date" value={date} onChange={(event) => setDate(event.target.value)} /><button className="secondary-button" disabled={loading} onClick={manualLoad}>{loading ? "Checking…" : "Check updates"}</button></div></div>
    <div className="tracking-summary"><span><strong>{items.filter((item) => item.tracking_active).length}</strong>Tracking active</span><span><strong>{items.filter((item) => item.tracking_active && (item.overdue || ["PERMISSION_DENIED", "UNAVAILABLE", "TIMEOUT"].includes(item.status))).length}</strong>Need attention</span><span><strong>{items.filter((item) => item.status === "STOPPED").length}</strong>Tracking ended</span></div>
    {error && <p className="error" role="alert">{error}</p>}<section className="panel"><div className="attendance-filter-row"><input aria-label="Search location tracker" placeholder="Search guard or site…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Location tracker site" value={site} onChange={(event) => setSite(event.target.value)}><option value="ALL">All sites</option>{sites.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
      <div className="tracking-guard-grid">{visible.map((item) => <article className={`tracking-guard-card${item.overdue || ["PERMISSION_DENIED", "UNAVAILABLE", "TIMEOUT"].includes(item.status) ? " has-issue" : ""}`} key={item.operation_id}><div className="tracking-card-heading"><div><h3>{item.employee_name}</h3><p>{item.site_name}</p><small>{item.operation_date} · {item.shift_name}</small></div><span className={`status-pill ${item.status === "UPDATED" ? "active" : item.status === "STOPPED" ? "neutral" : "pending"}`}>{item.status_label}</span></div><dl><div><dt>Last location</dt><dd>{formatTime(item.last_location_at)}</dd></div><div><dt>Accuracy</dt><dd>{item.point?.accuracy_m != null ? `±${Math.round(item.point.accuracy_m)} m` : "Unavailable"}</dd></div><div><dt>Last portal contact</dt><dd>{formatTime(item.last_contact_at)}</dd></div></dl>{item.overdue && item.status !== "OVERDUE" && <p className="tracking-warning">Fresh location update is also overdue.</p>}<div className="row-actions"><MapLink point={item.point} /><button className="mini-button" onClick={() => { setSelected(item.operation_id); setHistoryPage(1); }}><History size={14} />View history</button></div><small className="tracking-evidence-note">{item.point ? "Map shows the last recorded position, not continuous live movement." : "No location recorded yet."}</small></article>)}</div>
      {!visible.length && <div className="empty-state"><MapPin size={28} /><strong>{loading ? "Loading tracking sessions…" : "No matching tracking sessions"}</strong><span>Enable 30-minute location tracking in Sites. Tracking begins after Book On.</span></div>}</section>
    <p className="muted tracking-footnote">Overdue means no fresh location for 35 minutes. Browser suspension, connectivity or GPS problems can delay updates.</p>
    {selected && <div className="modal-backdrop"><section className="modal-card tracking-history-modal" role="dialog" aria-modal="true" aria-labelledby="tracking-history-title"><div className="modal-header"><div><p className="eyebrow">DUTY LOCATION EVIDENCE</p><h3 id="tracking-history-title">{history?.tracking.employee_name || "Location history"}</h3><p className="muted">{history?.tracking.site_name} · Europe/London</p></div><button className="icon-button" aria-label="Close location history" onClick={() => setSelected(null)}><X size={20} /></button></div>{historyError && <p className="error">{historyError}</p>}{historyLoading && <p>Loading history…</p>}{history && <><div className="table-wrap"><table><thead><tr><th>Received time</th><th>Status</th><th>Accuracy</th><th>Location</th></tr></thead><tbody>{history.results.map((item) => <tr key={item.id}><td>{formatTime(item.received_at)}{item.source === "BOOK_ON" && <small className="table-subtext">Book On</small>}</td><td>{statusLabel[item.status] || item.status}</td><td>{item.accuracy_m != null ? `±${Math.round(item.accuracy_m)} m` : "—"}</td><td><MapLink point={item.latitude != null ? item : null} /></td></tr>)}{!history.results.length && <tr><td colSpan={4}>No location updates recorded.</td></tr>}</tbody></table></div><div className="tracking-history-pagination"><button className="secondary-button" disabled={!history.pagination.has_previous || historyLoading} onClick={() => setHistoryPage(historyPage - 1)}>Previous</button><span>Page {history.pagination.page} of {history.pagination.total_pages}</span><button className="secondary-button" disabled={!history.pagination.has_next || historyLoading} onClick={() => setHistoryPage(historyPage + 1)}>Next</button></div></>}</section></div>}
  </div>;
}
