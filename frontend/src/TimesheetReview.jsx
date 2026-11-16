import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { ShiftCompletionSummary, CompletedAttendanceHistory } from "./ShiftCompletionSummary";
import { reviewFlagLabels } from "./shiftCompletion";
import { formatUkDateTime } from "./ukTime";
import { formatTimesheetDuration as duration, timesheetSeconds } from "./timesheetHours";

export default function TimesheetReview({ sheet, api, FilePreview, onClose, onApproved, canApprove = true }) {
  const [operation, setOperation] = useState(null), [loading, setLoading] = useState(Boolean(sheet.operation));
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const titleId = useId();
  useEffect(() => {
    if (!sheet.operation) return undefined;
    let active = true;
    api(`/operations/${sheet.operation}/`, { silentLoading: true }).then((value) => { if (active) setOperation(value); }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sheet.operation]);
  const approve = async () => {
    setSaving(true); setError("");
    try { onApproved(await api(`/timesheets/${sheet.id}/`, { method: "PATCH", body: JSON.stringify({ approved: true }) })); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const steps = (operation?.hourly_checkins || []).filter((entry) => entry.status === "EXPIRED").map((entry) => ({ key: `hourly-${entry.sequence}`, label: `Hourly picture ${entry.sequence}`, status: entry.status, missed_reason: entry.missed_reason }));
  const hours = timesheetSeconds(sheet);
  return <div className="modal-backdrop"><section className="modal-card timesheet-review-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-header"><div><p className="eyebrow">OFFICE REVIEW</p><h3 id={titleId}>{sheet.employee_name}</h3><p className="muted">{sheet.site_name || "No site"} · {sheet.work_date}</p></div><button type="button" className="icon-button" aria-label="Close timesheet review" disabled={saving} onClick={onClose}><X size={20} /></button></div>
    <div className="timesheet-review-totals"><span>Scheduled <strong>{duration(sheet.scheduled_seconds ?? sheet.scheduled_hours * 3600)}</strong></span><span>Actual <strong>{duration(hours.actual)}</strong></span><span>Overtime <strong>{duration(hours.overtime)}</strong></span><span>Total <strong>{duration(hours.total)}</strong></span><span className={`status-pill ${sheet.approved ? "active" : "pending"}`}>{sheet.approved ? "Approved" : sheet.review_flags?.length ? "Review required" : "Draft"}</span></div>
    {sheet.corrected_start_at && <p className="muted">Corrected actual time · {formatUkDateTime(sheet.corrected_start_at)} – {formatUkDateTime(sheet.corrected_end_at)}</p>}
    {loading ? <p className="muted" role="status">Loading attendance evidence…</p> : operation ? <><ShiftCompletionSummary summary={operation.completion_summary && { ...operation.completion_summary, timesheet_status: sheet.approved ? "APPROVED" : operation.completion_summary.timesheet_status }} /><CompletedAttendanceHistory item={operation} steps={steps} renderPhotoLink={(url, label) => url ? <FilePreview value={url} label="Attendance picture" buttonLabel={label} /> : null} /></> : !error && <p className="muted">Manual timesheet · {sheet.actual_start || "—"} to {sheet.actual_end || "—"}</p>}
    {sheet.review_flags?.length > 0 && <p className="shift-completion-flags">Review checks: {sheet.review_flags.map((flag) => reviewFlagLabels[flag] || flag).join(" · ")}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Close</button>{canApprove && !sheet.approved && <button type="button" className="primary-button" disabled={loading || saving || Boolean(sheet.operation && !operation)} onClick={approve}>{saving ? "Approving…" : "Approve timesheet"}</button>}</div>
  </section></div>;
}
