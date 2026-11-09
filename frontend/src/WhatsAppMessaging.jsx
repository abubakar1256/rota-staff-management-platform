import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Search } from "lucide-react";
import { formatUkDateTime } from "./ukTime";
import "./whatsappMessaging.css";

const statusLabels = {
  PENDING: "Pending",
  UPDATE_PENDING: "Update pending",
  SENT: "Sent",
  NUMBER_MISSING: "WhatsApp number missing",
  INACTIVE: "Guard inactive",
};

function RecipientQueue({ rows, onMarkSent, busyId, title }) {
  const [filter, setFilter] = useState("PENDING");
  const [search, setSearch] = useState("");
  const sent = rows.filter((row) => row.status === "SENT").length;
  const next = rows.find((row) => row.whatsapp_url);
  const term = search.trim().toLowerCase();
  const visible = rows.filter((row) => (
    (filter === "ALL" || (filter === "SENT" ? row.status === "SENT" : row.status !== "SENT"))
    && `${row.name} ${row.code}`.toLowerCase().includes(term)
  ));

  return <section className="whatsapp-queue" aria-label={title}>
    <div className="whatsapp-queue-heading">
      <div><h3>{title}</h3><p className="muted">Send in WhatsApp, then mark the message as sent here.</p></div>
      <strong aria-live="polite">{sent} of {rows.length} marked sent</strong>
    </div>
    <div className="whatsapp-toolbar">
      <label className="search-box"><Search size={16} /><input aria-label="Search recipients" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search guard or ID" /></label>
      <label>Show <select value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="PENDING">Pending ({rows.length - sent})</option>
        <option value="SENT">Sent ({sent})</option>
        <option value="ALL">All ({rows.length})</option>
      </select></label>
    </div>
    {next && <p className="whatsapp-next">Next ready to send <strong>{next.name}</strong></p>}
    {visible.length ? <ul className="whatsapp-recipients">
      {visible.map((row) => <li key={row.id}>
        <div>
          <strong>{row.name}</strong>
          <small className="table-subtext">{row.code}</small>
          {row.sent_at && <small className="table-subtext">
            {row.status === "SENT" ? "Marked sent" : "Last marked sent"} {formatUkDateTime(row.sent_at)}
            {row.sent_by && ` by ${row.sent_by}`}
          </small>}
        </div>
        <span className={`status-pill ${row.status === "SENT" ? "active" : "pending"}`}>{statusLabels[row.status]}</span>
        {row.whatsapp_url && <div className="whatsapp-recipient-actions">
          <a className="mini-button" href={row.whatsapp_url} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={14} /> {row.status === "UPDATE_PENDING" ? "Send updated rota" : "Open in WhatsApp"}
          </a>
          <button type="button" className="mini-button" onClick={() => onMarkSent(row)} disabled={busyId !== null}>
            {busyId === row.id ? "Saving…" : row.status === "UPDATE_PENDING" ? "Mark update as sent" : "Mark as sent"}
          </button>
        </div>}
        {row.message && <details className="whatsapp-message-preview">
          <summary>Preview message</summary>
          <p>{row.message}</p>
        </details>}
      </li>)}
    </ul> : <p className="muted whatsapp-empty">{rows.length ? "No guards match this view." : "No guards to share with."}</p>}
  </section>;
}

function useMarkSent(api, endpoint, queryKey, onConfirmed) {
  const client = useQueryClient();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  async function markSent(row) {
    setBusyId(row.id);
    setError("");
    try {
      const updated = await api(`${endpoint}guards/${row.id}/mark-sent/`, {
        method: "POST", body: JSON.stringify({ version: row.version }),
        silentToast: true, silentError: true,
      });
      client.setQueryData(queryKey, (data) => data && {
        ...data, recipients: data.recipients.map((item) => item.id === row.id ? updated : item),
      });
      onConfirmed?.();
    } catch (requestError) {
      setError(requestError.message);
      if (requestError.status === 409) void client.invalidateQueries({ queryKey, exact: true });
    } finally {
      setBusyId(null);
    }
  }
  return { busyId, error, markSent };
}

function AnnouncementQueue({ api, announcementId, refreshHistory }) {
  const endpoint = `/whatsapp/announcements/${announcementId}/`;
  const queryKey = ["whatsapp", "announcement", announcementId];
  const queue = useQuery({ queryKey, queryFn: () => api(endpoint, { silentError: true }) });
  const { busyId, error, markSent } = useMarkSent(api, endpoint, queryKey, refreshHistory);
  if (queue.isPending) return <p role="status" className="muted">Loading recipients…</p>;
  if (queue.isError) return <p role="alert" className="error">{queue.error.message} <button className="mini-button" onClick={() => queue.refetch()}>Retry</button></p>;
  return <>
    <details className="whatsapp-message-preview"><summary>Announcement message</summary><p>{queue.data.message}</p></details>
    {error && <p className="error" role="alert">{error}</p>}
    <RecipientQueue rows={queue.data.recipients} onMarkSent={markSent} busyId={busyId} title={queue.data.title} />
  </>;
}

