import { formatArrivalDelay, formatArrivalSchedule } from "./arrivalFormatting.js";
import { CheckCircle2, ClipboardList, Clock3, Users } from "lucide-react";
import { formatUkDateTime } from "./ukTime.js";

const statusLabels = { REACHED: "Reached", LATE: "Late", NOT_REACHED: "Not reached", UPCOMING: "Upcoming" };

export default function ReachedReport({ report, StatCard }) {
  const arrival = report.arrival_summary || {};
  const rows = report.arrival_rows || [];
  const unfilled = report.arrival_unfilled || [];
  const onTime = arrival.reached || 0, late = arrival.late || 0, upcoming = arrival.upcoming || 0;
  return <>
    <section className="stats-grid">
      <StatCard label="Scheduled arrivals" value={arrival.scheduled || 0} detail="Assigned guard shifts in this period" icon={Users} tone="blue" />
      <StatCard label="Reached site" value={onTime + late} detail={`${onTime} on time · ${late} late`} icon={CheckCircle2} tone="teal" />
      <StatCard label="Late arrivals" value={late} detail="Reached after shift start" icon={Clock3} tone="amber" />
      <StatCard label="Not reached" value={arrival.not_reached || 0} detail={`${upcoming} upcoming · unfilled positions excluded`} icon={ClipboardList} tone="rose" />
    </section>
    {upcoming > 0 && <p className="arrival-period-note">{upcoming} assigned shift{upcoming === 1 ? " has" : "s have"} not started yet. These are marked Upcoming and are excluded from Not reached.</p>}
    {(arrival.not_assigned || 0) > 0 && <details className="panel arrival-unfilled-panel"><summary>{arrival.not_assigned} unfilled guard position{arrival.not_assigned === 1 ? "" : "s"} in this period <span>View staffing gaps</span></summary><p className="muted">Calculated from each date’s current site and shift requirements. Empty positions are separate from assigned guard arrivals.</p><div className="arrival-unfilled-list">{unfilled.map((item) => <div key={item.id}><div><strong>{item.site_name}</strong><span>{item.date} · {item.shift_name} · {formatArrivalSchedule(item.scheduled_start, item.scheduled_end)}</span></div><span className="status-pill pending">{item.unfilled} unfilled</span></div>)}</div></details>}
    <section className="panel arrival-report"><div className="panel-header"><div><h3>Reached at site report</h3><p className="muted">Assigned guards · {report.start_date} to {report.end_date} · Europe/London (GMT/BST)</p></div><span className="muted">{rows.length} guard record{rows.length === 1 ? "" : "s"}</span></div>
      {rows.length ? <div className="table-wrap arrival-table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>Site</th><th>Shift</th><th>Scheduled</th><th>Reached at (UK)</th><th>Delay</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.date}</td><td><strong>{row.employee_name}</strong>{row.employee_id && <small className="table-subtext">{row.employee_id}</small>}</td><td>{row.site_name}</td><td>{row.shift_name}</td><td>{formatArrivalSchedule(row.scheduled_start, row.scheduled_end)}</td><td>{formatUkDateTime(row.reached_at)}</td><td>{formatArrivalDelay(row.delay_minutes)}</td><td><span className={`status-pill ${row.arrival_status === "UPCOMING" ? "neutral" : row.arrival_status.toLowerCase()}`}>{statusLabels[row.arrival_status] || row.arrival_status}</span></td></tr>)}</tbody></table></div> : <div className="empty-state">No assigned guard arrival records for this period.</div>}
    </section>
  </>;
}
