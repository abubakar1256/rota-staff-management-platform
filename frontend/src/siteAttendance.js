export const siteAttendanceModes = [
  { value: "BOOK_ON_OFF", label: "Book On / Book Off only", hint: "Arrival and departure photos with GPS. No hourly pictures." },
  { value: "WITH_HOURLY", label: "Book On / Book Off + Hourly Picture", hint: "Arrival, hourly and departure photos with GPS." },
];

export function siteRequiresHourly(item) {
  if (typeof item.hourly_pictures_required === "boolean") return item.hourly_pictures_required;
  return item.attendance_mode !== "BOOK_ON_OFF";
}

export function siteAttendanceLabel(item) {
  return siteAttendanceModes.find((mode) => mode.value === item.attendance_mode)?.label
    || siteAttendanceModes[1].label;
}

export function hourlyCheckinsFor(item) {
  return siteRequiresHourly(item) ? (item.hourly_checkins || []) : [];
}

export function bookOnIsLate(item, now = Date.now()) {
  const event = (item.attendance_events || []).find((event) => event.event_type === "BOOK_ON");
  const dueAt = Date.parse(item.book_on_due_at);
  if (event) {
    if (typeof item.book_on_is_late === "boolean") return item.book_on_is_late;
    return Number.isFinite(dueAt) && Date.parse(event.captured_at) > dueAt;
  }
  return item.book_on_is_late === true || (Number.isFinite(dueAt) && now > dueAt);
}
