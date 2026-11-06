import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Clock3, LogOut, UserPlus, Users } from "lucide-react";
import { formatUkDateTime } from "./ukTime";
import "./controlTeam.css";

const root = "/control";
const profilePath = root + "/profile/";
const teamPath = root + "/team/";
const requestsPath = root + "/requests/";
const officeRequestsPath = teamPath + "requests/";
const queryKey = (path) => ["rota", "control", path];
const requestOptions = (method, data) => ({ method, body: JSON.stringify(data) });

function useControlQuery(api, path, enabled = true) {
  return useQuery({
    queryKey: queryKey(path),
    queryFn: () => api(path, { silentLoading: true, silentError: true }),
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

function duration(seconds) {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

function QueryStatus({ query, label }) {
  if (query.error) return <div className="panel control-actions">
    <p className="error" role="alert">{query.error.message}</p>
    <button type="button" className="secondary-button" onClick={() => query.refetch()}>Try again</button>
  </div>;
  return query.isPending ? <div className="panel" role="status">Loading {label}…</div> : null;
}

function Avatar({ member, Photo, large }) {
  return <div className={large ? "control-avatar control-avatar-large" : "control-avatar"} aria-hidden="true">
    <span>{member.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
    {member.photo_url && <Photo src={member.photo_url} alt="" />}
  </div>;
}

function MemberStatus({ member }) {
  if (!member.is_active) return <span className="status-pill inactive">Inactive</span>;
  if (member.checked_in_at) return <span className="status-pill active">Checked in</span>;
  return <span className="status-pill neutral">Checked out</span>;
}

function Metric({ icon: Icon, label, value, detail }) {
  return <article className="stat-card blue">
    <div className="stat-icon"><Icon size={17} aria-hidden="true" /></div>
    <p>{label}</p><strong>{value}</strong>{detail && <small>{detail}</small>}
  </article>;
}

function AttendanceHistory({ member }) {
  return <section className="panel">
    <h3>Attendance history</h3>
    <p className="muted">Latest 50 entries · UK time</p>
    {member.attendance.length ? <div className="table-wrap control-table-wrap"><table className="control-table">
      <thead><tr><th scope="col">Check in</th><th scope="col">Check out</th><th scope="col">Duration</th></tr></thead>
      <tbody>{member.attendance.map((entry) => <tr key={entry.id}>
        <td>{formatUkDateTime(entry.checked_in_at)}</td>
        <td>{entry.checked_out_at ? formatUkDateTime(entry.checked_out_at) : "In progress"}
          {entry.closed_by_admin && <small className="table-subtext">Closed by admin</small>}
        </td>
        <td>{entry.checked_out_at ? duration((Date.parse(entry.checked_out_at) - Date.parse(entry.checked_in_at)) / 1000) : "—"}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted control-empty">No attendance recorded yet.</p>}
  </section>;
}

function ProfileForm({ member, api, Photo, onSaved, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!form.get("photo")?.size) form.delete("photo");
    setBusy(true);
    setError("");
    try { onSaved(await api(profilePath, { method: "PUT", body: form, silentError: true })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-header">
      <div><h3>My profile</h3><p className="muted">Save your name, phone number and profile photo to reach 100%.</p></div>
      <span className={member.profile_complete ? "status-pill active" : "status-pill on_leave"}>
        {member.profile_complete ? "100% complete" : "Profile incomplete"}
      </span>
    </div>
    <form className="control-form" onSubmit={submit}>
      <div className="control-profile-photo">
        <Avatar member={member} Photo={Photo} large />
        <label>Profile photo <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required={!member.photo_url} />
          <small>JPG, PNG or WebP · Up to 10 MB</small>
        </label>
      </div>
      <div className="control-form-grid">
        <label>Full name<input name="name" defaultValue={member.name} required maxLength={160} autoComplete="name" /></label>
        <label>Phone number<input name="phone" type="tel" defaultValue={member.phone} required maxLength={40} autoComplete="tel" /></label>
        <label>Login email<input type="email" value={member.email} readOnly /></label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="control-actions">
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
        {onCancel && <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>}
      </div>
    </form>
  </section>;
}

function RequestForm({ api }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    setError("");
    setBusy(true);
    try {
      await api(requestsPath, { ...requestOptions("POST", Object.fromEntries(new FormData(form))), silentError: true });
      form.reset();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <h3>Send a request</h3>
    <p className="muted">Request leave or ask the office to arrange cover.</p>
    <form className="control-form" onSubmit={submit}>
      <div className="control-form-grid">
        <label>Request type<select name="kind"><option value="LEAVE">Leave</option><option value="REPLACEMENT">Replacement</option></select></label>
        <label>From<input type="date" name="start_date" required /></label>
        <label>To<input type="date" name="end_date" required /></label>
      </div>
      <label>Reason<textarea name="reason" rows={3} required maxLength={1000} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary-button" disabled={busy}>{busy ? "Sending…" : "Send request"}</button>
    </form>
  </section>;
}

function RequestCard({ request, api, office }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = request.status === "PENDING";
  const requestType = request.kind === "LEAVE" ? "Leave" : "Replacement";
  async function review(event) {
    event.preventDefault();
    const reviewNote = new FormData(event.currentTarget).get("review_note");
    const status = event.nativeEvent.submitter.value;
    setError("");
    setBusy(true);
    try { await api(officeRequestsPath + request.id + "/", { ...requestOptions("PATCH", { status, review_note: reviewNote }), silentError: true }); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <article className="control-request">
    <div className="control-between">
      <strong>{office ? request.member_name + " · " + requestType : requestType}</strong>
      <span className={"status-pill " + (pending ? "on_leave" : request.status === "APPROVED" ? "active" : "inactive")}>{request.status.toLowerCase()}</span>
    </div>
    <p className="muted">{request.start_date} to {request.end_date}</p>
    <p className="control-reason">{request.reason}</p>
    {request.review_note && <p className="control-reason"><strong>Office note</strong><br />{request.review_note}</p>}
    {office && pending && <form className="control-form" onSubmit={review}>
      <label>Office note (optional)<textarea name="review_note" rows={2} maxLength={1000} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="control-actions">
        <button type="submit" value="APPROVED" className="primary-button" disabled={busy}>Approve</button>
        <button type="submit" value="REJECTED" className="secondary-button" disabled={busy}>Reject</button>
      </div>
    </form>}
  </article>;
}

function RequestList({ query, office, api }) {
  if (!query.data) return <QueryStatus query={query} label="requests" />;
  const items = [...query.data].sort((a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING"));
  return <section className="panel">
    <div className="panel-header">
      <div><h3>{office ? "Leave and replacement requests" : "My requests"}</h3><p className="muted">Pending requests appear first.</p></div>
    </div>
    {items.length ? <div className="control-stack">{items.map((request) => <RequestCard key={request.id} request={request} api={api} office={office} />)}</div> : <p className="muted">No requests yet.</p>}
  </section>;
}

function ControlTabs({ tabs, page, onChange, label }) {
  return <nav className="control-tabs" aria-label={label}>
    {tabs.map(([id, title]) => <button type="button" key={id} className="secondary-button" aria-pressed={page === id} onClick={() => onChange(id)}>{title}</button>)}
  </nav>;
}

export function ControlPortal({ api, Photo, onSignOut }) {
  const [page, setPage] = useState("attendance");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const client = useQueryClient();
  const profile = useControlQuery(api, profilePath);
  const member = profile.data;
  const requests = useControlQuery(api, requestsPath, Boolean(member?.profile_complete && page === "requests"));
  const activePage = member?.profile_complete ? page : "profile";
  const saveProfile = (data) => {
    client.setQueryData(queryKey(profilePath), data);
    setPage("attendance");
  };
  async function markAttendance() {
    setError("");
    setBusy(true);
    try {
      const action = member.checked_in_at ? "check_out" : "check_in";
      const updated = await api(root + "/attendance/", { ...requestOptions("POST", { action }), silentError: true });
      client.setQueryData(queryKey(profilePath), updated);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="client-portal-shell">
    <header className="client-portal-header control-header">
      <div className="sidebar-brand"><div className="brand-lockup"><img className="brand-logo" src="/branding/rotaops-logo.jpg" alt="RotaOps" /></div></div>
      <div className="client-portal-user"><strong>{member?.name}</strong><button type="button" className="logout-button" onClick={onSignOut}><LogOut size={15} /> Sign out</button></div>
    </header>
    <main className="client-portal-content control-stack">
      <div><p className="eyebrow">STAFF PORTAL</p><h1 className="control-title">Control Team</h1><p className="muted">Your attendance, hours and requests.</p></div>
      {!member ? <QueryStatus query={profile} label="your profile" /> : <>
        {member.profile_complete && <ControlTabs label="Control Team portal" page={activePage} onChange={setPage}
          tabs={[["attendance", "Attendance"], ["requests", "Leave & replacement"], ["profile", "My profile"]]} />}
        {activePage === "profile" && <ProfileForm member={member} api={api} Photo={Photo} onSaved={saveProfile} onCancel={member.profile_complete ? () => setPage("attendance") : null} />}
        {activePage === "attendance" && <>
          <section className="panel control-attendance-card">
            <div className="control-identity"><Avatar member={member} Photo={Photo} /><div>
              <h3>{member.name}</h3><MemberStatus member={member} />
              {member.checked_in_at && <p className="muted control-since">Since {formatUkDateTime(member.checked_in_at)}</p>}
            </div></div>
            <button type="button" className="primary-button" disabled={busy} onClick={markAttendance}>{busy ? "Saving…" : member.checked_in_at ? "Check Out" : "Check In"}</button>
            {error && <p className="error" role="alert">{error}</p>}
          </section>
          <div className="control-metrics">
            <Metric icon={Clock3} label="This week" value={duration(member.weekly_seconds)} detail="Monday to Sunday · UK time" />
            <Metric icon={CalendarDays} label="This month" value={duration(member.monthly_seconds)} detail="Calendar month · UK time" />
          </div>
          <AttendanceHistory member={member} />
        </>}
        {activePage === "requests" && <><RequestForm api={api} /><RequestList query={requests} api={api} /></>}
      </>}
    </main>
  </div>;
}

function AddMemberForm({ api, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const member = await api(teamPath, { ...requestOptions("POST", Object.fromEntries(new FormData(event.currentTarget))), silentError: true });
      onClose(member);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <h3>Add Control Team member</h3>
    <p className="muted">Share the login details securely with the new member. They can sign in at /control and finish their profile.</p>
    <form className="control-form" onSubmit={submit}>
      <div className="control-form-grid">
        <label>Full name<input name="name" required maxLength={160} /></label>
        <label>Login email<input name="email" type="email" required maxLength={150} /></label>
        <label>Initial password<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /><small>At least 12 characters</small></label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="control-actions">
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Adding…" : "Add member"}</button>
        <button type="button" className="secondary-button" onClick={() => onClose()} disabled={busy}>Cancel</button>
      </div>
    </form>
  </section>;
}

function MemberDetail({ member, api, onClose }) {
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  async function toggleStatus() {
    if (member.is_active && !window.confirm(member.checked_in_at
      ? "Deactivate this member and close their current attendance entry now?"
      : "Deactivate this member's Control Team access?")) return;
    setBusy(true);
    const path = teamPath + member.id + "/";
    try {
      const updated = await api(path, requestOptions("PATCH", { is_active: !member.is_active }));
      client.setQueryData(queryKey(path), updated);
    } catch { /* API displays the error */ }
    finally { setBusy(false); }
  }
  return <>
    <section className="panel control-between">
      <div><h3>{member.name}</h3><p className="muted">{member.email}{member.phone && " · " + member.phone}</p></div>
      <div className="control-actions">
        <button type="button" className={member.is_active ? "secondary-button control-deactivate" : "secondary-button"} disabled={busy} onClick={toggleStatus}>{member.is_active ? "Deactivate" : "Reactivate"}</button>
        <button type="button" className="secondary-button" onClick={onClose}>Close details</button>
      </div>
    </section>
    <AttendanceHistory member={member} />
  </>;
}

export function ControlTeamAdmin({ api, Photo }) {
  const [page, setPage] = useState("team");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(null);
  const team = useControlQuery(api, teamPath, page === "team");
  const detail = useControlQuery(api, teamPath + selected + "/", Boolean(selected && page === "team"));
  const requests = useControlQuery(api, officeRequestsPath, page === "requests");
  const members = [...(team.data || [])].sort((a, b) => Number(Boolean(b.checked_in_at)) - Number(Boolean(a.checked_in_at)) || Number(b.is_active) - Number(a.is_active));
  const checkedIn = members.filter((member) => member.is_active && member.checked_in_at).length;
  return <div className="control-stack">
    <header className="page-heading control-office-heading">
      <div><p className="eyebrow">PEOPLE MANAGEMENT</p><h2>Control Team</h2><p className="muted">Manage team access, attendance and requests.</p></div>
      <div className="control-actions">
        <a className="secondary-button" href="/control" target="_blank" rel="noopener noreferrer">Open /control</a>
        <button type="button" className="primary-button" onClick={() => { setPage("team"); setAdding(true); }}><UserPlus size={16} /> Add member</button>
      </div>
    </header>
    <ControlTabs label="Control Team management" page={page} onChange={setPage} tabs={[["team", "Members & attendance"], ["requests", "Leave & replacement"]]} />
    {page === "requests" ? <RequestList query={requests} api={api} office /> : <>
      {adding && <AddMemberForm api={api} onClose={(member) => { setAdding(false); if (member) setSelected(member.id); }} />}
      {!team.data ? <QueryStatus query={team} label="team members" /> : <>
        <div className="control-metrics">
          <Metric icon={Users} label="Active members" value={members.filter((member) => member.is_active).length} />
          <Metric icon={Clock3} label="Checked in now" value={checkedIn} />
        </div>
        <section className="panel">
          <div className="panel-header"><div><h3>Members</h3><p className="muted">Checked-in members appear first. Current hours include time worked since check-in.</p></div></div>
          {members.length ? <div className="control-member-list">{members.map((member) => <Fragment key={member.id}><article className="control-member">
            <div className="control-identity"><Avatar member={member} Photo={Photo} /><div>
              <strong>{member.name}</strong>
              <p className="muted">{member.profile_complete ? member.email : "Profile setup pending"}</p>
            </div></div>
            <div><MemberStatus member={member} />{member.checked_in_at && <small className="table-subtext">{formatUkDateTime(member.checked_in_at)}</small>}</div>
            <div className="control-member-hours"><span><small>This week</small><strong>{duration(member.weekly_seconds)}</strong></span><span><small>This month</small><strong>{duration(member.monthly_seconds)}</strong></span></div>
            <button type="button" className="secondary-button" aria-pressed={selected === member.id} onClick={() => setSelected(selected === member.id ? null : member.id)}>View details</button>
          </article>
          {selected === member.id && (detail.data ? <MemberDetail member={detail.data} api={api} onClose={() => setSelected(null)} /> : <QueryStatus query={detail} label="member details" />)}
          </Fragment>)}</div> : <p className="muted">No Control Team members yet.</p>}
        </section>
      </>}
    </>}
  </div>;
}
