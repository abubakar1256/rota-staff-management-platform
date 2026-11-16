import { useState } from "react";
import { CalendarDays, MapPin, Search, X } from "lucide-react";
import { dateLabel } from "./RotaPlanning";
import { addDays } from "./ukTime";
import "./guardWeeklyRota.css";

function workingTime(assignment) {
  const start = assignment.effective_start || assignment.scheduled_start;
  const end = assignment.effective_end || assignment.scheduled_end;
  if (!start || !end) return "Time unavailable";
  const endDay = end <= start ? ` ${dateLabel(addDays(assignment.work_date, 1))}` : "";
  return `${start.slice(0, 5)}–${end.slice(0, 5)}${endDay}`;
}

export default function GuardWeeklyRota({ week, days, loading, employees, assignments }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const guards = new Map(employees.map((employee) => [employee.id,
    { id: employee.id, name: employee.name, code: employee.employee_id },
  ]));
  for (const row of assignments) {
    if (row.employee && !guards.has(row.employee)) {
      guards.set(row.employee, { id: row.employee, name: row.employee_name, code: row.employee_code });
    }
  }
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = terms.length ? [...guards.values()].filter((guard) => {
    const searchable = `${guard.name} ${guard.code || ""}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id) : [];

  const guard = selected && (guards.get(selected.id) || selected);
  const shifts = guard ? assignments.filter((row) => row.employee === guard.id)
    .sort((a, b) => a.work_date.localeCompare(b.work_date)
      || (a.effective_start || a.scheduled_start || "").localeCompare(b.effective_start || b.scheduled_start || "")
      || a.id - b.id) : [];
  const siteCount = new Set(shifts.map((row) => row.site)).size;

  function selectGuard(choice) {
    setSelected(choice);
    setQuery("");
  }

  return <section className="panel guard-weekly-rota" aria-labelledby="guard-weekly-rota-title">
    <div className="guard-weekly-rota-heading">
      <div><h3 id="guard-weekly-rota-title">Guard weekly rota</h3>
        <p className="muted">Search by name or ID to see a guard's shifts across all sites.</p></div>
      <form className="guard-weekly-rota-search" onSubmit={(event) => {
        event.preventDefault();
        if (matches.length === 1) selectGuard(matches[0]);
      }}>
        <label className="search-box"><Search size={16} aria-hidden="true" />
          <input type="search" aria-label="Search guard by name or ID" placeholder="Search guard or ID"
            value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {terms.length > 0 && (matches.length > 0 ? <ul className="guard-weekly-rota-matches" aria-label="Matching guards">
          {matches.slice(0, 8).map((match) => <li key={match.id}>
            <button type="button" onClick={() => selectGuard(match)}><strong>{match.name}</strong><small>{match.code}</small></button>
          </li>)}
          {matches.length > 8 && <li className="muted">Keep typing to narrow results.</li>}
        </ul> : <p className="muted" role="status">{loading ? "Loading guards…" : "No matching guards for this week."}</p>)}
      </form>
    </div>
    {guard && <div className="guard-weekly-rota-result">
      <header className="guard-weekly-rota-summary">
        <div><h4>{guard.name}</h4><p className="muted">{guard.code && `${guard.code} · `}{dateLabel(days[0])} – {dateLabel(days[6])} · UK time</p></div>
        <div className="guard-weekly-rota-status">
          {week && !loading && <span className={`status-pill ${week.status === "PUBLISHED" ? "active" : "neutral"}`}>{week.status === "PUBLISHED" ? "Published" : "Draft"}</span>}
          <button type="button" className="icon-button" aria-label="Clear selected guard" onClick={() => { setSelected(null); setQuery(""); }}><X size={17} /></button>
        </div>
      </header>
      {loading ? <p className="muted" role="status">Loading weekly shifts…</p>
        : !week ? <p className="muted">The selected week could not be loaded.</p>
        : !shifts.length ? <p className="muted">No shifts assigned to this guard for the selected week.</p> : <>
          <p className="guard-weekly-rota-count"><CalendarDays size={16} aria-hidden="true" />
            {shifts.length} {shifts.length === 1 ? "shift" : "shifts"} · {siteCount} {siteCount === 1 ? "site" : "sites"}
          </p>
          <ol className="guard-weekly-rota-days" aria-label="Weekly shifts by day">
            {days.map((day) => {
              const scheduled = shifts.filter((row) => row.work_date === day);
              return <li key={day} className="guard-weekly-rota-day">
                <h5>{dateLabel(day)}</h5>
                {scheduled.length ? <ul className="guard-weekly-rota-shifts">{scheduled.map((row) =>
                  <li key={row.id}>
                    <strong><MapPin size={14} aria-hidden="true" />{row.site_name}</strong>
                    <span>{row.shift_name}{row.split_cover && " · Split cover"}</span>
                    <b>{workingTime(row)}</b>
                  </li>)}</ul> : <p className="muted">No shift assigned</p>}
              </li>;
            })}
          </ol>
        </>}
    </div>}
  </section>;
}
