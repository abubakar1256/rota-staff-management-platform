export function formatArrivalDelay(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return "—";
  const total = Math.max(0, Math.round(Number(minutes)));
  if (!total) return "On time";
  const hours = Math.floor(total / 60), remainder = total % 60;
  return hours ? `${hours}hr${remainder ? ` ${remainder}min` : ""}` : `${remainder} min`;
}

export function formatArrivalSchedule(start, end) {
  const first = start ? String(start).slice(0, 5) : "—";
  const last = end ? String(end).slice(0, 5) : "—";
  return !start && !end ? "—" : `${first}–${last}`;
}
