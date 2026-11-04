import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardList, Clock3, History, Search, Users, X } from "lucide-react";
import CheckUpdatesButton from "./CheckUpdatesButton";
import CompleteShiftReview from "./CompleteShiftReview";
import { operationSummary } from "./operationSummary.js";
import { ukDate, formatUkDateTime } from "./ukTime.js";
import "./dailyOperations.css";

const empty = { site: "", shift_type: "", employee: "", status: "UNCONFIRMED", notes: "", follow_up: "" };
const labels = { REACHED: "Reached", LATE: "Late", NOT_REACHED: "Not reached", UPCOMING: "Upcoming" };
export default function DailyOperationsPage({ api, StatCard, FilePreview, notify, canEdit = true, canTrack = true }) {
  const [date, setDate] = useState(ukDate()), [data, setData] = useState(null), [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]), [sites, setSites] = useState([]), [shifts, setShifts] = useState([]);
  const [search, setSearch] = useState(""), [site, setSite] = useState("ALL"), [open, setOpen] = useState(false), [form, setForm] = useState(empty);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [saving, setSaving] = useState(false), [marking, setMarking] = useState(null), [selected, setSelected] = useState(null);
  const currentDate = useRef(date), mounted = useRef(true);
  currentDate.current = date;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const path = `/operations/?operation_date=${date}&view=operations`;
  const load = async () => {
    const requestedDate = date;
    if (!date) { setData(null); setLoading(false); return; }
    setLoading(true); setError("");
    try { const result = await api(path, { silentLoading: true, silentError: true }); if (mounted.current && currentDate.current === requestedDate) setData(result); }
    catch (err) { if (mounted.current && currentDate.current === requestedDate) setError(err.message); }
    finally { if (mounted.current && currentDate.current === requestedDate) setLoading(false); }
  };
  useEffect(() => { setData(null); setNotice(""); load(); }, [date]);
  useEffect(() => {
    if (!canEdit) return;
    let active = true;
    Promise.all([api("/employees/?status=ACTIVE", { silentLoading: true }), api("/sites/", { silentLoading: true }), api("/shift-types/", { silentLoading: true })])
      .then(([people, locations, types]) => { if (active) { setEmployees(people); setSites(locations); setShifts(types); } })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [api, canEdit]);
  const summary = operationSummary(data);
  const rows = summary.assigned.filter((item) => (site === "ALL" || String(item.site) === site) && `${item.employee_name} ${item.site_name} ${item.shift_name}`.toLowerCase().includes(search.trim().toLowerCase()));
  const siteChoices = [...new Map([...summary.assigned, ...summary.unfilled].map((item) => [String(item.site), item.site_name])).entries()];
  const chooseAssignment = (field, value) => {
    const next = { ...form, [field]: value };
    const existing = summary.assigned.find((item) => String(item.site) === next.site && String(item.shift_type) === next.shift_type && String(item.employee) === next.employee);
    setForm({ ...next, notes: existing?.notes || "", follow_up: existing?.follow_up || "", status: existing?.status || "UNCONFIRMED" });
  };
  const showError = (message) => { setError(message); notify?.(message, "error"); };
  const markReached = async (item) => {
    setMarking(item.id); setError(""); setNotice("");
    try { await api(`/operations/${item.id}/mark-reached/`, { method: "POST", body: "{}", silentError: true, silentToast: true }); await load(); notify?.("Arrival recorded. The original timestamp will be retained."); }
    catch (err) { showError(err.message); } finally { if (mounted.current) setMarking(null); }
  };
  const save = async (event) => {
    event.preventDefault(); setError("");
    if (form.status === "PRESENT" && (!form.employee || date > ukDate())) { showError("To mark Present, select an assigned guard on today’s date or an earlier date."); return; }
    setSaving(true);
    const existing = form.employee && summary.assigned.find((item) => String(item.site) === form.site && String(item.shift_type) === form.shift_type && String(item.employee) === form.employee);
    const values = { status: form.status === "PRESENT" && !existing?.reached_at ? "UNCONFIRMED" : form.status, notes: form.notes, follow_up: form.follow_up };
    try {
      const result = await api(existing ? `/operations/${existing.id}/` : "/operations/", { method: existing ? "PATCH" : "POST",
        body: JSON.stringify(existing ? values : { ...values, operation_date: date, site: Number(form.site), shift_type: Number(form.shift_type), employee: form.employee ? Number(form.employee) : null }), silentToast: true, silentError: true });
      if (form.status === "PRESENT" && !result.reached_at) await api(`/operations/${result.id}/mark-reached/`, { method: "POST", body: "{}", silentError: true, silentToast: true });
      if (mounted.current) { setOpen(false); setForm(empty); setNotice(existing ? "Existing shift updated. No duplicate guard record was created." : "Operations update saved."); await load(); notify?.("Operations update saved."); }
    } catch (err) { if (mounted.current) { await load(); showError(err.message); } }
    finally { if (mounted.current) setSaving(false); }
  };
  return <>
    <div className="page-heading"><div><p className="eyebrow">DAILY OPERATIONS</p><h2>{date === ukDate() ? "Today’s operations" : "Daily operations"}</h2><p className="muted">Assigned guard arrivals and current staffing gaps · Europe/London (GMT/BST).</p></div><div className="report-filters"><input type="date" aria-label="Operations date" value={date} disabled={open || saving || marking != null} onChange={(event) => { setSelected(null); setDate(event.target.value); }} /><CheckUpdatesButton api={api} paths={path} currentData={data} onUpdate={setData} setError={setError} disabled={!date || loading || open || saving || marking != null} />{canEdit && <button type="button" className="primary-button" disabled={!date || loading || saving} onClick={() => { setForm(empty); setOpen(true); }}>Add update</button>}</div></div>
    {error && <p className="error page-error" role="alert">{error}</p>}{notice && <p className="success page-success">{notice}</p>}{loading && <p className="muted" role="status">Loading operations…</p>}
    <section className="stats-grid"><StatCard label="Assigned guards" value={loading && !data ? "—" : summary.assigned.length} detail="Guard shifts on selected date" icon={Users} tone="blue" /><StatCard label="Reached site" value={loading && !data ? "—" : summary.reached} detail={`${summary.late} late arrivals included`} icon={CheckCircle2} tone="teal" /><StatCard label="Awaiting arrival" value={loading && !data ? "—" : summary.pending} detail={`${summary.upcoming} upcoming shifts excluded`} icon={Clock3} tone="amber" /><StatCard label="Unfilled positions" value={loading && !data ? "—" : summary.unfilledCount} detail="Current requirements for this date" icon={ClipboardList} tone="rose" /></section>
    <section className="panel operations-log"><div className="panel-header"><div><h3>Site arrival log</h3><p className="muted">{date} · Assigned guards only. Recorded arrival times are retained.</p></div><span className="muted">{summary.assigned.length} guard record{summary.assigned.length === 1 ? "" : "s"}</span></div><div className="attendance-filter-row"><div className="search-box"><Search size={15} /><input aria-label="Search operations" value={search} placeholder="Search guard, site or shift…" onChange={(event) => setSearch(event.target.value)} /></div><select aria-label="Operations site" value={site} onChange={(event) => setSite(event.target.value)}><option value="ALL">All sites</option>{siteChoices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
      {rows.length ? <div className="table-wrap"><table><thead><tr><th>Site / shift</th><th>Employee</th><th>Scheduled</th><th>Reached at (UK)</th><th>Delay</th><th>Status</th><th>Action</th></tr></thead><tbody>{rows.map((item) => <tr key={item.id}><td data-label="Site / shift"><strong>{item.site_name}</strong><small className="table-subtext">{item.shift_name}</small></td><td data-label="Employee"><strong>{item.employee_name}</strong>{item.notes && <small className="table-subtext operations-text">{item.notes}</small>}{item.follow_up && <small className="table-subtext operations-text">Follow-up: {item.follow_up}</small>}</td><td data-label="Scheduled">{item.scheduled_start?.slice(0, 5) || "—"}</td><td data-label="Reached at (UK)">{formatUkDateTime(item.reached_at)}{item.reached_by_name && <small className="table-subtext">Recorded by {item.reached_by_name}</small>}</td><td data-label="Delay">{item.delay_minutes == null ? "—" : item.delay_minutes ? `${item.delay_minutes} min` : "On time"}</td><td data-label="Status"><span className={`status-pill ${item.arrival_status === "UPCOMING" ? "neutral" : (item.arrival_status || "NOT_REACHED").toLowerCase()}`}>{labels[item.arrival_status] || "Not reached"}</span>{item.status === "ABSENT" && <small className="table-subtext">Office status: Absent</small>}</td><td data-label="Action"><div className="operations-row-actions">{!item.reached_at && item.attendance_status !== "BOOKED_OFF" && item.operation_date <= ukDate() && <button type="button" className="mini-button approve" disabled={marking != null} onClick={() => markReached(item)}><CheckCircle2 size={13} />{marking === item.id ? "Saving…" : "Mark reached"}</button>}<button type="button" className="mini-button" onClick={() => setSelected(item.id)}><History size={13} />View complete shift</button></div></td></tr>)}</tbody></table></div> : <div className="empty-state"><ClipboardList size={28} /><strong>{summary.assigned.length ? "No matching guards" : "No guards assigned for this date"}</strong><span>{summary.assigned.length ? "Try another guard or site." : "Assign guards from Weekly Rota or add an operations update."}</span></div>}
    </section>
    {summary.unfilledCount > 0 && <details className="panel arrival-unfilled-panel operations-gaps"><summary>{summary.unfilledCount} unfilled position{summary.unfilledCount === 1 ? "" : "s"} on {date} <span>View staffing gaps</span></summary><div className="arrival-unfilled-list">{summary.unfilled.map((item) => <div key={item.id}><div><strong>{item.site_name}</strong><span>{item.shift_name} · {item.scheduled_start?.slice(0, 5)}</span></div><span className="status-pill pending">{item.count} needed</span></div>)}</div></details>}
    {summary.notes.length > 0 && <section className="panel operations-unassigned-notes"><h3>Unassigned operations notes</h3><p className="muted">Saved office notes. These are not counted as assigned guards.</p>{summary.notes.map((item) => <article key={item.id}><strong>{item.site_name} · {item.shift_name}</strong>{item.notes && <p>{item.notes}</p>}{item.follow_up && <p>Follow-up: {item.follow_up}</p>}</article>)}</section>}
    {open && <div className="modal-backdrop"><form className="modal-card" role="dialog" aria-modal="true" aria-label="Daily operations update" onSubmit={save}><div className="modal-header"><div><p className="eyebrow">OPERATIONS UPDATE</p><h3>Daily operations update</h3><p className="muted">{date} · Existing guard shifts will be updated.</p></div><button type="button" className="icon-button" aria-label="Close operations update" disabled={saving} onClick={() => setOpen(false)}><X size={19} /></button></div><fieldset className="form-grid operations-form-fields" disabled={saving}><label>Site<select required value={form.site} onChange={(event) => chooseAssignment("site", event.target.value)}><option value="">Select site</option>{sites.filter((item) => item.is_active !== false).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Shift<select required value={form.shift_type} onChange={(event) => chooseAssignment("shift_type", event.target.value)}><option value="">Select shift</option>{shifts.filter((item) => item.is_active !== false).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Employee<select value={form.employee} onChange={(event) => chooseAssignment("employee", event.target.value)}><option value="">Unassigned</option>{employees.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="UNCONFIRMED">Unconfirmed</option><option value="PRESENT">Present — record arrival</option><option value="ABSENT">Absent</option><option value="REPLACEMENT_NEEDED">Replacement needed</option></select></label><label className="full-width">Notes<textarea rows="2" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label className="full-width">Follow-up<input value={form.follow_up} onChange={(event) => setForm({ ...form, follow_up: event.target.value })} /></label></fieldset>{error && <p className="error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save update"}</button></div></form></div>}
    {selected && <CompleteShiftReview key={selected} operationId={selected} api={api} FilePreview={FilePreview} canTrack={canTrack} onClose={() => setSelected(null)} />}
  </>;
}
