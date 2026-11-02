export const reviewFlagLabels = {
  LATE_BOOK_ON: "Late Book On",
  LOCATION_EXCEPTION: "GPS exception",
  MISSED_HOURLY_PICTURES: "Missed hourly pictures",
};

export function formatShiftDuration(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return "Not available";
  const whole = Math.max(0, Math.floor(Number(minutes)));
  return `${Math.floor(whole / 60)}h ${whole % 60}m`;
}

export function completionStatus(summary) {
  return ({ APPROVED: "Approved by office", REVIEW_REQUIRED: "Review required", DRAFT: "Awaiting office review", NOT_CREATED: "Office follow-up required" })[summary?.timesheet_status] || "Awaiting office review";
}