export function StaffAnnouncements({ api }) {
  const [announcementId, setAnnouncementId] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const history = useQuery({ queryKey: ["whatsapp", "announcements"], queryFn: () => api("/whatsapp/announcements/", { silentError: true }) });
  const guards = useQuery({ queryKey: ["whatsapp", "guards"], queryFn: () => api("/whatsapp/guards/", { silentError: true }), enabled: !announcementId });
  const eligible = guards.data || [];
  const selectedIds = new Set(selected);
  const term = search.trim().toLowerCase();
  const visible = eligible.filter((guard) => `${guard.name} ${guard.code}`.toLowerCase().includes(term));

  async function createAnnouncement(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const created = await api("/whatsapp/announcements/", {
        method: "POST", body: JSON.stringify({ title, message, employee_ids: selected }),
        silentToast: true, silentError: true,
      });
      setTitle("");
      setMessage("");
      setSelected([]);
      setSearch("");
      setAnnouncementId(String(created.id));
      void history.refetch();
    } catch (requestError) {
      setError(requestError.message);
      if (requestError.status === 409) {
        const refreshed = await guards.refetch();
        if (refreshed.data) {
          const active = new Set(refreshed.data.map((guard) => guard.id));
          setSelected((ids) => ids.filter((id) => active.has(id)));
        }
      }
    } finally {
      setSaving(false);
    }
  }

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">WHATSAPP</p><h2>Staff Announcements</h2><p className="muted">Write one message and open each selected guard's chat in turn.</p></div>
    </div>
    <section className="panel whatsapp-panel">
      <div className="whatsapp-history">
        <label>Saved announcements <select value={announcementId} onChange={(event) => setAnnouncementId(event.target.value)} disabled={saving}>
          <option value="">New announcement</option>
          {(history.data || []).map((row) => <option key={row.id} value={row.id}>{row.title} · {row.sent}/{row.total} marked sent · {formatUkDateTime(row.created_at)}</option>)}
        </select></label>
        {history.isError && <p role="alert" className="error">{history.error.message} <button className="mini-button" onClick={() => history.refetch()}>Retry</button></p>}
      </div>
      {announcementId ? <AnnouncementQueue key={announcementId} api={api} announcementId={announcementId} refreshHistory={() => history.refetch()} /> : <form className="whatsapp-compose" onSubmit={createAnnouncement}>
        <label>Announcement title <input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Office reference" disabled={saving} /></label>
        <label>WhatsApp message <textarea required rows={5} maxLength={1500} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write the message all selected guards will receive…" disabled={saving} /></label>
        <div className="whatsapp-toolbar">
          <label className="search-box"><Search size={16} /><input aria-label="Search guards" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search guard or ID" /></label>
          <button className="secondary-button" type="button" onClick={() => setSelected(eligible.map((guard) => guard.id))} disabled={saving || !eligible.length}>Select all guards</button>
          <button className="mini-button" type="button" onClick={() => setSelected([])} disabled={saving || !selected.length}>Clear selection</button>
        </div>
        {guards.isPending ? <p role="status" className="muted">Loading guards…</p>
          : guards.isError ? <p role="alert" className="error">{guards.error.message} <button type="button" className="mini-button" onClick={() => guards.refetch()}>Retry</button></p>
          : visible.length ? <div className="whatsapp-guard-options" aria-label="Active guards">
            {visible.map((guard) => <label key={guard.id}>
              <input type="checkbox" checked={selectedIds.has(guard.id)} disabled={saving} onChange={(event) => {
                const checked = event.target.checked;
                setSelected((ids) => checked ? [...ids, guard.id] : ids.filter((id) => id !== guard.id));
              }} />
              <span><strong>{guard.name}</strong> <small>{guard.code}{!guard.has_whatsapp && " · WhatsApp number missing"}</small></span>
            </label>)}
          </div> : <p className="muted">No active guards match your search.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="whatsapp-toolbar">
          <strong aria-live="polite">{selected.length} guards selected</strong>
          <button className="primary-button" disabled={saving || !title.trim() || !message.trim() || !selected.length}>
            {saving ? "Saving…" : "Create send list"}
          </button>
        </div>
      </form>}
    </section>
  </>;
}

export function RotaWhatsAppPanel({ api, rota }) {
  const published = rota.status === "PUBLISHED";
  const endpoint = `/whatsapp/rota-weeks/${rota.id}/`;
  const queryKey = ["whatsapp", "rota", rota.id, rota.published_at];
  const queue = useQuery({ queryKey, queryFn: () => api(endpoint, { silentError: true }), enabled: published });
  const { busyId, error, markSent } = useMarkSent(api, endpoint, queryKey);

  return <section className="panel whatsapp-panel" id="rota-sharing" aria-labelledby="rota-sharing-title">
    <div className="whatsapp-queue-heading">
      <div><p className="eyebrow">WHATSAPP</p><h3 id="rota-sharing-title">Rota Sharing</h3>
        <p className="muted">Share each guard's published shifts. Changed schedules appear as Update pending.</p></div>
      {published && <button className="mini-button" disabled={queue.isFetching} onClick={() => queue.refetch()}>Refresh sharing list</button>}
    </div>
    {!published || queue.data?.published === false
      ? <p className="muted">Publish the rota to share the latest shifts.</p>
      : queue.isPending ? <p className="muted" role="status">Loading sharing list…</p>
        : queue.isError ? <p className="error" role="alert">{queue.error.message}</p>
          : <>
            {error && <p className="error" role="alert">{error}</p>}
            <RecipientQueue rows={queue.data.recipients} onMarkSent={markSent} busyId={busyId} title="Guards this week" />
          </>}
  </section>;
}
