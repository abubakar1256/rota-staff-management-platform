export function siteWeekStaffing({ site, days, shifts, requirements, assignments }) {
  const assigned = assignments.filter((item) => String(item.site) === String(site.id) && item.employee);
  if (site.is_active === false) return { requiredSlots: 0, unfilled: 0 };
  const overrides = new Map(requirements.filter((item) => String(item.site) === String(site.id)).map((item) => [`${item.weekday}-${item.shift_type}`, Number(item.required_guards)]));
  let requiredSlots = 0, unfilled = 0;
  for (const day of days) {
    // Weekdays are Monday=0, including when the supplied range starts midweek.
    const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
    for (const shift of shifts.filter((item) => item.is_active !== false)) {
      const key = `${weekday}-${shift.id}`;
      const required = overrides.has(key) ? overrides.get(key) : Number(site.required_guards || 0);
      const count = assigned.filter((item) => item.work_date === day && String(item.shift_type) === String(shift.id)).length;
      requiredSlots += required;
      unfilled += Math.max(required - count, 0);
    }
  }
  return { requiredSlots, unfilled };
}
