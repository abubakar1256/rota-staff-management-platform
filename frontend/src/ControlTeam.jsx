import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Camera, Clock3, LogOut, MapPin, UserPlus, Users } from "lucide-react";
import { readCurrentLocation } from "./attendanceGeofence";
import { googleSiteLinks, sitePoint } from "./siteCoordinates";
import { formatUkAttendanceTime, formatUkDateTime, ukDate } from "./ukTime";
import "./controlTeam.css";

const root = "/control";
const profilePath = root + "/profile/";
const settingsPath = root + "/attendance/settings/";
const teamPath = root + "/team/";
const assignmentsPath = teamPath + "assignments/";
const requestsPath = root + "/requests/";
const officeRequestsPath = teamPath + "requests/";
const queryKey = (path) => ["rota", "control", path];
const requestOptions = (method, data) => ({ method, body: JSON.stringify(data) });
const shiftNames = { M: "Morning", D: "Mid-day", E: "Evening", N: "Night" };

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

function LateBadge({ minutes }) {
  return minutes > 0 && <span className="status-pill pending">Late · {minutes} min</span>;
}

function LocationLink({ location, label }) {
  const point = sitePoint(location?.latitude, location?.longitude);
  if (!point) return null;
  return <a className="file-link-button" href={googleSiteLinks(point).map} target="_blank" rel="noopener noreferrer">
    <MapPin size={13} aria-hidden="true" />{label}
  </a>;
}

function AttendanceEvidence({ photoUrl, location, label, FilePreview }) {
  if (!photoUrl && !location) return null;
  return <div className="control-attendance-proof">
    {photoUrl && <FilePreview value={photoUrl} label={label + " photo"} buttonLabel="View photo" />}
    {location && <div><LocationLink location={location} label="View GPS" /><small className="table-subtext">
      {location.distance_m} m from pin{location.radius_m && ` · ${location.radius_m} m radius`} · GPS ±{Math.round(location.accuracy_m)} m
    </small></div>}
  </div>;
}

function ShiftDetails({ entry }) {
  if (!entry?.shift_name) return null;
  return <small className="table-subtext">
    {entry.shift_name} · {formatUkAttendanceTime(entry.scheduled_start_at)} – {formatUkAttendanceTime(entry.scheduled_end_at)}
  </small>;
}

function AttendanceHistory({ member, FilePreview }) {
  return <section className="panel">
    <h3>Attendance history</h3>
    <p className="muted">Latest 50 entries · UK time</p>
    {member.attendance.length ? <div className="table-wrap control-table-wrap"><table className="control-table">
      <thead><tr><th scope="col">Check in</th><th scope="col">Check out</th><th scope="col">Duration</th></tr></thead>
      <tbody>{member.attendance.map((entry) => <tr key={entry.id}>
        <td>{formatUkDateTime(entry.checked_in_at)}
          <ShiftDetails entry={entry} />
          <LateBadge minutes={entry.late_minutes} />
          <AttendanceEvidence photoUrl={entry.check_in_photo_url} location={entry.check_in_location} label="Check-in" FilePreview={FilePreview} />
        </td>
        <td>{entry.checked_out_at ? formatUkDateTime(entry.checked_out_at) : "In progress"}
          {entry.closed_by_admin && <small className="table-subtext">Closed by admin</small>}
          {entry.auto_checked_out && <small className="table-subtext">Automatic checkout</small>}
          <AttendanceEvidence photoUrl={entry.check_out_photo_url} location={entry.check_out_location} label="Check-out" FilePreview={FilePreview} />
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

function AttendanceCamera({ onCapture }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let stream;
    const video = videoRef.current;
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "user" } }, audio: false });
        if (active) video.srcObject = stream;
        else stream.getTracks().forEach((track) => track.stop());
      } catch {
        if (active) setError("Camera unavailable. Allow camera access and try again.");
      }
    }
    start();
    return () => {
      active = false;
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
  }, [attempt]);

  function capture() {
    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) return;
    setReady(false);
    setError("");
    const scale = Math.min(1, 1000 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) onCapture(blob);
      else {
        setError("Could not capture the photo. Try again.");
        setReady(true);
      }
    }, "image/jpeg", 0.88);
  }

  return <>
    <video ref={videoRef} autoPlay muted playsInline aria-label="Live camera preview" className="camera-preview" onPlaying={() => setReady(true)} />
    {!ready && !error && <p className="muted" role="status">Preparing camera…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="control-actions">
      {error && !ready ? <button type="button" className="secondary-button" onClick={() => { setError(""); setAttempt(attempt + 1); }}>Retry camera</button> :
        <button type="button" className="primary-button" disabled={!ready} onClick={capture}><Camera size={16} /> Take photo</button>}
    </div>
  </>;
}

