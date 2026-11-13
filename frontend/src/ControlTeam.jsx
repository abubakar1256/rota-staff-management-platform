import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarDays, Camera, ChevronDown, ChevronLeft, ChevronRight, Clock3, LogOut, MapPin, Sun, UserPlus, Users } from "lucide-react";
import AdminNotifications from "./AdminNotifications";
import CheckUpdatesButton from "./CheckUpdatesButton";
import { readCurrentLocation } from "./attendanceGeofence";
import { requestDutyPosition } from "./dutyLocationClient";
import { googleSiteLinks, sitePoint } from "./siteCoordinates";
import { formatUkAttendanceTime, formatUkDateTime, formatUkShortDateTime, UK_TIME_ZONE, ukDate } from "./ukTime";
import "./controlTeam.css";

const root = "/control";
const profilePath = root + "/profile/";
const schedulePath = root + "/schedule/";
const settingsPath = root + "/attendance/settings/";
const teamPath = root + "/team/";
const assignmentsPath = teamPath + "assignments/";
const weeklyAssignmentsPath = teamPath + "weekly-assignments/";
const requestsPath = root + "/requests/";
const officeRequestsPath = teamPath + "requests/";
const queryKey = (path) => ["rota", "control", path];
const requestOptions = (method, data) => ({ method, body: JSON.stringify(data) });
const NIGHT_SHIFT = "N";
const shiftNames = { M: "Morning", D: "Mid-day", E: "Evening", N: "Night" };
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const controlClockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function useControlQuery(api, path, enabled = true) {
  return useQuery({
    queryKey: queryKey(path),
    queryFn: () => api(path, { silentLoading: true, silentError: true }),
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

function ControlUpdatesButton({ api, paths, disabled = false }) {
  const client = useQueryClient();
  return <CheckUpdatesButton api={api} paths={paths} disabled={disabled}
    currentData={paths.map((path) => client.getQueryData(queryKey(path)))} onUpdate={(results) => {
      paths.forEach((path, index) => {
        const key = queryKey(path);
        void client.cancelQueries({ queryKey: key, exact: true });
        client.setQueryData(key, results[index]);
      });
    }} />;
}

function ControlInboxButton({ unread, onClick, selected }) {
  return <button type="button" className="secondary-button control-inbox-button" aria-pressed={selected} onClick={onClick}>
    <Bell size={16} aria-hidden="true" /> Notifications
    {unread > 0 && <span className="control-unread" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
  </button>;
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
    <div className="control-proof-actions">
      {photoUrl && <FilePreview value={photoUrl} label={label + " photo"} buttonLabel="View photo" />}
      {location && <LocationLink location={location} label="View GPS" />}
    </div>
    {location && <small className="control-history-note">
      {location.distance_m} m from pin{location.radius_m && ` · ${location.radius_m} m radius`} · GPS ±{Math.round(location.accuracy_m)} m
    </small>}
  </div>;
}

function ShiftDetails({ entry }) {
  if (!entry?.shift_name) return null;
  return <small className="table-subtext">
    {entry.shift_name} · {formatUkAttendanceTime(entry.scheduled_start_at)} – {formatUkAttendanceTime(entry.scheduled_end_at)}
  </small>;
}

function WorkedStartNote({ entry }) {
  if (!entry?.worked_start_at || Date.parse(entry.worked_start_at) <= Date.parse(entry.checked_in_at)) return null;
  return <small className="table-subtext">Hours start at {formatUkShortDateTime(entry.worked_start_at)}</small>;
}

function useControlAttendanceLocation(api, attendanceId, onCheckout) {
  const onCheckoutRef = useRef(onCheckout);
  onCheckoutRef.current = onCheckout;
  const [issue, setIssue] = useState(null);

  useEffect(() => {
    if (!attendanceId) return;
    const controller = new AbortController();
    let inFlight = false;
    let finished = false;

    async function verify() {
      if (controller.signal.aborted || finished || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const { coords, timestamp } = await requestDutyPosition();
        if (controller.signal.aborted || document.visibilityState !== "visible") return;
        const result = await api(root + "/attendance/location/", {
          method: "POST", signal: controller.signal,
          silentLoading: true, silentError: true, silentToast: true, skipInvalidation: true,
          body: JSON.stringify({
            attendance_id: attendanceId, latitude: coords.latitude, longitude: coords.longitude,
            accuracy_m: coords.accuracy, captured_at: new Date(timestamp).toISOString(),
          }),
        });
        if (controller.signal.aborted) return;
        setIssue(null);
        finished = result.status === "checked_out" || result.status === "inactive";
        if (finished) onCheckoutRef.current(attendanceId, result.status === "checked_out");
      } catch {
        if (!controller.signal.aborted) setIssue(attendanceId);
      } finally {
        inFlight = false;
      }
    }

    void verify();
    const timer = window.setInterval(verify, 60_000);
    document.addEventListener("visibilitychange", verify);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", verify);
    };
  }, [api, attendanceId]);

  return attendanceId != null && issue === attendanceId;
}

function AttendanceTimes({ entry, FilePreview, checkout = false }) {
  const timestamp = checkout ? entry.checked_out_at : entry.checked_in_at;
  return <>
    {timestamp ? <time dateTime={timestamp}>{formatUkDateTime(timestamp)}</time> : <span className="status-pill active">In progress</span>}
    {checkout ? <>
      {entry.closed_by_admin && <small className="control-history-note">Closed by admin</small>}
      {entry.corrected_by_admin && <small className="control-history-note">Corrected by admin</small>}
      {entry.auto_checked_out && !entry.corrected_by_admin && <small className="control-history-note">
        {entry.geofence_checked_out
          ? "Automatic Check Out · Last verified office GPS time"
          : "Automatic Check Out. No manual Check Out recorded."}
      </small>}
    </> : <>
      <ShiftDetails entry={entry} />
      <WorkedStartNote entry={entry} />
      <LateBadge minutes={entry.late_minutes} />
    </>}
    <AttendanceEvidence
      photoUrl={checkout ? entry.check_out_photo_url : entry.check_in_photo_url}
      location={entry.shift !== NIGHT_SHIFT && (checkout ? entry.check_out_location : entry.check_in_location)}
      label={checkout ? "Check-out" : "Check-in"} FilePreview={FilePreview} />
  </>;
}

function attendanceDuration(entry) {
  return duration((Date.parse(entry.checked_out_at) - Date.parse(entry.worked_start_at || entry.checked_in_at)) / 1000);
}

function CorrectAttendanceButton({ entry, onCorrect }) {
  return onCorrect && <button type="button" className="secondary-button control-correct-button"
    aria-label={`Correct attendance for ${formatUkDateTime(entry.checked_in_at)}`}
    onClick={() => onCorrect(entry)}>Correct times</button>;
}

function CompactAttendanceEntry({ entry, FilePreview, onCorrect }) {
  const checkIn = new Date(entry.checked_in_at);
  const checkOut = entry.checked_out_at ? new Date(entry.checked_out_at) : null;
  const sameDay = checkOut && ukDate(checkIn) === ukDate(checkOut);
  return <details className="control-history-card" data-shift={entry.shift}>
    <summary>
      <span className="control-history-range">
        <time dateTime={entry.checked_in_at}>{formatUkShortDateTime(checkIn)}</time>
        {checkOut && <span className="control-history-range-end">– <time dateTime={entry.checked_out_at}>
          {sameDay ? controlClockFormat.format(checkOut) : formatUkShortDateTime(checkOut)}
        </time></span>}
      </span>
      <strong className="control-history-total">{checkOut ? attendanceDuration(entry) : "In progress"}</strong>
      <ChevronDown size={15} aria-hidden="true" />
    </summary>
    <div className="control-history-details">
      <div><strong>Check in</strong><AttendanceTimes entry={entry} FilePreview={FilePreview} /></div>
      <div><strong>Check out</strong><AttendanceTimes entry={entry} FilePreview={FilePreview} checkout /></div>
      <CorrectAttendanceButton entry={entry} onCorrect={onCorrect} />
    </div>
  </details>;
}

function AttendanceHistory({ member, FilePreview, onCorrect }) {
  return <section className="panel control-history">
    <header className="control-history-heading">
      <span className="control-history-icon"><Clock3 size={19} aria-hidden="true" /></span>
      <div><h3>Attendance history</h3><p>Latest 50 entries · UK time</p></div>
    </header>
    {member.attendance.length ? <>
      <div className="control-history-compact">{member.attendance.map((entry) =>
        <CompactAttendanceEntry key={entry.id} entry={entry} FilePreview={FilePreview} onCorrect={onCorrect} />,
      )}</div>
      <div className="control-history-list">
        <table className="control-history-table" aria-label="Attendance history">
          <thead><tr>
            <th scope="col">Check in</th>
            <th scope="col">Check out</th>
            <th scope="col">Duration</th>
          </tr></thead>
          <tbody>{member.attendance.map((entry) => <tr key={entry.id}>
            <td><AttendanceTimes entry={entry} FilePreview={FilePreview} /></td>
            <td><AttendanceTimes entry={entry} FilePreview={FilePreview} checkout /></td>
            <td className="control-history-duration">
              <strong>{entry.checked_out_at ? attendanceDuration(entry) : "—"}</strong>
              <CorrectAttendanceButton entry={entry} onCorrect={onCorrect} />
            </td>
          </tr>)}</tbody>
        </table>
      </div>
    </> : <p className="muted control-empty">No attendance recorded yet.</p>}
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

const attendanceCameraErrors = {
  NotAllowedError: "Camera access is blocked. Allow camera access for this site and for Chrome in your phone settings, then retry.",
  NotFoundError: "No camera was found. Check that camera access is on in your device settings, then retry.",
  NotReadableError: "The camera could not start. Close any apps or tabs using it and check that camera access is on, then retry.",
  AbortError: "The camera was interrupted. Close any apps or tabs using it, then retry.",
};

function AttendanceCamera({ facing, onFacingChange, onCapture }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [mirrored, setMirrored] = useState(facing === "user");
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let active = true;
    let stream;
    const video = videoRef.current;
    async function start() {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia) {
        setError("Open the secure portal in a browser on a device with a camera, then try again.");
        return;
      }
      try {
        const rear = facing === "environment";
        if (rear && mediaDevices.getSupportedConstraints && !mediaDevices.getSupportedConstraints().facingMode) {
          setError("This browser cannot select a back camera. Choose Front camera to continue.");
          return;
        }
        const facingMode = rear ? { exact: facing } : { ideal: facing };
        try {
          stream = await mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
        } catch (err) {
          if (!active || rear || !["NotFoundError", "OverconstrainedError", "NotReadableError", "AbortError"].includes(err.name)) throw err;
          stream = await mediaDevices.getUserMedia({ video: true, audio: false });
        }
      } catch (err) {
        if (active) {
          const rearUnavailable = facing === "environment" && ["NotFoundError", "OverconstrainedError"].includes(err.name);
          setError(rearUnavailable
            ? "No back camera is available. Choose Front camera to continue."
            : attendanceCameraErrors[err.name] || "Could not open the camera. Try again in Chrome or another browser with camera access.");
        }
        return;
      }
      if (!active) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const actualFacing = stream.getVideoTracks()[0]?.getSettings?.()?.facingMode;
      setMirrored((actualFacing || facing) === "user");
      video.srcObject = stream;
    }
    start();
    return () => {
      active = false;
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
  }, [attempt, facing]);

  function capture() {
    const video = videoRef.current;
    const stream = video.srcObject;
    if (!ready || capturing || !stream || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, 1000 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      setError("Could not capture the photo. Try again.");
      return;
    }
    setCapturing(true);
    setError("");
    if (mirrored) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (videoRef.current?.srcObject !== stream) return;
      if (blob) onCapture(blob);
      else {
        setError("Could not capture the photo. Try again.");
        setCapturing(false);
      }
    }, "image/jpeg", 0.88);
  }

  return <>
    <div className="control-tabs" role="group" aria-label="Camera selection">
      {[["user", "Front camera"], ["environment", "Back camera"]].map(([mode, label]) => (
        <button type="button" className="secondary-button" key={mode} aria-pressed={facing === mode}
          disabled={capturing || (!ready && !error)} onClick={() => onFacingChange(mode)}>{label}</button>
      ))}
    </div>
    <video ref={videoRef} autoPlay muted playsInline aria-label="Live camera preview"
      className={mirrored ? "camera-preview control-camera-mirrored" : "camera-preview"} onPlaying={() => setReady(true)} />
    {!ready && !error && <p className="muted" role="status">Preparing camera…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="control-actions">
      {error && !ready ? <button type="button" className="secondary-button" onClick={() => { setError(""); setAttempt(attempt + 1); }}>Retry camera</button> :
        <button type="button" className="primary-button" disabled={!ready || capturing} onClick={capture}><Camera size={16} /> Take photo</button>}
    </div>
  </>;
}

function AttendanceCapture({ action, requiresLocation, onClose, onSubmit }) {
  const dialogRef = useRef(null);
  const [facing, setFacing] = useState("user");
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
    setBusy(requiresLocation ? "Getting GPS…" : "Saving…");
    setError("");
    try {
      const location = requiresLocation ? await readCurrentLocation() : null;
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
      {requiresLocation && <p className="muted">Allow precise location when you confirm.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="control-actions">
        <button type="button" className="primary-button" disabled={Boolean(busy) || stale} onClick={submit}>{busy || `Confirm ${label}`}</button>
        <button type="button" className="secondary-button" disabled={busy || stale} onClick={() => { setPhoto(null); setPreview(""); setError(""); }}>Retake</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{stale ? "Close" : "Cancel"}</button>
      </div>
    </> : <>
      <AttendanceCamera key={facing} facing={facing} onFacingChange={setFacing} onCapture={setPhoto} />
      <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
    </>}
  </dialog>;
}

const scheduleDayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "short",
});
const scheduleRangeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
});

