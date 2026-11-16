import { ukDate, UK_TIME_ZONE, addDays } from "./ukTime.js";

const ukClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function timesheetSeconds(sheet) {
  const actual = sheet.actual_seconds ?? Number(sheet.actual_hours || 0) * 3600;
  const overtime = Number(sheet.overtime_minutes || 0) * 60;
  return { actual, overtime, total: actual + overtime };
}

export function formatTimesheetDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ""}` : `${remainder}m`;
}

export function actualTimes(sheet) {
  const start = sheet.corrected_start_at || sheet.actual_start_at;
  const end = sheet.corrected_end_at || sheet.actual_end_at;
  if (start && end) {
    const local = (value) => {
      const instant = new Date(value);
      return `${ukDate(instant)}T${ukClock.format(instant)}`;
    };
    return { start: local(start), end: local(end), startAt: start, endAt: end };
  }
  const { actual_start, actual_end, work_date } = sheet;
  const endDate = actual_start && actual_end && actual_end <= actual_start ? addDays(work_date, 1) : work_date;
  return {
    start: actual_start ? `${work_date}T${actual_start.slice(0, 5)}` : "",
    end: actual_end ? `${endDate}T${actual_end.slice(0, 5)}` : "",
  };
}

function totals() {
  return { actual: 0, overtime: 0, total: 0 };
}

function addHours(report, hours) {
  report.actual += hours.actual;
  report.overtime += hours.overtime;
  report.total += hours.total;
}

function recordGuard(guards, sheet, hours) {
  const guard = guards.get(sheet.employee) || { id: sheet.employee, name: sheet.employee_name, days: new Set(), entries: [], ...totals() };
  if (hours.total > 0) guard.days.add(sheet.work_date);
  guard.entries.push(sheet);
  addHours(guard, hours);
  guards.set(sheet.employee, guard);
}

export function weeklyTimesheetTotals(sheets) {
  const sites = new Map();
  const guards = new Map();
  const total = totals();
  const ordered = [...sheets].sort((a, b) => a.work_date.localeCompare(b.work_date) || a.id - b.id);
  for (const sheet of ordered) {
    const hours = timesheetSeconds(sheet);
    const siteId = sheet.site ?? "unassigned";
    const site = sites.get(siteId) || { id: siteId, name: sheet.site_name || "Unassigned site", guards: new Map(), ...totals() };
    recordGuard(site.guards, sheet, hours);
    recordGuard(guards, sheet, hours);
    addHours(site, hours);
    addHours(total, hours);
    sites.set(siteId, site);
  }
  const sorted = (entries) => [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { total, guards: sorted(guards), sites: sorted(sites).map((site) => ({ ...site, guards: sorted(site.guards) })) };
}
