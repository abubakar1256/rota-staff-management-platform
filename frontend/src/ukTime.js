export const UK_TIME_ZONE = "Europe/London";

const formatters = new Map();

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
