export function siteWeekSlots({ site, days, shifts, requirements, assignments }) {
  if (site.is_active === false) return [];
  const overrides = new Map(requirements.filter((item) => String(item.site) === String(site.id)).map((item) => [`${item.weekday}-${item.shift_type}`, Number(item.required_guards)]));
  const counts = new Map();
  for (const item of assignments) {
    if (String(item.site) !== String(site.id) || !item.employee) continue;
    const key = `${item.work_date}-${item.shift_type}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const activeShifts = shifts.filter((shift) => shift.is_active !== false);
  return days.flatMap((day) => {
    const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
    return activeShifts.map((shift) => {
      const key = `${weekday}-${shift.id}`;
      const required = overrides.has(key) ? overrides.get(key) : Number(site.required_guards || 0);
      const assigned = counts.get(`${day}-${shift.id}`) || 0;
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