function scheduleDate(day, offset = 0) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}

function ShiftCard({ shift, canCheckIn, hasOfficePin, onCheckIn }) {
  const available = shift.status === "Available";
  return <article className={`control-shift-card${available ? " has-check-in" : ""}`} data-shift={shift.shift}>
    <strong className="control-shift-name">{shift.shift_name}</strong>
    <div className="control-shift-times">
      <time dateTime={shift.scheduled_start_at}>{formatUkShortDateTime(shift.scheduled_start_at)}</time>
      {" "}<span className="control-shift-end">– <time dateTime={shift.scheduled_end_at}>{formatUkShortDateTime(shift.scheduled_end_at)}</time></span>
    </div>
    <span className={`status-pill control-shift-status ${available || shift.started ? "active" : "neutral"}`}>{shift.status}</span>
    {available && <button type="button" className="primary-button control-shift-check-in"
      disabled={!canCheckIn || (shift.shift !== NIGHT_SHIFT && !hasOfficePin)} onClick={() => onCheckIn(shift)}>
      <Camera size={15} aria-hidden="true" /> Check In
    </button>}
  </article>;
}

function AssignedShifts({ today, start, schedule, scheduleQuery, offset, onNavigate, ...shiftActions }) {
  const shifts = schedule?.assigned_shifts || [];
  const leaveDates = new Set(schedule?.approved_leave_dates);
  const days = Array.from({ length: 7 }, (_, index) => scheduleDate(start, index));
  return <section className="panel control-shifts">
    <div className="panel-header">
      <div><h3>My shifts</h3><p className="muted">UK time · Check In opens 60 minutes before each shift.</p></div>
    </div>
    <nav className="control-schedule-nav" aria-label="Shift schedule">
      <span className="control-schedule-range" aria-live="polite">
        <CalendarDays size={17} aria-hidden="true" /> {scheduleRangeFormat.formatRange(days[0], days[6])}
      </span>
      <div className="control-actions">
        <button type="button" className="secondary-button" aria-label="Previous 7 days" onClick={() => onNavigate(offset - 7)}>
          <ChevronLeft size={17} aria-hidden="true" />
        </button>
        <button type="button" className="secondary-button" disabled={offset === 0} onClick={() => onNavigate(0)}>Today</button>
        <button type="button" className="secondary-button" aria-label="Next 7 days" onClick={() => onNavigate(offset + 7)}>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </nav>
    {!schedule ? <QueryStatus query={scheduleQuery} label="your shifts" /> : <div className="control-member-list">
      {days.map((day, index) => {
        const date = day.toISOString().slice(0, 10);
        const startingShifts = shifts.filter((shift) => shift.shift_date === date);
        const overnightShifts = shifts.filter((shift) =>
          shift.shift_date < date && ukDate(new Date(Date.parse(shift.scheduled_end_at) - 1)) === date,
        );
        const dayShifts = index === 0 ? [...overnightShifts, ...startingShifts] : startingShifts;
        const dayOff = !startingShifts.length && !overnightShifts.length;
        const approvedLeave = leaveDates.has(date);
        return <Fragment key={date}>
          {(approvedLeave || dayOff) && <div className="control-day-off">
            <Sun size={20} aria-hidden="true" />
            <div>
              <div className="control-day-off-heading">
                <strong>{approvedLeave ? "Approved leave" : "Day off"}</strong>
                <time dateTime={date}>{scheduleDayFormat.format(day)}</time>
              </div>
              {dayOff && date >= today && <small>Enjoy your day off!</small>}
            </div>
          </div>}
          {index > 0 && !startingShifts.length && overnightShifts.map((shift) =>
            <p className="control-overnight-note" key={shift.id}>
              {shift.shift_name} shift ends <time dateTime={shift.scheduled_end_at}>{formatUkShortDateTime(shift.scheduled_end_at)}</time>
            </p>,
          )}
          {dayShifts.map((shift) => <ShiftCard key={shift.id} shift={shift} {...shiftActions} />)}
        </Fragment>;
      })}
    </div>}
  </section>;
}

