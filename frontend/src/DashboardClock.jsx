import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { dashboardClockTime, formatDashboardClock, UK_TIME_ZONE } from "./ukTime";
import "./dashboardClock.css";

export default function DashboardClock({ serverTime, receivedAt, timeZone = UK_TIME_ZONE }) {
  const [deviceTime, setDeviceTime] = useState(Date.now);
  useEffect(() => {
    const tick = () => setDeviceTime(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, []);

  const now = dashboardClockTime(serverTime, receivedAt, deviceTime);
  const clock = now ? formatDashboardClock(now, timeZone) : null;
  return <section className="dashboard-clock" aria-label="Operations timezone and current time">
    <div className="dashboard-clock-location"><span className="dashboard-clock-icon" aria-hidden="true"><Clock3 size={23} /></span><div><strong>{timeZone === UK_TIME_ZONE ? "United Kingdom time" : "Operations time"}</strong><span>{timeZone}</span></div></div>
    <div className="dashboard-clock-display">{clock ? <><div className="dashboard-clock-time-row"><time className="dashboard-clock-time" dateTime={now.toISOString()}>{clock.time}</time><span className="dashboard-clock-zone">{clock.abbreviation}</span></div><div className="dashboard-clock-details"><span>{clock.date}</span><span className="dashboard-clock-live"><i aria-hidden="true" />Live</span></div></> : <span className="dashboard-clock-loading">Waiting for server time…</span>}</div>
  </section>;
}
