import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { ukDate } from "./ukTime";
import "./guardAvailability.css";

function offsetDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mondayOf(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return offsetDate(date, -((weekday + 6) % 7));
}

const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const availabilityKey = (employee, date) => `${employee}:${date}`;

export function useGuardAvailability(api, weekStart) {
  return useQuery({
    queryKey: ["rota", "guard-availability", weekStart],
    queryFn: ({ signal }) => api(`/guard-availability/?week_start=${weekStart}`, { signal, silentLoading: true, silentError: true }),
    refetchOnMount: "always",
  });
}

export function unavailableDays(rows = []) {
  return new Set(rows.map(({ employee, work_date }) => availabilityKey(employee, work_date)));
}

export function unavailableShiftDate(marked, employee, workDate, start, end) {
  if (!employee || !workDate) return null;
  if (marked.has(availabilityKey(employee, workDate))) return workDate;
  const startTime = start?.length === 5 ? `${start}:00` : start;
  const endTime = end?.length === 5 ? `${end}:00` : end;
  if (startTime && endTime && endTime <= startTime && endTime !== "00:00:00") {
    const next = offsetDate(workDate, 1);
    if (marked.has(availabilityKey(employee, next))) return next;
  }
  return null;
}

export function guardUnavailableMessage(name, date) {
  return `${name} is unavailable on ${dateLabel.format(new Date(`${date}T00:00:00Z`))}.`;
}

export default function GuardAvailability({ api }) {
  const [weekStart, setWeekStart] = useState(() => offsetDate(mondayOf(ukDate()), 7));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const calendar = useGuardAvailability(api, weekStart);
  const guards = useQuery({
    queryKey: ["rota", "employees", "guard-availability"],
    queryFn: ({ signal }) => api("/employees/", { signal, silentLoading: true, silentError: true }),
  });
  const days = Array.from({ length: 7 }, (_, index) => offsetDate(weekStart, index));
  const marked = unavailableDays(calendar.data);
  const term = search.trim().toLowerCase();
  const visibleGuards = (guards.data || []).filter((guard) => `${guard.name} ${guard.employee_id}`.toLowerCase().includes(term));
  const loadError = guards.error || calendar.error;

  function selectWeek(date) {
    if (!date) return;
    setWeekStart(mondayOf(date));
    setMessage("");
    setSaveError("");
  }

  async function toggleDay(guard, date, unavailable) {
    setSaving(true);
    setMessage("");
    setSaveError("");
    try {
      await api("/guard-availability/", {
        method: "PUT",
        body: JSON.stringify({ employee: guard.id, work_date: date, unavailable }),
        silentToast: true,
        silentError: true,
      });
      await calendar.refetch({ cancelRefetch: false });
      setMessage(unavailable ? guardUnavailableMessage(guard.name, date) : `Availability mark removed for ${guard.name}.`);
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  }

  return <>
    <div className="page-heading">
      <div>
        <p className="eyebrow">ROTA PLANNING</p>
        <h2>Guard Availability</h2>
        <p className="muted">Mark whole days when a guard cannot work. Changes save as you click.</p>
      </div>
      <div className="guard-availability-week">
        <button type="button" className="icon-button" aria-label="Previous week" disabled={saving} onClick={() => selectWeek(offsetDate(weekStart, -7))}><ChevronLeft size={19} /></button>
        <label>Week starting<input type="date" value={weekStart} disabled={saving} onChange={(event) => selectWeek(event.target.value)} /></label>
        <button type="button" className="icon-button" aria-label="Next week" disabled={saving} onClick={() => selectWeek(offsetDate(weekStart, 7))}><ChevronRight size={19} /></button>
      </div>
    </div>
    {saveError && <p className="error page-error" role="alert">{saveError}</p>}
    {message && <p className="success page-success" role="status">{message}</p>}
    <section className="panel">
      <div className="toolbar">
        <div className="search-box"><Search size={16} /><input aria-label="Search guards" placeholder="Search guard name or ID" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <span className="muted">{visibleGuards.length} guards</span>
      </div>
      {loadError ? <div className="empty-state">
        <p className="error" role="alert">{loadError.message}</p>
        <button type="button" className="secondary-button" onClick={() => { guards.refetch(); calendar.refetch(); }}>Try again</button>
      </div>
        : guards.isPending || calendar.isPending ? <div className="empty-state">Loading guard availability…</div>
        : visibleGuards.length ? <div className="table-wrap guard-availability-table">
          <table>
            <thead><tr><th scope="col">Guard</th>{days.map((date) => <th scope="col" key={date}>{dayLabel.format(new Date(`${date}T00:00:00Z`))}</th>)}</tr></thead>
            <tbody>{visibleGuards.map((guard) => <tr key={guard.id}>
              <th scope="row"><strong>{guard.name}</strong><small className="table-subtext">{guard.employee_id}{guard.status !== "ACTIVE" && ` · ${guard.status.replaceAll("_", " ").toLowerCase()}`}</small></th>
              {days.map((date) => {
                const unavailable = marked.has(availabilityKey(guard.id, date));
                return <td key={date}><button
                  type="button"
                  className={`availability-day${unavailable ? " unavailable" : ""}`}
                  aria-label={`${guard.name}, ${dateLabel.format(new Date(`${date}T00:00:00Z`))}, unavailable`}
                  aria-pressed={unavailable}
                  disabled={saving}
                  onClick={() => toggleDay(guard, date, !unavailable)}
                >{unavailable ? "Unavailable" : "Unmarked"}</button></td>;
              })}
            </tr>)}</tbody>
          </table>
        </div> : <div className="empty-state">No guards found.</div>}
    </section>
  </>;
}