export function ControlPortal({ api, Photo, FilePreview, onSignOut, unread = 0 }) {
  const [page, setPage] = useState("attendance");
  const [capture, setCapture] = useState(null);
  const [scheduleOffset, setScheduleOffset] = useState(0);
  const client = useQueryClient();
  const profile = useControlQuery(api, profilePath);
  const member = profile.data;
  const requests = useControlQuery(api, requestsPath, Boolean(member?.profile_complete && page === "requests"));
  const activePage = member?.profile_complete || page === "notifications" ? page : "profile";
  const today = member?.schedule_start || ukDate();
  const scheduleStart = scheduleDate(today, scheduleOffset).toISOString().slice(0, 10);
  const selectedSchedulePath = `${schedulePath}?start=${scheduleStart}`;
  const schedule = useControlQuery(api, selectedSchedulePath, activePage === "attendance" && scheduleOffset !== 0);
  const current = member?.attendance.find((entry) => !entry.checked_out_at);
  const gpsAttendanceId = current?.shift !== NIGHT_SHIFT ? current?.id : null;
  const locationIssue = useControlAttendanceLocation(api, gpsAttendanceId, (attendanceId, exited) => {
    void profile.refetch();
    if (scheduleOffset !== 0) void schedule.refetch();
    setCapture((open) => open?.action === "check_out" && open.shift.id === attendanceId ? null : open);
    if (exited) window.dispatchEvent(new CustomEvent("rota:toast", {
      detail: { type: "warning", message: "Outside the office radius. Checked out at your last verified office GPS time." },
    }));
  });
  const assignedShifts = member?.assigned_shifts || [];
  const availableShifts = assignedShifts.filter((shift) => shift.status === "Available");
  const locationShifts = availableShifts.length ? availableShifts : assignedShifts;
  const showOfficeLocation = current ? current.shift !== NIGHT_SHIFT :
    !locationShifts.length || locationShifts.some((shift) => shift.shift !== NIGHT_SHIFT);
  const captureRequiresLocation = capture?.shift.shift !== NIGHT_SHIFT;
  const settings = useControlQuery(api, settingsPath, Boolean(member?.profile_complete && activePage === "attendance" && showOfficeLocation));
  const office = settings.data;
  const officePin = sitePoint(office?.latitude, office?.longitude);
  const updatePaths = [profilePath];
  if (activePage === "attendance" && scheduleOffset !== 0) updatePaths.push(selectedSchedulePath);
  if (activePage === "attendance" && showOfficeLocation) updatePaths.push(settingsPath);
  if (activePage === "requests") updatePaths.push(requestsPath);
  const saveProfile = (data) => {
    client.setQueryData(queryKey(profilePath), data);
    setPage("attendance");
  };
  async function markAttendance(photo, location) {
    const body = new FormData();
    body.set("action", capture.action);
    body.set("photo", photo, "attendance.jpg");
    if (capture.action === "check_out") body.set("attendance_id", capture.shift.id);
    else if (capture.shift.weekly_assignment_id) {
      body.set("weekly_assignment_id", capture.shift.weekly_assignment_id);
      body.set("shift_date", capture.shift.shift_date);
    } else body.set("assignment_id", capture.shift.id);
    if (location) {
      body.set("latitude", location.latitude);
      body.set("longitude", location.longitude);
      body.set("accuracy_m", location.accuracy);
    }
    try {
      const updated = await api(root + "/attendance/", {
        method: "POST", body, silentError: true, silentLoading: true, silentToast: true, skipInvalidation: true,
      });
      await client.cancelQueries({ queryKey: queryKey(profilePath), exact: true });
      client.setQueryData(queryKey(profilePath), updated);
      if (scheduleOffset !== 0) void client.invalidateQueries({ queryKey: queryKey(selectedSchedulePath), exact: true });
      setCapture(null);
      if (capture.action === "check_out" && updated.attendance?.find((entry) => entry.id === capture.shift.id)?.geofence_checked_out) {
        window.dispatchEvent(new CustomEvent("rota:toast", {
          detail: { type: "warning", message: "Outside the office radius. Checked out at your last verified office GPS time." },
        }));
      }
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
      <div className="control-between">
        <div><p className="eyebrow">STAFF PORTAL</p><h1 className="control-title">Control Team</h1><p className="muted">Your attendance, hours and requests.</p></div>
        {member && <div className="control-actions">
          {activePage !== "notifications" && <ControlUpdatesButton key={activePage} api={api} paths={updatePaths} disabled={Boolean(capture)} />}
          <ControlInboxButton unread={unread} selected={activePage === "notifications"} onClick={() => setPage(activePage === "notifications" ? "attendance" : "notifications")} />
        </div>}
      </div>
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
              <WorkedStartNote entry={current} />
              {current?.auto_checkout_at && <small className="table-subtext">Auto checkout at {formatUkDateTime(current.auto_checkout_at)}</small>}
              {gpsAttendanceId && <small className="table-subtext">
                {locationIssue ? "Location checks paused. Allow precise GPS and check your connection." : "Office GPS checks run while this portal is open and visible."}
              </small>}
            </div></div>
            {current && <button type="button" className="primary-button" disabled={current.shift !== NIGHT_SHIFT && !officePin}
              onClick={() => setCapture({ action: "check_out", shift: current })}>
              <Camera size={16} aria-hidden="true" /> Check Out
            </button>}
            {showOfficeLocation && captureRequiresLocation && <div className="control-office-location">
              {!office ? <QueryStatus query={settings} label="attendance location" /> : officePin ?
                <div className="control-actions"><LocationLink location={officePin} label="Attendance location" />
                  <span className="muted">{office.address && `${office.address} · `}{office.radius_m} m radius</span></div> :
                <p className="muted">The office needs to set the attendance location.</p>}
            </div>}
          </section>
          <AssignedShifts today={today} start={scheduleStart} schedule={scheduleOffset === 0 ? member : schedule.data}
            scheduleQuery={schedule} offset={scheduleOffset} onNavigate={setScheduleOffset}
            canCheckIn={!current} hasOfficePin={Boolean(officePin)}
            onCheckIn={(shift) => setCapture({ action: "check_in", shift })} />
          <div className="control-metrics">
            <Metric icon={Clock3} label="This week" value={duration(member.weekly_seconds)} detail="Monday to Sunday · UK time" />
            <Metric icon={CalendarDays} label="This month" value={duration(member.monthly_seconds)} detail="Calendar month · UK time" />
          </div>
          <AttendanceHistory member={member} FilePreview={FilePreview} />
          {capture && <AttendanceCapture action={capture.action} requiresLocation={captureRequiresLocation}
            onClose={() => setCapture(null)} onSubmit={markAttendance} />}
        </>}
        {activePage === "requests" && <><RequestForm api={api} /><RequestList query={requests} api={api} /></>}
        {activePage === "notifications" && <AdminNotifications api={api} audience="control"
          onNavigate={(_, context) => setPage(context.control_tab === "requests" ? "requests" : "attendance")} />}
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

function correctionInputTime(value) {
  if (!value) return "";
  const instant = new Date(value);
  return `${ukDate(instant)}T${controlClockFormat.format(instant)}`;
}

function AttendanceCorrection({ member, entry, api, onClose, onSaved, onConflict }) {
  const dialog = useRef(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const checkIn = correctionInputTime(entry.checked_in_at);
  const checkOut = correctionInputTime(entry.checked_out_at);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const start = form.get("checked_in_at");
    const end = form.get("checked_out_at");
    const changes = {
      original_check_in: entry.checked_in_at,
      original_check_out: entry.checked_out_at,
      reason: form.get("reason").trim(),
    };
    if (start !== checkIn) changes.checked_in_at = start;
    if (end !== checkOut) changes.checked_out_at = end;
    setBusy(true);
    setError("");
    try {
      const updated = await api(`${teamPath}${member.id}/attendance/${entry.id}/`, {
        ...requestOptions("PATCH", changes), silentError: true,
      });
      onSaved(updated);
    } catch (err) {
      setError(err.message);
      if (err.status === 409) {
        setStale(true);
        onConflict();
      }
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="modal-card control-capture control-correction" aria-labelledby="control-correction-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h3 id="control-correction-title">Correct attendance</h3>
    <p className="muted">{member.name} · UK time</p>
    <form className="control-form" onSubmit={submit}>
      <label>Check-In<input name="checked_in_at" type="datetime-local" defaultValue={checkIn} required disabled={busy || stale} /></label>
      <label>Check-Out<input name="checked_out_at" type="datetime-local" defaultValue={checkOut} required={Boolean(checkOut)} disabled={busy || stale} />
        {!checkOut && <small>Leave blank to keep the shift open.</small>}
      </label>
      <label>Reason<textarea name="reason" rows={3} maxLength={1000} required disabled={busy || stale} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="control-actions">
        <button type="submit" className="primary-button" disabled={busy || stale}>{busy ? "Saving…" : "Save correction"}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{stale ? "Close" : "Cancel"}</button>
      </div>
    </form>
  </dialog>;
}

function MemberDetail({ member, api, FilePreview, onClose }) {
  const [busy, setBusy] = useState(false);
  const [correction, setCorrection] = useState(null);
  const client = useQueryClient();
  const path = teamPath + member.id + "/";
  async function toggleStatus() {
    if (member.is_active && !window.confirm(member.checked_in_at
      ? "Deactivate this member and close their current attendance entry now?"
      : "Deactivate this member's Control Team access?")) return;
    setBusy(true);
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
    <AttendanceHistory member={member} FilePreview={FilePreview} onCorrect={setCorrection} />
    {correction && <AttendanceCorrection member={member} entry={correction} api={api}
      onClose={() => setCorrection(null)} onConflict={() => void client.invalidateQueries({ queryKey: queryKey(path) })}
      onSaved={(updated) => {
        client.setQueryData(queryKey(path), updated);
        setCorrection(null);
      }} />}
  </>;
}

function ShiftAssignmentControls({ api, code, date, assignments, members, onChanged, timingDirty }) {
  const weekly = !date;
  const path = weekly ? weeklyAssignmentsPath : assignmentsPath;
  const [memberId, setMemberId] = useState("");
  const [days, setDays] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setMemberId("");
    setDays([]);
    setEditingId(null);
    setError("");
  }

  async function saveAssignment(removeId) {
    setBusy(true);
    setError("");
    try {
      if (removeId) {
        await api(`${path}${removeId}/`, { method: "DELETE", silentError: true, silentLoading: true });
      } else {
        const fields = weekly ? { member: memberId, shift: code, weekdays: days } :
          editingId ? { member: memberId } : { member: memberId, shift: code, shift_date: date };
        const url = editingId ? `${path}${editingId}/` : path;
        await api(url, { ...requestOptions(editingId ? "PATCH" : "POST", fields), silentError: true, silentLoading: true });
      }
      await onChanged();
      reset();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const saveTimingFirst = timingDirty && (weekly || !editingId);
  return <div className={`control-assignment-cell ${weekly ? "control-weekly-assignment" : ""}`}>
    <label>{editingId ? "Reassign to" : "Assign member"}
      <select aria-label={`${shiftNames[code]} member`} value={memberId} disabled={busy} onChange={(event) => setMemberId(event.target.value)}>
        <option value="">Select member</option>
        {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select>
    </label>
    {weekly && <div className="control-assignment-days" role="group" aria-label={`${shiftNames[code]} weekdays`}>
      {weekdays.map((day, index) => <button type="button" key={day} className="secondary-button"
        aria-pressed={days.includes(index)} disabled={busy} onClick={() => {
          setDays((selected) => selected.includes(index) ? selected.filter((value) => value !== index) : [...selected, index]);
        }}>{day}</button>)}
    </div>}
    <div className="control-actions">
      <button type="button" className="secondary-button" disabled={busy || !memberId || saveTimingFirst || (weekly && !days.length)}
        onClick={() => saveAssignment()}>{editingId ? "Save assignment" : weekly ? "Assign weekly" : "Assign"}</button>
      {editingId && <button type="button" className="text-button" disabled={busy} onClick={reset}>Cancel</button>}
    </div>
    {saveTimingFirst && <small className="muted control-assignment-note">Save the new shift timing before assigning.</small>}
    {error && <p className="error control-assignment-note" role="alert">{error}</p>}
    {assignments.length > 0 && <ul className="control-assignment-list" data-shift={code}>
      {assignments.map((assignment) => <li key={assignment.id}>
        <div><strong>{assignment.member_name}</strong>
          {weekly && <div className="control-assigned-days" role="group" aria-label="Assigned days">
            {assignment.weekdays.map((day) => <span key={day}>{weekdays[day]}</span>)}
          </div>}
          <small className="table-subtext">{weekly ?
            `${assignment.start_time}–${assignment.end_time}` :
            `${formatUkAttendanceTime(assignment.scheduled_start_at)} – ${formatUkAttendanceTime(assignment.scheduled_end_at)}${assignment.started ? ` · ${assignment.status}` : ""}`}
          </small>
        </div>
        {assignment.weekly_assignment_id && <small className="muted">Repeats weekly</small>}
        {!assignment.started && !assignment.weekly_assignment_id && <div className="control-actions">
          <button type="button" className="text-button" disabled={busy} aria-label={`Edit ${assignment.member_name} assignment`}
            onClick={() => {
              setEditingId(assignment.id);
              setMemberId(String(assignment.member));
              setDays(assignment.weekdays || []);
              setError("");
            }}>Edit</button>
          <button type="button" className="text-button control-remove-assignment" disabled={busy}
            aria-label={`Remove ${assignment.member_name} assignment`} onClick={() => saveAssignment(assignment.id)}>Remove</button>
        </div>}
      </li>)}
    </ul>}
  </div>;
}

function AttendanceSettingsForm({ settings, api, onSaved, team }) {
  const [editedSettings, setEditedSettings] = useState(null);
  const draft = editedSettings ?? settings;
  const [scheduleMode, setScheduleMode] = useState("weekly");
  const [date, setDate] = useState(() => ukDate());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const weekly = scheduleMode === "weekly";
  const schedulePath = weekly ? weeklyAssignmentsPath : `${assignmentsPath}?date=${encodeURIComponent(date)}`;
  const hasSchedule = weekly || Boolean(date);
  const assignments = useControlQuery(api, schedulePath, hasSchedule);
  const members = (team.data || []).filter((member) => member.is_active);

  function change(fields) {
    setSaved(false);
    setEditedSettings((previous) => ({ ...(previous ?? settings), ...fields }));
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
      onSaved(updated);
      setEditedSettings(null);
      setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }

  return <form className="panel control-stack" onSubmit={save}>
    <div className="control-between">
      <div><h3>Attendance location</h3>
        <p className="muted">Set the office pin and allowed distance for Check In and Check Out.</p></div>
      <ControlUpdatesButton api={api} paths={[settingsPath, teamPath, ...(hasSchedule ? [schedulePath] : [])]} disabled={Boolean(busy)} />
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
        <p className="muted">{weekly ?
          "Choose a member and their working days for each shift. Assignments repeat weekly from today, in UK time." :
          "View or add assignments for a specific date. For overnight shifts, select the start date."}</p>
      </div>
      {!weekly && <label className="control-assignment-date">Assignment date
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>}
    </div>
    <ControlTabs label="Assignment schedule" page={scheduleMode} onChange={setScheduleMode}
      tabs={[["weekly", "Weekly schedule"], ["dated", "By date"]]} />
    {(weekly || date) && !assignments.data && <QueryStatus query={assignments} label="shift assignments" />}
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
        {(weekly || date) && assignments.data && team.data && <ShiftAssignmentControls key={weekly ? "weekly" : date} api={api} code={code} date={weekly ? null : date}
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

export function ControlTeamAdmin({ api, Photo, FilePreview, unread = 0, initialTarget }) {
  const [page, setPage] = useState(initialTarget?.control_tab || "team");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(initialTarget?.control_tab === "team" ? initialTarget.control_member_id : null);
  const team = useControlQuery(api, teamPath, page === "team" || page === "settings");
  const detailPath = teamPath + selected + "/";
  const detail = useControlQuery(api, detailPath, Boolean(selected && page === "team"));
  const requests = useControlQuery(api, officeRequestsPath, page === "requests");
  const settings = useControlQuery(api, settingsPath, page === "settings");
  const client = useQueryClient();
  const members = [...(team.data || [])].sort((a, b) => Number(Boolean(b.checked_in_at)) - Number(Boolean(a.checked_in_at)) || Number(b.is_active) - Number(a.is_active));
  const checkedIn = members.filter((member) => member.is_active && member.checked_in_at).length;
  return <div className="control-stack">
    <header className="page-heading control-office-heading">
      <div><p className="eyebrow">PEOPLE MANAGEMENT</p><h2>Control Team</h2><p className="muted">Manage team access, attendance and requests.</p></div>
      <div className="control-actions">
        {page === "team" && <ControlUpdatesButton api={api} paths={selected ? [teamPath, detailPath] : [teamPath]} disabled={adding} />}
        {page === "requests" && <ControlUpdatesButton api={api} paths={[officeRequestsPath]} />}
        <ControlInboxButton unread={unread} selected={page === "notifications"} onClick={() => setPage(page === "notifications" ? "team" : "notifications")} />
        <a className="secondary-button" href="/control" target="_blank" rel="noopener noreferrer">Open /control</a>
        <button type="button" className="primary-button" onClick={() => { setPage("team"); setAdding(true); }}><UserPlus size={16} /> Add member</button>
      </div>
    </header>
    <ControlTabs label="Control Team management" page={page} onChange={setPage}
      tabs={[["team", "Members & attendance"], ["requests", "Leave & replacement"], ["settings", "Attendance settings"]]} />
    {page === "settings" && (settings.data ?
      <AttendanceSettingsForm settings={settings.data} api={api} team={team}
        onSaved={(data) => client.setQueryData(queryKey(settingsPath), data)} /> :
      <><QueryStatus query={settings} label="attendance settings" /><ControlUpdatesButton api={api} paths={[settingsPath, teamPath]} /></>)}
    {page === "requests" && <RequestList query={requests} api={api} office />}
    {page === "notifications" && <AdminNotifications api={api} audience="control" onNavigate={(_, context) => {
      const tab = context.control_tab || "team";
      setSelected(tab === "team" ? context.control_member_id : null);
      setPage(tab);
    }} />}
    {page === "team" && <>
      {adding && <AddMemberForm api={api} onClose={(member) => { setAdding(false); if (member) setSelected(member.id); }} />}
      {!team.data ? <QueryStatus query={team} label="team members" /> : <>
        <div className="control-metrics">
          <Metric icon={Users} label="Active members" value={members.filter((member) => member.is_active).length} />
          <Metric icon={Clock3} label="Checked in now" value={checkedIn} />
        </div>
        <section className="panel">
          <div className="panel-header"><div><h3>Members</h3><p className="muted">Checked-in members appear first. Totals include time worked since check-in.</p></div></div>
          {members.length ? <div className="control-member-list">{members.map((member) => <Fragment key={member.id}><article className="control-member control-admin-member">
            <div className="control-identity"><Avatar member={member} Photo={Photo} /><div>
              <strong>{member.name}</strong>
              <p className="muted">{member.profile_complete ? member.email : "Profile setup pending"}</p>
            </div></div>
            <div><div className="control-actions"><MemberStatus member={member} /><LateBadge minutes={member.late_minutes} /></div>
              {member.checked_in_at && <small className="table-subtext">{formatUkDateTime(member.checked_in_at)}</small>}</div>
            <div className="control-member-hours">
              <span><small>This week</small><strong>{duration(member.weekly_seconds)}</strong></span>
              <span><small>This month</small><strong>{duration(member.monthly_seconds)}</strong></span>
            </div>
            <button type="button" className="secondary-button" aria-pressed={selected === member.id} onClick={() => setSelected(selected === member.id ? null : member.id)}>View details</button>
          </article>
          {selected === member.id && (detail.data ? <MemberDetail member={detail.data} api={api} FilePreview={FilePreview} onClose={() => setSelected(null)} /> : <QueryStatus query={detail} label="member details" />)}
          </Fragment>)}</div> : <p className="muted">No Control Team members yet.</p>}
        </section>
      </>}
    </>}
  </div>;
}
