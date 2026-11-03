import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, KeyRound, ShieldCheck } from "lucide-react";
import { endAdminSession, readAdminSession, sessionRemaining, syncAdminSession } from "./authSession";
import "./adminSecurity.css";

export function AdminMFA({ challenge, api, onComplete, onBack }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await api("/auth/admin-verify/", { method: "POST", body: JSON.stringify({ challenge: challenge.challenge, code, use_recovery: recovery, new_password: password, confirm_password: confirmation }), silentError: true });
      if (response.recovery_codes?.length) setResult(response);
      else onComplete(response);
    } catch (err) { setError(err.message); setCode(""); } finally { setBusy(false); }
  };
  const downloadCodes = () => {
    const url = URL.createObjectURL(new Blob(["RotaOps recovery codes\nKeep these private. Each code works once.\n\n" + result.recovery_codes.join("\n")], { type: "text/plain" }));
    const link = document.createElement("a"); link.href = url; link.download = "RotaOps-recovery-codes.txt"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <main className="login-shell"><section className="login-card admin-mfa-card"><div className="brand-mark"><ShieldCheck size={24} /></div><p className="eyebrow">ROTAOPS SECURITY</p>
    {result ? <><h1>Save your recovery codes</h1><p className="muted">Use a recovery code if you lose access to your authenticator. Each code works once. These codes are shown only now.</p><div className="recovery-codes">{result.recovery_codes.map((item) => <code key={item}>{item}</code>)}</div><button className="secondary-button" onClick={downloadCodes}><Download size={16} /> Download codes</button><label className="security-check"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /><span>I have stored my recovery codes somewhere safe.</span></label><button className="primary-button" disabled={!saved} onClick={() => onComplete(result)}>Continue to portal</button></> : <>
      <h1>{challenge.setup_required ? "Set up two-step verification" : "Verify your sign in"}</h1>
      {challenge.setup_required ? <><p className="muted">Scan this QR code in Google Authenticator, Microsoft Authenticator or another authenticator app, then enter its 6-digit code.</p><img className="mfa-qr" src={challenge.qr_image} alt="Scan to set up your RotaOps authenticator" /><details><summary>Enter setup key manually</summary><code className="mfa-secret">{challenge.secret}</code></details></> : <p className="muted">{recovery ? "Enter one of the recovery codes saved when you enabled two-step verification." : "Enter the current 6-digit code from your authenticator app."}</p>}
      <form onSubmit={submit}><label>{recovery ? "Recovery code" : "Authenticator code"}<input required autoFocus value={code} onChange={(event) => setCode(recovery ? event.target.value : event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" maxLength={recovery ? 40 : 6} pattern={recovery ? undefined : "[0-9]{6}"} /></label>
        {challenge.password_change_required && <><p className="security-notice">Update your password before continuing. Use at least 12 characters; avoid common passwords and account details.</p><label>New strong password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>Confirm new password<input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label></>}
        {error && <p className="error" role="alert">{error}</p>}<button className="primary-button" disabled={busy} type="submit">{busy ? "Verifying…" : challenge.setup_required ? "Enable 2FA & continue" : "Verify & sign in"}</button>
        {!challenge.setup_required && <button type="button" className="text-button" disabled={busy} onClick={() => { setRecovery(!recovery); setCode(""); setError(""); }}>{recovery ? "Use authenticator instead" : "Use a recovery code"}</button>}<button type="button" className="text-button" disabled={busy} onClick={onBack}>Back to sign in</button></form><p className="login-hint">Verification expires after 5 minutes. Your account is protected by mandatory 2FA.</p></>}
  </section></main>;
}

export function AdminSessionMonitor({ api }) {
  const [remaining, setRemaining] = useState(() => sessionRemaining(readAdminSession()));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const state = useRef({ sending: false, lastSent: Date.now(), ended: false });
  const extend = async () => {
    if (state.current.sending || state.current.ended) return;
    state.current.sending = true; state.current.lastSent = Date.now(); setBusy(true);
    try {
      const data = await api("/auth/admin-activity/", { method: "POST", silentLoading: true, silentError: true });
      syncAdminSession(data); setRemaining(sessionRemaining(data)); setError("");
    } catch (err) { setError(err.message); } finally { state.current.sending = false; setBusy(false); }
  };
  const extendRef = useRef(extend); extendRef.current = extend;
  useEffect(() => {
    const activity = () => { if (document.visibilityState === "visible" && Date.now() - state.current.lastSent >= 60000 && sessionRemaining(readAdminSession()) > 0) extendRef.current(); };
    const tick = () => {
      const seconds = sessionRemaining(readAdminSession()); setRemaining(seconds);
      if (seconds <= 0 && !state.current.ended) {
        state.current.ended = true;
        api("/auth/logout/", { method: "POST", silentLoading: true, silentError: true }).catch(() => {});
        endAdminSession("Your admin session expired. Please sign in again.");
      }
    };
    const timer = window.setInterval(tick, 1000);
    const events = ["pointerdown", "keydown", "scroll", "touchstart"];
    events.forEach((name) => window.addEventListener(name, activity, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); events.forEach((name) => window.removeEventListener(name, activity, { capture: true })); document.removeEventListener("visibilitychange", tick); };
  }, [api]);
  if (remaining > 60 || remaining <= 0) return null;
  const maximumReached = Date.parse(readAdminSession()?.expires_at) - Date.now() <= 60000;
  return <div className="security-session-backdrop"><section className="security-session-dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-warning-title"><ShieldCheck size={30} /><h2 id="session-warning-title">Your session is ending</h2><p>{maximumReached ? "Your maximum session duration is nearly over. Save your work and sign in again." : "Your session will expire due to inactivity. Continue to keep working."}</p><strong>{remaining} seconds remaining</strong>{error && <p className="error">{error}</p>}{!maximumReached && <button autoFocus className="primary-button" disabled={busy} onClick={() => extendRef.current()}>{busy ? "Continuing…" : "Continue session"}</button>}</section></div>;
}

const eventLabels = { LOGIN: "Successful sign in", LOGOUT: "Signed out", PASSWORD_FAILED: "Incorrect password", MFA_CHALLENGE: "Verification started", MFA_ENROLLED: "Authenticator enabled", MFA_FAILED: "Incorrect verification code", RECOVERY_USED: "Recovery code used", PASSWORD_CHANGED: "Password updated", PASSWORD_RESET: "Password reset", SESSION_EXPIRED: "Session expired", SESSION_REVOKED: "Session revoked", OTHER_SESSIONS_REVOKED: "Other sessions signed out" };
const formatDate = (value) => value ? new Date(value).toLocaleString() : "—";

export default function AdminSecurity({ api, user }) {
  const [security, setSecurity] = useState(null);
  const [history, setHistory] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError("");
    try {
      const [details, events] = await Promise.all([api("/auth/admin-security/", { silentLoading: true }), api(`/auth/login-history/?page=${page}`, { silentLoading: true })]);
      setSecurity(details); setHistory(events);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  useEffect(() => { load(); }, [page]);
  const revoke = async () => { setBusy(true); try { await api("/auth/revoke-other-sessions/", { method: "POST", silentLoading: true }); await load(); } catch (err) { setError(err.message); setBusy(false); } };
  return <div className="security-page"><div className="page-heading"><div><p className="eyebrow">ACCOUNT PROTECTION</p><h1>Security & login history</h1><p className="muted">Manage your sessions and review account access.</p></div><button className="secondary-button" disabled={busy} onClick={load}>{busy ? "Checking…" : "Check updates"}</button></div>{error && <p className="error" role="alert">{error}</p>}
    <div className="security-stats"><section className="panel"><ShieldCheck /><h3>Two-step verification</h3><p>{security?.mfa_enabled ? "Enabled · compulsory" : "Checking…"}</p></section><section className="panel"><KeyRound /><h3>Recovery codes</h3><p>{security ? `${security.recovery_codes_remaining} unused codes` : "Checking…"}</p></section><section className="panel"><CheckCircle2 /><h3>Session protection</h3><p>30 minutes inactive · 8 hours maximum</p></section></div>
    <section className="panel"><div className="security-panel-heading"><h2>Your active sessions</h2><button className="secondary-button" disabled={busy || !security?.sessions.some((item) => !item.current)} onClick={revoke}>Sign out other sessions</button></div><div className="security-session-list">{security?.sessions.map((item) => <article key={item.id}><strong>{item.current ? "This session" : "Other session"}</strong><p className="security-device">{item.user_agent || "Unknown browser"}</p><small>IP: {item.ip_address || "Unavailable"} · Started: {formatDate(item.created_at)} · Last seen: {formatDate(item.last_seen_at)}</small></article>)}</div></section>
    <section className="panel"><h2>Login history</h2><p className="muted">{(user.role || user.role_display) === "SUPER_ADMIN" ? "Admin and Super Admin account activity." : "Your account activity."}</p><div className="table-wrap"><table><thead><tr><th>Date & time</th><th>Account</th><th>Activity</th><th>IP address</th><th>Browser / device</th></tr></thead><tbody>{history?.results.map((item) => <tr key={item.id}><td>{formatDate(item.created_at)}</td><td>{item.username || "Unknown account"}</td><td>{eventLabels[item.event] || item.event}</td><td>{item.ip_address || "Unavailable"}</td><td className="security-device">{item.user_agent || "Unavailable"}</td></tr>)}{history && !history.results.length && <tr><td colSpan={5}>No account activity yet.</td></tr>}</tbody></table></div>{history && <div className="security-pagination"><button className="secondary-button" disabled={busy || !history.pagination.has_previous} onClick={() => setPage(page - 1)}>Previous</button><span>Page {history.pagination.page} of {history.pagination.total_pages}</span><button className="secondary-button" disabled={busy || !history.pagination.has_next} onClick={() => setPage(page + 1)}>Next</button></div>}</section>
  </div>;
}
