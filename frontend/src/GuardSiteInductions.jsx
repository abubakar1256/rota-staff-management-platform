import { ClipboardList } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SiteLocationLinks } from "./SiteLocation";

const statusLabels = { PLANNED: "Planned", COMPLETED: "Completed", CANCELLED: "Cancelled" };
const statusStyles = { PLANNED: "pending", COMPLETED: "active", CANCELLED: "inactive" };
const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });

export default function GuardSiteInductions({ api }) {
  const { data = [], error, isPending, refetch } = useQuery({
    queryKey: ["rota", "site-inductions", "my"],
    queryFn: ({ signal }) => api("/site-inductions/my/", { signal, silentLoading: true, silentError: true }),
    refetchOnMount: "always",
  });

  return <>
    <div className="page-heading">
      <div>
        <p className="eyebrow">GUARD PORTAL</p>
        <h2>My site inductions</h2>
        <p className="muted">Check when and where the office has arranged your site induction. Times are UK local time.</p>
      </div>
    </div>
    {isPending ? <section className="panel empty-state">Loading inductions…</section>
      : error ? <section className="panel empty-state">
        <p className="error" role="alert">{error.message}</p>
        <button type="button" className="secondary-button" onClick={() => refetch()}>Try again</button>
      </section>
      : data.length ? <section className="guard-induction-list" aria-label="Assigned site inductions">
        {data.map((item) => <article className="panel guard-induction-card" key={item.id}>
          <div className="panel-header">
            <div>
              <h3>{item.site_name}</h3>
              <p className="muted">
                {dateFormat.format(new Date(`${item.induction_date}T00:00:00Z`))}
                {" · "}{item.induction_time ? item.induction_time.slice(0, 5) : "Time to be confirmed"}
              </p>
            </div>
            <span className={`status-pill ${statusStyles[item.status]}`}>{statusLabels[item.status]}</span>
          </div>
          {item.status !== "CANCELLED" && <SiteLocationLinks item={item} />}
        </article>)}
      </section>
      : <section className="panel empty-state">
        <ClipboardList size={30} />
        <strong>No site inductions assigned</strong>
        <span>Your induction details will appear here once the office schedules them.</span>
      </section>}
  </>;
}
