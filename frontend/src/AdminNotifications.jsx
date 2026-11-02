import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bell, CalendarDays, Check, ChevronLeft, ChevronRight, ExternalLink, Search } from "lucide-react";
import CheckUpdatesButton from "./CheckUpdatesButton";
import { inboxPath, notificationAction, notificationCategories } from "./notificationInbox";
import "./notificationInbox.css";

export default function AdminNotifications({ api, onNavigate }) {
  const [category, setCategory] = useState("ALL"), [view, setView] = useState("ALL"), [search, setSearch] = useState(""), [searchInput, setSearchInput] = useState(""), [page, setPage] = useState(1);
  const [data, setData] = useState(null), [loadedPath, setLoadedPath] = useState(""), [loading, setLoading] = useState(true), [error, setError] = useState(""), [marking, setMarking] = useState(null);
  const request = useRef(0);
  const path = inboxPath({ category, view, search, page });
  const load = async () => {
    const current = ++request.current; setLoading(true); setError("");
    try { const result = await api(path, { silentLoading: true }); if (current === request.current) { setData(result); setLoadedPath(path); } }
    catch (err) { if (current === request.current) setError(err.message); }
    finally { if (current === request.current) setLoading(false); }
  };
  useEffect(() => { load(); return () => { request.current++; }; }, [path]);
  const filter = (setter, value) => { setPage(1); setter(value); };
  const markRead = async (item) => {
    setMarking(item.id); setError("");
    try {
      await api(`/notifications/${item.id}/mark_read/`, { method: "POST", body: "{}", silentLoading: true, silentToast: true });
      window.dispatchEvent(new Event("rota:notifications-changed"));
      if (page > 1 && data.results.length === 1 && view !== "ALL") setPage((value) => value - 1);
      else await load();
    } catch (err) { setError(err.message); } finally { setMarking(null); }
  };
  const summary = data?.summary || { total: 0, unread: 0, urgent: 0, categories: [] };
  const currentData = loadedPath === path ? data : null;
  const categoryCounts = new Map(summary.categories.map((item) => [item.key, item]));
  return <>
    <div className="page-heading"><div><p className="eyebrow">OFFICE INBOX</p><h2>Notifications</h2><p className="muted">Review urgent exceptions, pending approvals and updates by category.</p></div><CheckUpdatesButton api={api} paths={path} currentData={data} onUpdate={(result) => { setData(result); setLoadedPath(path); setError(""); }} setError={setError} disabled={loading || Boolean(marking)} /></div>
    {error && <p className="error page-error" role="alert">{error}</p>}
    <section className="panel admin-notification-controls" aria-label="Notification filters">
      <div className="admin-inbox-tabs" role="group" aria-label="Notification view">{[["ALL", "All", summary.total], ["UNREAD", "Unread", summary.unread], ["URGENT", "Urgent", summary.urgent]].map(([key, label, count]) => <button type="button" key={key} disabled={Boolean(marking)} aria-pressed={view === key} className={view === key ? "selected" : ""} onClick={() => filter(setView, key)}>{key === "URGENT" ? <AlertTriangle size={16} /> : <Bell size={16} />}{label}<span>{count}</span></button>)}</div>
      <form className="admin-inbox-search" onSubmit={(event) => { event.preventDefault(); filter(setSearch, searchInput.trim()); }}><div className="search-box"><Search size={17} /><input disabled={Boolean(marking)} aria-label="Search notifications" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search guard name, site or alert…" /></div><button disabled={Boolean(marking)} className="secondary-button" type="submit">Search</button></form>
      <div className="admin-inbox-categories" role="group" aria-label="Notification categories"><button type="button" disabled={Boolean(marking)} aria-pressed={category === "ALL"} onClick={() => filter(setCategory, "ALL")}><strong>All categories</strong><span>{summary.unread} unread</span></button>{notificationCategories.map((item) => <button type="button" key={item.key} disabled={Boolean(marking)} aria-pressed={category === item.key} onClick={() => filter(setCategory, item.key)}><strong>{item.label}</strong><span>{categoryCounts.get(item.key)?.unread || 0} unread</span></button>)}</div>
    </section>
    <section className="panel admin-notification-list" aria-busy={loading}>
      <div className="panel-header"><div><h3>{category === "ALL" ? "All notifications" : notificationCategories.find((item) => item.key === category)?.label}</h3><p className="muted">{view === "URGENT" ? "Unread alerts requiring urgent attention." : "Newest updates first. Mark an alert read once reviewed."}</p></div><span className="muted">{loading ? "Updating…" : `${currentData?.pagination.total || 0} alerts`}</span></div>
      {loading && !currentData ? <div className="empty-state" role="status">Loading notifications…</div> : !currentData?.results?.length ? <div className="empty-state"><Check size={28} /><strong>{error ? "Notifications could not be loaded" : view === "URGENT" ? "No urgent unread alerts" : "No matching notifications"}</strong><span>{error ? "Use Check updates to try again." : "New alerts in this category will appear here."}</span></div> : currentData.results.map((item) => {
        const action = notificationAction(item), context = item.context || {};
        return <article key={item.id} className={`admin-notification-card ${item.is_read ? "read" : "unread"} ${item.priority === "URGENT" ? "urgent" : ""}`}>
          <div className="admin-alert-icon" aria-hidden="true">{item.priority === "URGENT" ? <AlertTriangle size={20} /> : <Bell size={20} />}</div>
          <div className="admin-alert-body"><div className="admin-alert-labels"><span>{item.category_label || notificationCategories.find((category) => category.key === item.category)?.label || "System & Integrations"}</span>{item.priority === "URGENT" && <b>Urgent</b>}{!item.is_read && <em>Unread</em>}</div><h4>{item.title}</h4><p>{item.message}</p>{(context.employee_name || context.site_name || context.event_date) && <div className="admin-alert-context">{context.employee_name && <strong>{context.employee_name}{context.employee_id ? ` · ${context.employee_id}` : ""}</strong>}{context.site_name && <span>{context.site_name}</span>}{context.event_date && <span><CalendarDays size={13} />{context.event_date}</span>}</div>}<time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time><div className="admin-alert-actions">{action && <button type="button" className="mini-button" disabled={loading || Boolean(marking)} onClick={() => onNavigate(action.page, action.context)}>{action.label}<ExternalLink size={13} /></button>}{!item.is_read && <button type="button" className="mini-button approve" disabled={loading || Boolean(marking)} onClick={() => markRead(item)}><Check size={13} />{marking === item.id ? "Saving…" : "Mark read"}</button>}</div></div>
        </article>;
      })}
      {currentData && data.pagination.total_pages > 1 && <div className="pagination-bar"><span>Page {data.pagination.page} of {data.pagination.total_pages}</span><div><button type="button" className="secondary-button" disabled={loading || Boolean(marking) || !data.pagination.has_previous} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={15} />Previous</button><button type="button" className="secondary-button" disabled={loading || Boolean(marking) || !data.pagination.has_next} onClick={() => setPage((value) => value + 1)}>Next<ChevronRight size={15} /></button></div></div>}
    </section>
  </>;
}
