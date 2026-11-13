import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Copy, Search, Users, X } from "lucide-react";
import "./rotaPlanning.css";

const dayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dateLabel = (date) => dayFormat.format(new Date(`${date}T12:00:00Z`));
const time = (value) => value?.slice(0, 5) || "";
const pageSize = 12;

function PlanningDialog({ title, onClose, busy, children }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog className="rota-planning-dialog" ref={dialog} aria-labelledby="rota-planning-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="modal-header">
      <h3 id="rota-planning-title">{title}</h3>
      <button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={19} /></button>
    </header>
    {children}
  </dialog>;
}

function Pages({ page, count, onChange }) {
  const pages = Math.ceil(count / pageSize);
  if (pages < 2) return null;
  return <nav className="rota-planning-pagination" aria-label="Result pages">
    <button type="button" className="secondary-button" aria-label="Previous page" disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={15} /></button>
    <span>Page {page + 1} of {pages}</span>
    <button type="button" className="secondary-button" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={15} /></button>
  </nav>;
}

export function NeedsCover({ gaps, onSelect, published }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const matching = gaps.filter(({ site, shift, day }) =>
    `${site.name} ${site.site_id} ${shift.name} ${dateLabel(day)}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const current = Math.min(page, Math.max(0, Math.ceil(matching.length / pageSize) - 1));
  return <section className="rota-cover-queue" aria-label="Needs cover">
    <label className="search-box"><Search size={16} aria-hidden="true" /><input aria-label="Filter cover needed" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search site, day or shift" /></label>
    <div className="rota-planning-rows">
      {matching.slice(current * pageSize, (current + 1) * pageSize).map((slot) =>
        <article className="rota-planning-row" key={`${slot.site.id}-${slot.day}-${slot.shift.id}`}>
          <div><strong>{slot.site.name}</strong><span>{dateLabel(slot.day)} · {slot.shift.name} · {time(slot.shift.start_time)}–{time(slot.shift.end_time)}</span></div>
          <div className="rota-planning-actions"><span className="status-pill pending">{slot.unfilled} needed</span>
            <button type="button" className="secondary-button" onClick={() => onSelect(slot)}>{published ? "View shift" : "Find cover"}</button></div>
        </article>,
      )}
      {!matching.length && <p className="muted">{gaps.length ? "No gaps match your search." : "All required shifts are covered."}</p>}
    </div>
    <Pages page={current} count={matching.length} onChange={setPage} />
  </section>;
}

function PreviewRows({ result }) {
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const rows = result.rows.filter((row) => filter === "all" || row.status === filter);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  return <div className="rota-planning-preview">
    <div className="rota-planning-filters">
      {[
        ["all", "All", result.rows.length],
        ["ready", "Ready", result.ready],
        ["skipped", "Skipped", result.skipped],
        ["preserved", "Preserved", result.preserved],
      ].filter(([key, , count]) => key !== "preserved" || count).map(([key, label, count]) =>
        <button type="button" className="secondary-button" aria-pressed={filter === key}
          onClick={() => { setFilter(key); setPage(0); }} key={key}>{label} <strong>{count}</strong></button>,
      )}
    </div>
    <div className="rota-planning-rows">
      {rows.slice(current * pageSize, (current + 1) * pageSize).map((row) =>
        <div className="rota-planning-row" key={row.id}>
          <div><strong>{dateLabel(row.work_date)} · {row.site_name}</strong>
            <span>{row.shift_name} · {row.start}–{row.end} · {row.employee_name}</span>
            {row.reason && <span>{row.reason}</span>}
          </div>
          <span className={`status-pill ${row.status === "ready" ? "active" : row.status === "skipped" ? "pending" : "neutral"}`}>{row.status}</span>
        </div>,
      )}
      {!rows.length && <p className="muted">No assignments in this view.</p>}
    </div>
    <Pages page={current} count={rows.length} onChange={setPage} />
  </div>;
}

export function RotaBatchDialog({ mode, api, rota, days, sites, shifts, initial, onClose, onSaved }) {
  const copy = mode === "copy";
  const cover = mode === "cover";
  const [form, setForm] = useState(initial);
  const [guards, setGuards] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestPath = `/rota-weeks/${rota.id}`;
  const coverDate = cover ? form.dates[0] : null;
  const coverShift = cover ? form.shift_type : null;

  useEffect(() => {
    if (copy || !form.site) return;
    let active = true;
    const request = api(`${requestPath}/${cover ? "eligible_guards" : "inducted_guards"}/`, {
      method: "POST", silentLoading: true, silentError: true, silentToast: true, skipInvalidation: true,
      body: JSON.stringify({ site: form.site, ...(cover ? { shift_type: coverShift, work_date: coverDate } : {}) }),
    });
    request.then((items) => { if (active) setGuards(items); })
      .catch((err) => { if (active) { setError(err.message); setGuards([]); } });
    return () => { active = false; };
  }, [api, copy, cover, coverDate, coverShift, form.site, requestPath]);

  function change(values) {
    setResult(null);
    setError("");
    setForm((current) => ({ ...current, ...values }));
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const payload = copy ? {
      week_start: form.week_start,
      ...(form.scope === "selected" ? { site_ids: form.site_ids } : {}),
    } : {
      site: form.site, shift_type: form.shift_type, employee: form.employee,
      cover_only: cover,
      dates: form.dates, scheduled_start: form.scheduled_start || null, scheduled_end: form.scheduled_end || null,
    };
    setBusy(true);
    setError("");
    try {
      const response = await api(`${requestPath}/${copy ? "copy_to" : "assign_days"}/`, {
        method: "POST", silentError: true, silentLoading: true, silentToast: true, skipInvalidation: !result,
        body: JSON.stringify({ ...payload, preview: !result, ...(result ? { preview_key: result.preview_key } : {}) }),
      });
      if (result) onSaved(response);
      else setResult(response);
    } catch (err) {
      if (err.status === 409 && err.payload.rows) setResult(err.payload);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canPreview = copy ? form.week_start && (form.scope === "all" || form.site_ids.length)
    : form.site && form.shift_type && guards?.some((guard) => String(guard.id) === form.employee) && form.dates.length;
  return <PlanningDialog title={copy ? "Copy week" : cover ? "Find cover" : "Assign multiple days"} onClose={onClose} busy={busy}>
    <form className="rota-planning-form" onSubmit={submit}>
      {!result && copy && <>
        <div className="form-grid">
          <label>Target week starting<input type="date" required value={form.week_start} onChange={(event) => change({ week_start: event.target.value })} /></label>
          <label>Sites<select value={form.scope} onChange={(event) => change({ scope: event.target.value })}>
            <option value="all">All sites</option><option value="selected">Selected sites</option>
          </select></label>
        </div>
        {form.scope === "selected" && <fieldset className="rota-planning-site-picker">
          <legend>Sites to copy</legend>
          {sites.map((site) => <label key={site.id}><input type="checkbox" checked={form.site_ids.includes(site.id)} onChange={(event) =>
            change({ site_ids: event.target.checked ? [...form.site_ids, site.id] : form.site_ids.filter((id) => id !== site.id) })} />{site.name}</label>)}
          {!sites.length && <p className="muted">No sites have assignments this week.</p>}
        </fieldset>}
        <p className="muted">Existing target assignments are kept. Review the shifts that can be added before saving.</p>
      </>}
      {!result && !copy && <>
        {cover && <p className="rota-planning-slot"><CalendarDays size={17} /> {dateLabel(form.dates[0])} · {sites.find((site) => String(site.id) === form.site)?.name} · {shifts.find((shift) => String(shift.id) === form.shift_type)?.name} · {form.scheduled_start}–{form.scheduled_end}</p>}
        <div className="form-grid">
          {!cover && <>
            <label>Site<select required value={form.site} onChange={(event) => { setGuards(null); change({ site: event.target.value, employee: "" }); }}>
              <option value="">Select site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select></label>
            <label>Shift<select required value={form.shift_type} onChange={(event) => {
              const shift = shifts.find((item) => String(item.id) === event.target.value);
              change({ shift_type: event.target.value, scheduled_start: time(shift?.start_time), scheduled_end: time(shift?.end_time) });
            }}>
              <option value="">Select shift</option>{shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name}</option>)}
            </select></label>
          </>}
          <label className="full-width">{cover ? "Eligible guards" : "Guard"}<select required value={form.employee} disabled={!guards?.length} onChange={(event) => change({ employee: event.target.value })}>
            <option value="">{!form.site ? "Choose a site first" : !guards ? "Loading guards…" : guards.length ? "Select guard" : "No guards available"}</option>
            {guards?.map((guard) => <option key={guard.id} value={guard.id}>{guard.name} · {guard.employee_id}</option>)}
          </select></label>
          {!cover && <>
            <label>Start time<input type="time" value={form.scheduled_start} onChange={(event) => change({ scheduled_start: event.target.value })} /></label>
            <label>End time<input type="time" value={form.scheduled_end} onChange={(event) => change({ scheduled_end: event.target.value })} /></label>
          </>}
        </div>
        {!cover && <fieldset className="rota-planning-days"><legend>Working days</legend>
          {days.map((day) => <button type="button" className="secondary-button" key={day} aria-pressed={form.dates.includes(day)}
            onClick={() => change({ dates: form.dates.includes(day) ? form.dates.filter((date) => date !== day) : [...form.dates, day] })}>{dateLabel(day)}</button>)}
        </fieldset>}
        {cover && guards?.length === 0 && !error && <p className="muted">No eligible guards are available for this shift.</p>}
      </>}
      {result && <PreviewRows result={result} />}
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={result ? () => change({}) : onClose}>{result ? "Back" : "Cancel"}</button>
        <button type="submit" className="primary-button" disabled={busy || (result ? !result.ready : !canPreview)}>
          {copy ? <Copy size={15} /> : <Users size={15} />}
          {busy ? "Working…" : result ? `${copy ? "Copy" : "Save"} ${result.ready} ${result.ready === 1 ? "assignment" : "assignments"}` : "Preview"}
        </button>
      </footer>
    </form>
  </PlanningDialog>;
}

export function PublishRotaDialog({ gaps, conflicts, busy, error, onClose, onPublish }) {
  const [page, setPage] = useState(0);
  const total = gaps.reduce((sum, gap) => sum + gap.unfilled, 0);
  return <PlanningDialog title="Review and publish" onClose={onClose} busy={busy}>
    <div className="rota-planning-form">
      <p className="muted">{total ? `${total} open guard positions across ${gaps.length} site shifts.` : "All required shifts are covered."}</p>
      {conflicts.length > 0 && <div className="rota-availability-warning" role="alert">
        <strong>Resolve these conflicts before publishing</strong>
        <ul>{conflicts.map((message) => <li key={message}>{message}</li>)}</ul>
      </div>}
      <div className="rota-planning-rows">
        {gaps.slice(page * pageSize, (page + 1) * pageSize).map(({ site, shift, day, unfilled }) =>
          <div className="rota-planning-row" key={`${site.id}-${day}-${shift.id}`}>
            <div><strong>{site.name}</strong><span>{dateLabel(day)} · {shift.name}</span></div><span className="status-pill pending">{unfilled} needed</span>
          </div>,
        )}
      </div>
      <Pages page={page} count={gaps.length} onChange={setPage} />
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Back to rota</button>
        <button type="button" className="primary-button" disabled={busy || conflicts.length > 0} onClick={onPublish}>{busy ? "Publishing…" : total ? "Publish with gaps" : "Publish rota"}</button></footer>
    </div>
  </PlanningDialog>;
}
