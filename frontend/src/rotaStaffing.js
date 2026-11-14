function shiftMinutes(value) {
  const [hours, minutes, seconds = 0] = value.split(":").map(Number);
  return hours * 60 + minutes + seconds / 60;
}

function interval(start, end) {
  const from = shiftMinutes(start);
  const to = shiftMinutes(end);
  return [from, to > from ? to : to + 1440];
}

export function staffedPositions(assignments) {
  let filled = 0;
  const groups = new Map();
  for (const row of assignments) {
    if (!row.employee) continue;
    if (!row.split_cover) {
      filled += 1;
      continue;
    }
    const group = row.split_cover.group;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  for (const rows of groups.values()) {
    const { start, end } = rows[0].split_cover;
    let [covered, finish] = interval(start, end);
    const parts = rows.map((row) => interval(row.scheduled_start, row.scheduled_end))
      .sort(([left], [right]) => left - right);
    for (const [from, to] of parts) {
      if (from > covered) break;
      covered = Math.max(covered, to);
    }
    if (covered >= finish) filled += 1;
  }
  return filled;
}

export function siteWeekSlots({ site, days, shifts, requirements, assignments }) {
  if (site.is_active === false) return [];
  const overrides = new Map(requirements.filter((item) => String(item.site) === String(site.id)).map((item) => [`${item.weekday}-${item.shift_type}`, Number(item.required_guards)]));
  const counts = new Map();
  for (const item of assignments) {
    if (String(item.site) !== String(site.id) || !item.employee) continue;
    const key = `${item.work_date}-${item.shift_type}`;
    if (!counts.has(key)) counts.set(key, []);
    counts.get(key).push(item);
  }
  const activeShifts = shifts.filter((shift) => shift.is_active !== false);
  return days.flatMap((day) => {
    const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
    return activeShifts.map((shift) => {
      const key = `${weekday}-${shift.id}`;
      const required = overrides.has(key) ? overrides.get(key) : Number(site.required_guards || 0);
      const assigned = staffedPositions(counts.get(`${day}-${shift.id}`) || []);
      return { site, shift, day, required, unfilled: Math.max(required - assigned, 0) };
    });
  });
}

export function siteWeekStaffing(input) {
  return siteWeekSlots(input).reduce((totals, slot) => ({
    requiredSlots: totals.requiredSlots + slot.required,
    unfilled: totals.unfilled + slot.unfilled,
  }), { requiredSlots: 0, unfilled: 0 });
}
