import { CheckCircle2 } from "lucide-react";
import { formatUkDateTime } from "./ukTime.js";
import { completionStatus, formatShiftDuration, reviewFlagLabels } from "./shiftCompletion";

const displayTime = (value) => value ? formatUkDateTime(value) : "Not recorded";

export function ShiftCompletionSummary({ summary }) {
  if (!summary) return null;
  return <section className="shift-completion-summary" aria-label="Completed shift summary">
    <div className="shift-completion-heading"><CheckCircle2 size={23} /><div><h4>Shift completed successfully</h4><p>{summary.site_name} · {summary.work_date}</p></div></div>
    <dl className="shift-completion-facts"><div><dt>Book On</dt><dd>{displayTime(summary.book_on_at)}</dd></div><div><dt>Book Off</dt><dd>{displayTime(summary.book_off_at)}</dd></div><div><dt>Total duration</dt><dd>{formatShiftDuration(summary.duration_minutes)}</dd></div><div><dt>Timesheet</dt><dd>{completionStatus(summary)}</dd></div></dl>
    {summary.timesheet_id && summary.timesheet_status !== "APPROVED" && <p className="shift-completion-note">A draft timesheet has been sent to the office for review.</p>}
    {summary.review_flags?.length > 0 && <p className="shift-completion-flags">For office review: {summary.review_flags.map((flag) => reviewFlagLabels[flag] || flag).join(" · ")}</p>}
    <p className="shift-completion-note">Attendance is closed. Your recorded pictures and reasons remain in the history below.</p>
  </section>;
}

export function CompletedAttendanceHistory({ item, steps, renderPhotoLink }) {
  return <section className="completed-attendance-history" aria-label="Attendance history"><h4>Attendance history</h4>
    {(item.attendance_events || []).map((event) => <article className="completed-attendance-event" key={event.id}><div><strong>{event.event_label || event.event_type.replaceAll("_", " ")}</strong><span>{displayTime(event.captured_at)}</span><small>GPS: {(event.location_status || "Not recorded").replaceAll("_", " ")}</small>{event.late_reason && <p><strong>Late Book On reason:</strong> {event.late_reason}</p>}</div>{renderPhotoLink(event.photo_url, "View picture")}</article>)}
    {steps.filter((step) => step.status === "EXPIRED").map((step) => <article className="completed-attendance-event" key={step.key}><div><strong>{step.label} · Missed</strong><p>{step.missed_reason || "No reason recorded. The office will review this exception."}</p></div></article>)}
  </section>;
}
