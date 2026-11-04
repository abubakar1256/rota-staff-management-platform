import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { formatDashboardClock, UK_TIME_ZONE } from "./ukTime";
import "./dashboardClock.css";

export default function DashboardClock({ serverTime, timeZone = UK_TIME_ZONE }) {
  const [now, setNow] = useState(null);
  useEffect(() => {
    const serverMilliseconds = Date.parse(serverTime);
    if (!Number.isFinite(serverMilliseconds)) { setNow(null); return undefined; }
    // Advance from the backend's clock without relying on the device's wall
    // clock or making background requests that could disturb the dashboard.
    const started = performance.now();
    const tick = () => setNow(new Date(serverMilliseconds + performance.now() - started));
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [serverTime]);

  const clock = now ? formatDashboardClock(now, timeZone) : null;
  return <section className="dashboard-clock" aria-label="Operations timezone and current time">
    <div className="dashboard-clock-location"><span className="dashboard-clock-icon" aria-hidden="true"><Clock3 size={23} /></span><div><strong>{timeZone === UK_TIME_ZONE ? "United Kingdom time" : "Operations time"}</strong><span>{timeZone}</span></div></div>
    <div className="dashboard-clock-display">{clock ? <><div className="dashboard-clock-time-row"><time className="dashboard-clock-time" dateTime={now.toISOString()}>{clock.time}</time><span className="dashboard-clock-zone">{clock.abbreviation}</span></div><div className="dashboard-clock-details"><span>{clock.date}</span><span className="dashboard-clock-live"><i aria-hidden="true" />Live</span></div></> : <span className="dashboard-clock-loading">Waiting for server time…</span>}</div>
  </section>;
}
