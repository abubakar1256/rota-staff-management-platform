export const shiftPreferenceLabels = {
  DAY: "Day",
  NIGHT: "Night",
  BOTH: "Day + Night",
  CUSTOM: "Customize",
};

export function matchesShiftPreference(preference, selection) {
  return !selection || preference === selection
    || (preference === "BOTH" && (selection === "DAY" || selection === "NIGHT"));
}

export function shiftPeriod(shift) {
  if (/\bnight\b/i.test(shift.name)) return "NIGHT";
  if (/\bday\b/i.test(shift.name)) return "DAY";
  return shift.end_time < shift.start_time ? "NIGHT" : "DAY";
}
