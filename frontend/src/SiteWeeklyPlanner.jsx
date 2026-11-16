import { useEffect, useRef, useState } from "react";
import { CalendarDays, Clock3, LockKeyhole, Search } from "lucide-react";
import { dateLabel, Pages, PlanningDialog } from "./RotaPlanning";
import { shiftPeriod, shiftPreferenceLabels } from "./shiftPreferences";
import "./siteWeeklyPlanner.css";

const shortTime = (value) => value.slice(0, 5);
const shiftTime = (row) => `${shortTime(row.scheduled_start)}–${shortTime(row.scheduled_end)}`;
const shiftText = (row) => row ? `${row.shift_name} · ${shiftTime(row)}` : "Off";
const cellKey = (guard, day) => `${guard.id}:${day}`;

function TimingEditor({ editor, onClose, onApply }) {
  const [start, setStart] = useState(shortTime(editor.row.scheduled_start));
  const [end, setEnd] = useState(shortTime(editor.row.scheduled_end));
  const startInput = useRef(null);
  useEffect(() => { startInput.current?.focus(); }, []);
  return <form className="site-planner-time-editor" onSubmit={(event) => {
    event.preventDefault();
    onApply({ ...editor.row, scheduled_start: start, scheduled_end: end });
  }}>
    <div><strong>{editor.guard.name} · {dateLabel(editor.day)}</strong><small>{editor.row.shift_name}</small></div>
    <div className="form-grid"><label>Start time<input type="time" required ref={startInput} value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>End time<input type="time" required value={end} onChange={(event) => setEnd(event.target.value)} /></label></div>
    <div className="site-planner-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary-button">Apply timing</button></div>
  </form>;
}

function SitePlanPreview({ result, days }) {
  const [filter, setFilter] = useState(result.skipped ? "skipped" : "all");
  const [page, setPage] = useState(0);
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const rows = filter === "skipped" ? result.rows.filter((row) => row.status === "skipped") : result.rows;
  return <>
    <section className="site-planner-review">
      <div className="site-planner-section-heading"><h4 tabIndex={-1} ref={heading}>{result.skipped ? "Current coverage" : "Coverage after saving"}</h4>
        <span className="status-pill pending">{result.coverage.reduce((total, item) => total + item.unfilled, 0)} unfilled</span></div>
      <div className="site-planner-coverage">{days.map((day) => <div key={day}>
        <strong>{dateLabel(day)}</strong>
        {result.coverage.filter((row) => row.work_date === day).map((row) => <div key={row.shift_type} className="site-planner-coverage-slot">
          <span>{row.shift_name}</span>
          <b>{row.assigned}/{row.required}</b>
          <small className={row.unfilled ? "needs-cover" : ""}>{row.unfilled ? `${row.unfilled} unfilled` : row.assigned > row.required ? `${row.assigned - row.required} extra` : "Covered"}</small>
        </div>)}
      </div>)}</div>
    </section>
    <section className="site-planner-review">
      <div className="site-planner-section-heading"><h4>Assignment changes</h4>
        <div className="rota-planning-filters">
          <button type="button" className="secondary-button" aria-pressed={filter === "all"} onClick={() => { setFilter("all"); setPage(0); }}>All {result.rows.length}</button>
          <button type="button" className="secondary-button" aria-pressed={filter === "skipped"} onClick={() => { setFilter("skipped"); setPage(0); }}>Conflicts {result.skipped}</button>
        </div>
      </div>
      {result.skipped > 0 && <p className="error" role="alert">Resolve all conflicts before saving this site plan.</p>}
      <div className="rota-planning-rows">{rows.slice(page * 12, (page + 1) * 12).map((row) =>
        <div className="rota-planning-row" key={row.id}>
          <div><strong>{row.employee_name} · {dateLabel(row.work_date)}</strong>
            <span>{shiftText(row.before)} → {shiftText(row.after)}</span>
            {row.reason && <span>{row.reason}</span>}</div>
          <span className={`status-pill ${row.status === "ready" ? "active" : "pending"}`}>
            {row.status !== "ready" ? "Conflict" : { add: "Add", change: "Change", remove: "Remove" }[row.action]}
          </span>
        </div>)}</div>
      {!rows.length && <p className="muted">{filter === "skipped" ? "No conflicts in this plan." : "No assignment changes."}</p>}
      <Pages count={rows.length} page={page} onChange={setPage} />
    </section>
  </>;
}

