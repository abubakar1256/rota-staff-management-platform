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
