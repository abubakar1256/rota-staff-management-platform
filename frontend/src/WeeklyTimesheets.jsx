import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import CheckUpdatesButton from "./CheckUpdatesButton";
import TimesheetReview from "./TimesheetReview";
import { addDays, toMonday, ukDate } from "./ukTime";
import { actualTimes, formatTimesheetDuration as duration, timesheetSeconds, weeklyTimesheetTotals } from "./timesheetHours";
import "./weeklyTimesheets.css";

const weekDay = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const dayLabel = (date) => weekDay.format(new Date(`${date}T12:00:00Z`));
const rangeLabel = (value) => value ? `${dayLabel(value.slice(0, 10))}, ${value.slice(11, 16)}` : "—";
const formatClock = (time) => time?.slice(0, 5) || "—";

function ShiftEntries({ entries, onReview, onEdit, canEdit }) {
  return <div className="weekly-shift-entries table-wrap">
    <table>
      <thead><tr><th>Shift date</th><th>Scheduled</th><th>Actual time (UK)</th><th>Hours</th><th>Overtime</th><th>Review</th><th>Actions</th></tr></thead>
      <tbody>{entries.map((sheet) => {
        const times = actualTimes(sheet);
        const hours = timesheetSeconds(sheet);
        return <tr key={sheet.id}>
          <td>{dayLabel(sheet.work_date)}</td>
          <td>{formatClock(sheet.scheduled_start)} – {formatClock(sheet.scheduled_end)}</td>
          <td>
            {times.start && times.end ? `${rangeLabel(times.start)} – ${rangeLabel(times.end)}` : "—"}
            {sheet.corrected_start_at && <small className="table-subtext">Corrected</small>}
          </td>
          <td>{duration(hours.actual)}</td>
          <td>{duration(hours.overtime)}</td>
          <td><span className={`status-pill ${sheet.approved ? "active" : "pending"}`}>{sheet.approved ? "Approved" : sheet.review_flags?.length ? "Review required" : "Draft"}</span></td>
          <td><div className="row-actions">
            <button type="button" className="mini-button" onClick={() => onReview(sheet)}>{sheet.approved ? "View record" : "Review"}</button>
            {canEdit && <button type="button" className="mini-button" onClick={() => onEdit(sheet)}><Pencil size={13} /> Edit hours</button>}
          </div></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function GuardHours({ guards, onReview, onEdit, canEdit }) {
  const [expanded, setExpanded] = useState(null);
  return <div className="table-wrap">
    <table className="weekly-guard-hours">
      <thead><tr><th>Guard</th><th>Days worked</th><th>Actual hours</th><th>Overtime</th><th>Total hours</th>{onReview && <th>Shifts</th>}</tr></thead>
      <tbody>{guards.map((guard) => {
        const open = expanded === guard.id;
        return <Fragment key={guard.id}>
          <tr>
            <td><strong>{guard.name}</strong></td><td>{guard.days.size}</td><td>{duration(guard.actual)}</td>
            <td>{duration(guard.overtime)}</td><td><strong>{duration(guard.total)}</strong></td>
            {onReview && <td><button type="button" className="mini-button" aria-expanded={open}
              onClick={() => setExpanded(open ? null : guard.id)}>
              {open ? "Hide shifts" : "View shifts"} <ChevronDown size={14} />
            </button></td>}
          </tr>
          {onReview && open && <tr><td colSpan={6} className="weekly-shift-cell">
            <ShiftEntries entries={guard.entries} onReview={onReview} onEdit={onEdit} canEdit={canEdit} />
          </td></tr>}
        </Fragment>;
      })}</tbody>
    </table>
  </div>;
}

function TimesheetEditor({ sheet, api, sites, employees, siteFilter, defaultDay, onClose, onSaved }) {
  const titleId = useId();
  const dialog = useRef(null);
  const times = sheet ? actualTimes(sheet) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current.showModal(); }, []);

  async function submit(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const { corrected_start_at: start, corrected_end_at: end, overtime_minutes, notes, ...create } = form;
    let payload = { overtime_minutes: Number(overtime_minutes), notes };
    if (sheet) {
      payload.original_updated_at = sheet.updated_at;
      if (start !== times.start || end !== times.end) {
        if (!start || !end) { setError("Enter both actual start and end date and time."); return; }
        payload.corrected_start_at = start === times.start && times.startAt ? times.startAt : start;
        payload.corrected_end_at = end === times.end && times.endAt ? times.endAt : end;
      }
    } else {
      payload = {
        ...create, ...payload, employee: Number(create.employee), site: create.site ? Number(create.site) : null,
        actual_start: create.actual_start || null, actual_end: create.actual_end || null,
        scheduled_start: create.scheduled_start || null, scheduled_end: create.scheduled_end || null,
      };
    }
    setSaving(true); setError("");
    try {
      const result = await api(sheet ? `/timesheets/${sheet.id}/correct-hours/` : "/timesheets/", {
        method: sheet ? "PATCH" : "POST", body: JSON.stringify(payload), silentLoading: true, silentError: true,
      });
      onSaved(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return <dialog ref={dialog} className="modal-card weekly-hours-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="modal-header">
      <div><h3 id={titleId}>{sheet ? "Edit timesheet hours" : "Add timesheet"}</h3>
        {sheet && <p className="muted">{sheet.employee_name} · {sheet.site_name || "Unassigned site"} · {dayLabel(sheet.work_date)}</p>}</div>
      <button type="button" className="icon-button" aria-label="Close timesheet editor" disabled={saving} onClick={onClose}><X size={19} /></button>
    </div>
    <form onSubmit={submit}>
      <fieldset className="form-grid weekly-hours-fields" disabled={saving}>
        {sheet ? <>
          <label>Actual start (UK)<input type="datetime-local" name="corrected_start_at" defaultValue={times.start} /></label>
          <label>Actual end (UK)<input type="datetime-local" name="corrected_end_at" defaultValue={times.end} /></label>
        </> : <>
          <label>Guard<select name="employee" required defaultValue=""><option value="">Select guard</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select></label>
          <label>Site<select name="site" defaultValue={siteFilter === "all" || siteFilter === "unassigned" ? "" : siteFilter}>
            <option value="">Unassigned site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select></label>
          <label>Shift date<input type="date" name="work_date" defaultValue={defaultDay} required /></label>
          <label>Scheduled start (UK)<input type="time" name="scheduled_start" defaultValue="07:00" /></label>
          <label>Scheduled end (UK)<input type="time" name="scheduled_end" defaultValue="19:00" /></label>
          <label>Actual start (UK)<input type="time" name="actual_start" /></label>
          <label>Actual end (UK)<input type="time" name="actual_end" /></label>
        </>}
        <label>Additional overtime (minutes)<input type="number" name="overtime_minutes" min="0" max="2147483647" step="1" defaultValue={sheet?.overtime_minutes || 0} required />
          <small className="muted">Minutes added to the actual hours.</small>
        </label>
        <label className="full-width">Notes<textarea name="notes" rows={2} maxLength={250} defaultValue={sheet?.notes || ""} /></label>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save timesheet"}</button>
      </div>
    </form>
  </dialog>;
}

export default function WeeklyTimesheets({ api, FilePreview, canApprove, initialTimesheetId }) {
  const [week, setWeek] = useState(() => toMonday(ukDate()));
  const [siteFilter, setSiteFilter] = useState("all");
  const [reviewing, setReviewing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  const weekEnd = addDays(week, 6);
  const path = `/timesheets/?start_date=${week}&end_date=${weekEnd}`;
  const queryKey = ["rota", "timesheets", week];
  const read = (url, signal) => api(url, { signal, cache: "no-store", silentLoading: true, silentError: true });
  const entriesQuery = useQuery({ queryKey, queryFn: ({ signal }) => read(path, signal) });
  const sitesQuery = useQuery({ queryKey: ["rota", "sites", "timesheets"], queryFn: ({ signal }) => read("/sites/", signal) });
  const guardsQuery = useQuery({
    queryKey: ["rota", "employees", "timesheets"], queryFn: ({ signal }) => read("/employees/", signal),
    enabled: editing === "new",
  });
  const entries = entriesQuery.data || [];
  const sites = new Map((sitesQuery.data || []).map((site) => [String(site.id), site.name]));
  for (const sheet of entries) sites.set(String(sheet.site ?? "unassigned"), sheet.site_name || "Unassigned site");
  if (siteFilter === "unassigned") sites.set("unassigned", "Unassigned site");
  const visible = siteFilter === "all" ? entries : entries.filter((sheet) => String(sheet.site ?? "unassigned") === siteFilter);
  const report = weeklyTimesheetTotals(visible);

  useEffect(() => {
    if (!initialTimesheetId) return undefined;
    const request = new AbortController();
    read(`/timesheets/${initialTimesheetId}/`, request.signal).then((sheet) => {
      if (request.signal.aborted) return;
      setWeek(toMonday(sheet.work_date));
      setSiteFilter("all");
      setReviewing(sheet);
    }).catch((err) => { if (!request.signal.aborted) setError(err.message); });
    return () => request.abort();
  }, [initialTimesheetId]);

  function saved(sheet) {
    const sheetWeek = toMonday(sheet.work_date);
    const key = ["rota", "timesheets", sheetWeek];
    queryClient.setQueryData(key, (current) => current?.some((row) => row.id === sheet.id)
      ? current.map((row) => row.id === sheet.id ? sheet : row) : [...(current || []), sheet]);
    void queryClient.invalidateQueries({ queryKey: key });
    setWeek(sheetWeek);
    if (siteFilter !== "all" && siteFilter !== String(sheet.site ?? "unassigned")) setSiteFilter(String(sheet.site ?? "unassigned"));
  }

  const queryError = entriesQuery.error || sitesQuery.error || (editing === "new" && guardsQuery.error);
  return <>
    <div className="page-heading">
      <div><p className="eyebrow">WORKING HOURS</p><h2>Weekly timesheets</h2><p className="muted">Weekly totals include draft and approved timesheets.</p></div>
      {canApprove && <button className="primary-button" onClick={() => setEditing("new")}>Add timesheet</button>}
    </div>
    <section className="panel weekly-hours-controls">
      <div className="weekly-week-picker">
        <button type="button" className="secondary-button" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft size={16} /></button>
        <label>Week starting<input type="date" value={week} onChange={(event) => { if (event.target.value) setWeek(toMonday(event.target.value)); }} /></label>
        <button type="button" className="secondary-button" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}><ChevronRight size={16} /></button>
        <button type="button" className="secondary-button" onClick={() => setWeek(toMonday(ukDate()))}>This week</button>
      </div>
      <div className="weekly-site-picker">
        <label>Site<select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}>
          <option value="all">All sites</option>
          {[...sites].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <CheckUpdatesButton api={api} paths={path} currentData={entries} onUpdate={(data) => { queryClient.setQueryData(queryKey, data); }} setError={setError} disabled={entriesQuery.isPending} />
      </div>
      <p className="muted">{dayLabel(week)} – {dayLabel(weekEnd)} · UK time</p>
    </section>
    {(error || queryError) && <p className="error page-error" role="alert">{error || queryError.message}</p>}
    {entriesQuery.isPending ? <p className="muted" role="status">Loading weekly timesheets…</p> : report.sites.length ? <>
      <div className="weekly-hours-totals">
        <div className="panel"><span>Actual hours</span><strong>{duration(report.total.actual)}</strong></div>
        <div className="panel"><span>Overtime</span><strong>{duration(report.total.overtime)}</strong></div>
        <div className="panel weekly-hours-total"><span>Total hours</span><strong>{duration(report.total.total)}</strong></div>
      </div>
      {report.sites.length > 1 && <section className="panel weekly-hours-site">
        <h3>Guard totals across sites</h3>
        <GuardHours guards={report.guards} />
      </section>}
      {report.sites.map((site) => <section key={site.id} className="panel weekly-hours-site">
        <div className="panel-header"><h3>{site.name}</h3><span className="status-pill active">{duration(site.total)} total</span></div>
        <GuardHours key={week} guards={site.guards} onReview={setReviewing} onEdit={setEditing} canEdit={canApprove} />
      </section>)}
    </> : !entriesQuery.error && <section className="panel empty-state"><strong>No timesheets for this week and site</strong></section>}
    {editing && <TimesheetEditor sheet={editing === "new" ? null : editing} api={api} sites={sitesQuery.data || []} employees={guardsQuery.data || []}
      defaultDay={toMonday(ukDate()) === week ? ukDate() : week} siteFilter={siteFilter}
      onClose={() => setEditing(null)} onSaved={(sheet) => { saved(sheet); setEditing(null); }} />}
    {reviewing && <TimesheetReview sheet={reviewing} api={api} FilePreview={FilePreview} canApprove={canApprove}
      onClose={() => setReviewing(null)} onApproved={(sheet) => { saved(sheet); setReviewing(sheet); }} />}
  </>;
}