export default function SiteWeeklyPlanner({ api, rota, days, sites, shifts, initialSite, onClose, onSaved }) {
  const [site, setSite] = useState(initialSite);
  const [guards, setGuards] = useState(null);
  const [changes, setChanges] = useState({});
  const [search, setSearch] = useState("");
  const [mobileDay, setMobileDay] = useState(days[0]);
  const [editor, setEditor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/rota-weeks/${rota.id}/site-planner/`;
  const pending = Object.values(changes);

  useEffect(() => {
    if (!site) return;
    let active = true;
    api(`${endpoint}?site=${site}`, { silentError: true, silentLoading: true, cache: "no-store" })
      .then((result) => { if (active) setGuards(result.guards); })
      .catch((err) => { if (active) { setError(err.message); setGuards([]); } });
    return () => { active = false; };
  }, [api, endpoint, site, refresh]);

  function reset(nextSite) {
    setSite(nextSite);
    setGuards(null);
    setChanges({});
    setSearch("");
    setEditor(null);
    setPreview(null);
    setError("");
    setRefresh((current) => current + 1);
  }

  function editCell(guard, day, row) {
    const original = guard.days[day];
    const previous = original?.shifts[0];
    const key = cellKey(guard, day);
    setError("");
    setChanges((current) => {
      const next = { ...current };
      if ((!previous && !row) || (previous && row && previous.shift_type === row.shift_type && shiftTime(previous) === shiftTime(row))) {
        delete next[key];
      } else {
        next[key] = { employee: guard.id, work_date: day, revision: original?.revision ?? null,
          shift_type: row?.shift_type ?? null,
          ...(row ? { scheduled_start: row.scheduled_start, scheduled_end: row.scheduled_end } : {}) };
      }
      return next;
    });
  }

  function chooseShift(guard, day, value) {
    const shift = shifts.find((item) => String(item.id) === value);
    editCell(guard, day, shift ? { shift_type: shift.id, scheduled_start: shift.start_time, scheduled_end: shift.end_time } : null);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const result = await api(endpoint, { method: "POST", silentError: true, silentLoading: true,
        silentToast: true, skipInvalidation: !preview,
        body: JSON.stringify({ site, changes: pending, preview: !preview, ...(preview ? { preview_key: preview.preview_key } : {}) }),
      });
      if (preview) onSaved(result, site);
      else setPreview(result);
    } catch (err) {
      if (err.status === 409 && err.payload?.rows) setPreview(err.payload);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = guards?.filter((guard) => `${guard.name} ${guard.employee_id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const canDiscard = () => (!pending.length && !editor) || window.confirm("Discard unsaved changes to this site plan?");

  return <PlanningDialog title="Site Weekly Planner" className="site-weekly-planner" busy={busy}
    onClose={() => { if (canDiscard()) onClose(); }}>
    <div className="rota-planning-form">
      <div className="site-planner-toolbar">
        <div className="form-grid"><label>Site<select value={site} disabled={busy || Boolean(preview)}
          onChange={(event) => { if (canDiscard()) reset(event.target.value); }}>
          <option value="">Select site</option>
          {sites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label></div>
        <span className="site-planner-week"><CalendarDays size={16} />{dateLabel(days[0])} – {dateLabel(days[6])}</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {preview ? <SitePlanPreview key={preview.preview_key} result={preview} days={days} />
        : <>
          {!site && <p className="muted">Select a site to load its inducted guards.</p>}
          {site && !guards && <p role="status" className="muted">Loading inducted guards…</p>}
          {site && guards && !guards.length && (error
            ? <button type="button" className="secondary-button" onClick={() => reset(site)}>Retry loading site</button>
            : <p className="muted">This site has no active guards with a completed induction.</p>)}
          {guards?.length > 0 && <>
            <div className="site-planner-list-heading">
              <label className="search-box"><Search size={16} /><input aria-label="Search guards" placeholder="Search guard name or ID"
                value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              <span className="muted">{shown.length} of {guards.length} guards</span>
            </div>
            {editor && <TimingEditor key={cellKey(editor.guard, editor.day)} editor={editor}
              onApply={(row) => { editCell(editor.guard, editor.day, row); setEditor(null); }}
              onClose={() => setEditor(null)} />}
            <div className="site-planner-mobile-day form-grid"><label>Day<select value={mobileDay} onChange={(event) => setMobileDay(event.target.value)}>
              {days.map((day) => <option key={day} value={day}>{dateLabel(day)}</option>)}
            </select></label></div>
            <div className="site-planner-grid" role="region" aria-label="Weekly guard schedule" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">Guard</th>{days.map((day) =>
                  <th scope="col" key={day} data-mobile-day={day === mobileDay}>{dateLabel(day)}</th>)}</tr></thead>
                <tbody>{shown.map((guard) => <tr key={guard.id}>
                  <th scope="row"><strong>{guard.name}</strong><small>{guard.employee_id}{guard.shift_preference ? ` · ${shiftPreferenceLabels[guard.shift_preference]}` : ""}</small></th>
                  {days.map((day) => {
                    const original = guard.days[day];
                    const change = changes[cellKey(guard, day)];
                    const row = change ? (change.shift_type ? change : null) : original?.shifts[0];
                    const shift = shifts.find((item) => item.id === row?.shift_type);
                    const label = `${guard.name} · ${dateLabel(day)}`;
                    return <td key={day} data-mobile-day={day === mobileDay}>
                      {original?.locked_reason ? <div className="site-planner-locked">
                        <strong><LockKeyhole size={13} /> {original.shifts.map((item) => item.shift_name).join(", ")}</strong>
                        <small>{original.locked_reason}</small>
                      </div> : <div className="site-planner-cell" data-shift={shift ? shiftPeriod(shift) : undefined} data-changed={Boolean(change)}>
                        <select aria-label={`Shift for ${label}`} value={row?.shift_type || ""} disabled={busy || Boolean(editor)}
                          onChange={(event) => chooseShift(guard, day, event.target.value)}>
                          <option value="">Off</option>
                          {shifts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                        {row && <button type="button" className="text-button" disabled={busy || Boolean(editor)} aria-label={`Edit timing for ${label}`}
                          onClick={() => setEditor({ guard, day, row: { ...row, shift_name: shift?.name || row.shift_name } })}>
                          <Clock3 size={12} />{shiftTime(row)}</button>}
                      </div>}
                    </td>;
                  })}
                </tr>)}</tbody>
              </table>
              {!shown.length && <p className="muted">No guards match your search.</p>}
            </div>
          </>}
        </>}
      <footer className="modal-actions site-planner-footer">
        <span className="muted" role="status">{pending.length} {pending.length === 1 ? "change" : "changes"} selected</span>
        <div className="site-planner-actions">
          {preview?.stale && <button type="button" className="secondary-button" disabled={busy}
            onClick={() => { if (canDiscard()) reset(site); }}>Reload site</button>}
          <button type="button" className="secondary-button" disabled={busy}
            onClick={() => { if (preview) { setPreview(null); setError(""); } else if (canDiscard()) onClose(); }}>
            {preview ? "Back to planner" : "Cancel"}
          </button>
          <button type="button" className="primary-button" onClick={submit}
            disabled={busy || Boolean(editor) || (preview ? !preview.ready || Boolean(preview.skipped) : !pending.length)}>
            {busy ? "Working…" : preview ? "Save draft" : "Preview"}
          </button>
        </div>
      </footer>
    </div>
  </PlanningDialog>;
}
