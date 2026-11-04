export const UK_TIME_ZONE = "Europe/London";

const formatters = new Map();

export function ukDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function formatUkAttendanceTime(value) {
  return value ? new Intl.DateTimeFormat("en-GB", { timeZone: UK_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(new Date(value)) : "—";
}

export function formatUkDateTime(value) {
  return value ? new Intl.DateTimeFormat("en-GB", { timeZone: UK_TIME_ZONE, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(new Date(value)) : "—";
}

export function formatDashboardClock(value, timeZone = UK_TIME_ZONE) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, {
      time: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }),
      date: new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      zone: new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" }),
    });
  }
  const formatter = formatters.get(timeZone);
  const date = new Date(value);
  return {
    time: formatter.time.format(date),
    date: formatter.date.format(date),
    abbreviation: formatter.zone.formatToParts(date).find((part) => part.type === "timeZoneName").value,
  };
}