function AttendanceCapture({ action, onClose, onSubmit }) {
  const dialogRef = useRef(null);
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const label = action === "check_out" ? "Check Out" : "Check In";

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function submit() {
    setBusy("Getting GPS…");
    setError("");
    try {
      const location = await readCurrentLocation();
      setBusy("Saving…");
      await onSubmit(photo, location);
    }
    catch (err) {
      setError(err.message);
      setStale(err.status === 409);
    } finally { setBusy(""); }
  }

  return <dialog ref={dialogRef} className="modal-card camera-modal control-capture" aria-labelledby="control-capture-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h3 id="control-capture-title">{label} photo</h3>
    {photo ? <>
      {preview && <img src={preview} alt={label + " photo preview"} className="camera-preview" />}
      <p className="muted">Allow precise location when you confirm.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="control-actions">
        <button type="button" className="primary-button" disabled={Boolean(busy) || stale} onClick={submit}>{busy || `Confirm ${label}`}</button>
        <button type="button" className="secondary-button" disabled={busy || stale} onClick={() => { setPhoto(null); setPreview(""); setError(""); }}>Retake</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{stale ? "Close" : "Cancel"}</button>
      </div>
    </> : <>
      <AttendanceCamera onCapture={setPhoto} />
      <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
    </>}
  </dialog>;
}

function AssignedShifts({ shifts, canCheckIn, onCheckIn }) {
  return <section className="panel">
    <div className="panel-header"><div><h3>My shifts</h3><p className="muted">Next 7 days · UK time</p></div></div>
    {shifts.length ? <div className="control-member-list">{shifts.map((shift) => <article className="control-member" key={shift.id}>
      <div><strong>{shift.shift_name}</strong>
        <small className="table-subtext">{formatUkDateTime(shift.scheduled_start_at)} – {formatUkDateTime(shift.scheduled_end_at)}</small>
      </div>
      <div><span className={`status-pill ${shift.started ? "active" : "neutral"}`}>{shift.status}</span></div>
      {shift.status === "Available" && <button type="button" className="primary-button" disabled={!canCheckIn} onClick={() => onCheckIn(shift.id)}>
        <Camera size={15} aria-hidden="true" /> Check In
      </button>}
    </article>)}</div> : <p className="muted control-empty">No shifts assigned for the next 7 days.</p>}
  </section>;
}

