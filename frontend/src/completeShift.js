// Keep scheduled slots and recorded evidence together, even after a site mode changes.
export function shiftTimeline(operation) {
  const events = operation.attendance_events || [];
  const on = events.find((event) => event.event_type === "BOOK_ON");
  const off = events.find((event) => event.event_type === "BOOK_OFF");
  const slots = new Map((operation.hourly_checkins || []).map((slot) => [slot.sequence, slot]));
  const notes = new Map((operation.hourly_checkin_notes || []).map((note) => [note.sequence, note]));
  const hourly = new Map(events.filter((event) => event.event_type === "HOURLY").map((event) => [event.sequence, event]));
  const sequences = [...new Set([...slots.keys(), ...notes.keys(), ...hourly.keys()])].sort((a, b) => a - b);
  return [
    { key: "book-on", label: "Book On", status: on ? "COMPLETED" : "WAITING", event: on, due_at: operation.book_on_due_at, reason: on?.late_reason, reason_label: "Late Book On reason" },
    ...sequences.map((sequence) => {
      const slot = slots.get(sequence), note = notes.get(sequence), event = hourly.get(sequence);
      return { ...slot, key: `hourly-${sequence}`, label: `Hourly picture ${sequence}`, event,
        status: event ? "COMPLETED" : slot?.status || "EXPIRED", reason: slot?.missed_reason || note?.reason,
        reason_at: note?.updated_at || slot?.missed_reason_created_at, reason_label: "Missed picture reason" };
    }),
    { key: "book-off", label: "Book Off", status: off ? "COMPLETED" : operation.book_off_status || "UPCOMING", event: off,
      due_at: operation.book_off_due_at, deadline_at: operation.book_off_deadline_at,
      reason: operation.book_off_note?.reason, reason_at: operation.book_off_note?.updated_at, reason_label: "Missed Book Off reason" },
  ];
}

export function evidencePoint(value) {
  if (value?.latitude == null || value?.longitude == null || String(value.latitude).trim() === "" || String(value.longitude).trim() === "") return null;
  const latitude = Number(value.latitude), longitude = Number(value.longitude);
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    ? { latitude, longitude } : null;
}

export function evidenceMapUrl(value) {
  const point = evidencePoint(value);
  return point ? `https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=17/${point.latitude}/${point.longitude}` : null;
}