export function ControlPortal({ api, Photo, FilePreview, onSignOut }) {
  const [page, setPage] = useState("attendance");
  const [capture, setCapture] = useState(null);
  const client = useQueryClient();
  const profile = useControlQuery(api, profilePath);
  const member = profile.data;
  const requests = useControlQuery(api, requestsPath, Boolean(member?.profile_complete && page === "requests"));
  const activePage = member?.profile_complete ? page : "profile";
  const settings = useControlQuery(api, settingsPath, Boolean(member?.profile_complete && activePage === "attendance"));
  const office = settings.data;
  const officePin = sitePoint(office?.latitude, office?.longitude);
  const current = member?.attendance.find((entry) => !entry.checked_out_at);
  const saveProfile = (data) => {
    client.setQueryData(queryKey(profilePath), data);
    setPage("attendance");
  };
  async function markAttendance(photo, location) {
    const body = new FormData();
    body.set("action", capture.action);
    body.set("photo", photo, "attendance.jpg");
    if (capture.action === "check_out") body.set("attendance_id", capture.id);
    else body.set("assignment_id", capture.id);
    body.set("latitude", location.latitude);
    body.set("longitude", location.longitude);
    body.set("accuracy_m", location.accuracy);
    try {
      const updated = await api(root + "/attendance/", {
        method: "POST", body, silentError: true, silentLoading: true, skipInvalidation: true,
      });
      await client.cancelQueries({ queryKey: queryKey(profilePath), exact: true });
      client.setQueryData(queryKey(profilePath), updated);
      setCapture(null);
    } catch (err) {
      if (err.status === 409) profile.refetch();
      throw err;
    }
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
              <h3>{member.name}</h3><div className="control-actions"><MemberStatus member={member} /><LateBadge minutes={member.late_minutes} /></div>
              {member.checked_in_at && <p className="muted control-since">Since {formatUkDateTime(member.checked_in_at)}</p>}
              <ShiftDetails entry={current} />
              {current?.auto_checkout_at && <small className="table-subtext">Auto checkout at {formatUkDateTime(current.auto_checkout_at)}</small>}
            </div></div>
            {current && <button type="button" className="primary-button" disabled={!officePin}
              onClick={() => setCapture({ action: "check_out", id: current.id })}>
              <Camera size={16} aria-hidden="true" /> Check Out
            </button>}
            <div className="control-office-location">
              {!office ? <QueryStatus query={settings} label="attendance location" /> : officePin ?
                <div className="control-actions"><LocationLink location={officePin} label="Attendance location" />
                  <span className="muted">{office.address && `${office.address} · `}{office.radius_m} m radius</span></div> :
                <p className="muted">The office needs to set the attendance location.</p>}
            </div>
          </section>
          <AssignedShifts shifts={member.assigned_shifts || []} canCheckIn={Boolean(officePin && !current)}
            onCheckIn={(id) => setCapture({ action: "check_in", id })} />
          <div className="control-metrics">
            <Metric icon={Clock3} label="This week" value={duration(member.weekly_seconds)} detail="Monday to Sunday · UK time" />
            <Metric icon={CalendarDays} label="This month" value={duration(member.monthly_seconds)} detail="Calendar month · UK time" />
          </div>
          <AttendanceHistory member={member} FilePreview={FilePreview} />
          {capture && <AttendanceCapture action={capture.action} onClose={() => setCapture(null)} onSubmit={markAttendance} />}
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

function MemberDetail({ member, api, FilePreview, onClose }) {
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
    <AttendanceHistory member={member} FilePreview={FilePreview} />
  </>;
}

function ShiftAssignmentControls({ api, code, date, assignments, members, onChanged, timingDirty }) {
  const [memberId, setMemberId] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function saveAssignment(removeId) {
    setBusy(true);
    setError("");
    try {
      if (removeId) {
        await api(`${assignmentsPath}${removeId}/`, { method: "DELETE", silentError: true, silentLoading: true });
      } else {
        const path = editingId ? `${assignmentsPath}${editingId}/` : assignmentsPath;
        const fields = editingId ? { member: memberId } : { member: memberId, shift: code, shift_date: date };
        await api(path, { ...requestOptions(editingId ? "PATCH" : "POST", fields), silentError: true, silentLoading: true });
      }
      await onChanged();
      setMemberId("");
      setEditingId(null);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <div className="control-assignment-cell">
    <label>{editingId ? "Reassign to" : "Assign member"}
      <select aria-label={`${shiftNames[code]} member`} value={memberId} disabled={busy} onChange={(event) => setMemberId(event.target.value)}>
        <option value="">Select member</option>
        {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select>
    </label>
    <div className="control-actions">
      <button type="button" className="secondary-button" disabled={busy || !memberId || (timingDirty && !editingId)}
        onClick={() => saveAssignment()}>{editingId ? "Save assignment" : "Assign"}</button>
      {editingId && <button type="button" className="text-button" disabled={busy} onClick={() => { setEditingId(null); setMemberId(""); setError(""); }}>Cancel</button>}
    </div>
    {timingDirty && !editingId && <small className="muted control-assignment-note">Save the new shift timing before assigning.</small>}
    {error && <p className="error control-assignment-note" role="alert">{error}</p>}
    {assignments.length > 0 && <ul className="control-assignment-list">
      {assignments.map((assignment) => <li key={assignment.id}>
        <div><strong>{assignment.member_name}</strong>
          <small className="table-subtext">{formatUkAttendanceTime(assignment.scheduled_start_at)} – {formatUkAttendanceTime(assignment.scheduled_end_at)}{assignment.started && ` · ${assignment.status}`}</small>
        </div>
        {!assignment.started && <div className="control-actions">
          <button type="button" className="text-button" disabled={busy} aria-label={`Edit ${assignment.member_name} assignment`}
            onClick={() => { setEditingId(assignment.id); setMemberId(String(assignment.member)); setError(""); }}>Edit</button>
          <button type="button" className="text-button control-remove-assignment" disabled={busy}
            aria-label={`Remove ${assignment.member_name} assignment`} onClick={() => saveAssignment(assignment.id)}>Remove</button>
        </div>}
      </li>)}
    </ul>}
  </div>;
}

function AttendanceSettingsForm({ settings, api, onSaved, team }) {
  const [draft, setDraft] = useState(settings);
  const [date, setDate] = useState(() => ukDate());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const assignments = useControlQuery(api, `${assignmentsPath}?date=${encodeURIComponent(date)}`, Boolean(date));
  const members = (team.data || []).filter((member) => member.is_active);

  function change(fields) {
    setSaved(false);
    setDraft((previous) => ({ ...previous, ...fields }));
  }

  async function useCurrentLocation() {
    setError("");
    setBusy("location");
    try {
      const { latitude, longitude } = await readCurrentLocation();
      change({ latitude, longitude });
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    setSaved(false);
    const matchingTimes = Object.entries(draft.shifts).find(([, timing]) => timing.start === timing.end);
    if (matchingTimes) {
      setError(`${shiftNames[matchingTimes[0]]} needs different start and end times.`);
      return;
    }
    setBusy("save");
    try {
      const updated = await api(settingsPath, { ...requestOptions("PUT", {
        ...draft, latitude: draft.latitude === "" ? null : draft.latitude,
        longitude: draft.longitude === "" ? null : draft.longitude,
      }), silentError: true });
      setDraft(updated);
      onSaved(updated);
      setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }

  return <form className="panel control-stack" onSubmit={save}>
    <div>
      <h3>Attendance location</h3>
      <p className="muted">Set the office pin and allowed distance for Check In and Check Out.</p>
    </div>
    <fieldset disabled={Boolean(busy)} className="control-form control-settings-fields">
      <label>Address (optional)<input value={draft.address} maxLength={250} onChange={(e) => change({ address: e.target.value })} /></label>
      <div className="control-form-grid">
        <label>Latitude<input type="number" min="-90" max="90" step="any" value={draft.latitude ?? ""} onChange={(e) => change({ latitude: e.target.value })} /></label>
        <label>Longitude<input type="number" min="-180" max="180" step="any" value={draft.longitude ?? ""} onChange={(e) => change({ longitude: e.target.value })} /></label>
        <label>Radius (metres)<input type="number" min="1" max="2147483647" required value={draft.radius_m} onChange={(e) => change({ radius_m: e.target.value })} /></label>
      </div>
      <div className="control-actions">
        <button type="button" className="secondary-button" onClick={useCurrentLocation}><MapPin size={15} />{busy === "location" ? "Getting GPS…" : "Use current location"}</button>
        <LocationLink location={draft} label="Preview office pin" />
      </div>
    </fieldset>
    <div className="control-between">
      <div><h3>Shift timings & assignments</h3>
        <p className="muted">Assignments use the saved UK timings. For overnight shifts, select the start date.</p>
      </div>
      <label className="control-assignment-date">Assignment date
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
    </div>
    {date && !assignments.data && <QueryStatus query={assignments} label="shift assignments" />}
    {!team.data && <QueryStatus query={team} label="team members" />}
    <fieldset disabled={Boolean(busy)} className="control-form control-settings-fields">
      {Object.keys(shiftNames).map((code) => <div className="control-timing-row" key={code}>
        <strong>{code} · {shiftNames[code]}</strong>
        {["start", "end"].map((field) => <label key={field}>
          {field === "start" ? "Start time" : "End time"}
          <input type="time" required value={draft.shifts[code][field]} aria-label={shiftNames[code] + " " + field + " time"} onChange={(event) => {
            change({ shifts: { ...draft.shifts, [code]: { ...draft.shifts[code], [field]: event.target.value } } });
          }} />
        </label>)}
        {date && assignments.data && team.data && <ShiftAssignmentControls key={date + code} api={api} code={code} date={date}
          assignments={assignments.data.filter((assignment) => assignment.shift === code)} members={members}
          timingDirty={draft.shifts[code].start !== settings.shifts[code].start || draft.shifts[code].end !== settings.shifts[code].end}
          onChanged={assignments.refetch} />}
      </div>)}
    </fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    {saved && <p className="success" role="status">Attendance settings saved.</p>}
    <div><button type="submit" className="primary-button" disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : "Save attendance settings"}</button></div>
  </form>;
}

export function ControlTeamAdmin({ api, Photo, FilePreview }) {
  const [page, setPage] = useState("team");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(null);
  const team = useControlQuery(api, teamPath, page !== "requests");
  const detail = useControlQuery(api, teamPath + selected + "/", Boolean(selected && page === "team"));
  const requests = useControlQuery(api, officeRequestsPath, page === "requests");
  const settings = useControlQuery(api, settingsPath, page === "settings");
  const client = useQueryClient();
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
    <ControlTabs label="Control Team management" page={page} onChange={setPage}
      tabs={[["team", "Members & attendance"], ["requests", "Leave & replacement"], ["settings", "Attendance settings"]]} />
    {page === "settings" && (settings.data ?
      <AttendanceSettingsForm settings={settings.data} api={api} team={team}
        onSaved={(data) => client.setQueryData(queryKey(settingsPath), data)} /> :
      <QueryStatus query={settings} label="attendance settings" />)}
    {page === "requests" && <RequestList query={requests} api={api} office />}
    {page === "team" && <>
      {adding && <AddMemberForm api={api} onClose={(member) => { setAdding(false); if (member) setSelected(member.id); }} />}
      {!team.data ? <QueryStatus query={team} label="team members" /> : <>
        <div className="control-metrics">
          <Metric icon={Users} label="Active members" value={members.filter((member) => member.is_active).length} />
          <Metric icon={Clock3} label="Checked in now" value={checkedIn} />
        </div>
        <section className="panel">
          <div className="panel-header"><div><h3>Members</h3><p className="muted">Checked-in members appear first.</p></div></div>
          {members.length ? <div className="control-member-list">{members.map((member) => <Fragment key={member.id}><article className="control-member">
            <div className="control-identity"><Avatar member={member} Photo={Photo} /><div>
              <strong>{member.name}</strong>
              <p className="muted">{member.profile_complete ? member.email : "Profile setup pending"}</p>
            </div></div>
            <div><div className="control-actions"><MemberStatus member={member} /><LateBadge minutes={member.late_minutes} /></div>
              {member.checked_in_at && <small className="table-subtext">{formatUkDateTime(member.checked_in_at)}</small>}</div>
            <button type="button" className="secondary-button" aria-pressed={selected === member.id} onClick={() => setSelected(selected === member.id ? null : member.id)}>View details</button>
          </article>
          {selected === member.id && (detail.data ? <MemberDetail member={detail.data} api={api} FilePreview={FilePreview} onClose={() => setSelected(null)} /> : <QueryStatus query={detail} label="member details" />)}
          </Fragment>)}</div> : <p className="muted">No Control Team members yet.</p>}
        </section>
      </>}
    </>}
  </div>;
}
