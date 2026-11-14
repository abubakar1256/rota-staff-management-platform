import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, MapPin, ShieldAlert } from "lucide-react";
import "./guardAttendanceAccess.css";

export function EmployeeCortexITimeFields({ form, setForm, api }) {
  const [editingPin, setEditingPin] = useState(false);
  const { data: sites = [], isPending, error, refetch } = useQuery({
    queryKey: ["rota", "sites", "cortex-itime"],
    queryFn: () => api("/sites/", { silentLoading: true, silentError: true }),
    enabled: form.cortex_itime_enabled,
  });
  const savedSites = form.cortex_itime_sites || [];
  const pinSaved = form.cortex_itime_pin_saved;
  const availableSites = sites.filter((site) => site.cortex_itime_enabled && site.is_active
    && !savedSites.some((activated) => activated.id === site.id));

  return <fieldset className="full-width guard-pin-setting">
    <legend>Cortex iTime</legend>
    <label className="cortex-itime-toggle">
      <input type="checkbox" checked={form.cortex_itime_enabled}
        onChange={(event) => {
          setEditingPin(false);
          setForm({ ...form, cortex_itime_enabled: event.target.checked, cortex_itime_site: "", cortex_itime_pin: "" });
        }} />
      <span><strong>Enable Cortex iTime for this guard</strong><small>Show the guard's PIN and its active sites in the portal.</small></span>
    </label>
    {form.cortex_itime_enabled && <>
      {pinSaved && <div className="guard-pin-actions">
        <p className="muted"><strong>Guard PIN saved.</strong> {savedSites.length > 0 &&
          `Sites recorded: ${savedSites.map((site) => site.name + (site.active ? "" : " (inactive)")).join(", ")}.`}</p>
        <button type="button" className="mini-button" aria-expanded={editingPin} onClick={() => {
          if (editingPin) setForm({ ...form, cortex_itime_pin: "" });
          setEditingPin(!editingPin);
        }}>{editingPin ? "Cancel PIN change" : "Edit PIN"}</button>
      </div>}
      {isPending ? <p className="muted">Loading Cortex iTime sites…</p> : error ? <p className="error">
        Sites could not be loaded. <button type="button" className="mini-button" onClick={() => refetch()}>Try again</button>
      </p> : !availableSites.length && <p className="muted">{pinSaved ? "No additional enabled sites are available." : "Enable Cortex iTime on a site before adding the PIN."}</p>}
      <div className={pinSaved && !editingPin ? undefined : "cortex-itime-fields"}>
        <label>{pinSaved ? "Confirm activation for another site" : "First activation site"}<select value={form.cortex_itime_site} required={!pinSaved}
          onChange={(event) => setForm({ ...form, cortex_itime_site: event.target.value })}>
          <option value="">Select a Cortex iTime site</option>
          {availableSites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
        </select></label>
        {(!pinSaved || editingPin) && <label>{editingPin ? "New Cortex iTime PIN" : "Guard PIN"}<input value={form.cortex_itime_pin}
          onChange={(event) => setForm({ ...form, cortex_itime_pin: event.target.value })}
          type="password" inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32} autoComplete="new-password"
          required /></label>}
      </div>
      {editingPin && <p className="muted">Enter the current PIN from Cortex iTime. Saved site activations stay linked to the guard.</p>}
      <p className="muted">{pinSaved
        ? "Activate the existing PIN for the new site in Cortex iTime, then select the site here and save."
        : "Enter this guard's PIN once and choose the first site where it has been activated."}</p>
    </>}
  </fieldset>;
}

export function cortexActivationWarning(guard, site) {
  const activeSites = guard.cortex_itime_enabled ? (guard.cortex_itime_sites || []).filter((entry) => entry.active && entry.id !== site.id) : [];
  const previousSites = activeSites.map((entry) => entry.name).join(", ");
  return previousSites
    ? `${guard.name}'s PIN is active at ${previousSites}. Activate the same PIN for ${site.name}, then confirm the site in the employee record.`
    : `Activate ${guard.name}'s Cortex iTime PIN for ${site.name}, then confirm the site in the employee record.`;
}

export function GuardCortexITime({ api }) {
  const [access, setAccess] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api("/employees/cortex-itime/", { cache: "no-store", signal: controller.signal, silentLoading: true, silentError: true })
      .then((data) => { if (!controller.signal.aborted) setAccess(data); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [api, attempt]);

  return <>
    <header className="page-heading guard-access-heading"><div>
      <p className="eyebrow">GUARD PORTAL</p><h2>Cortex iTime</h2>
      <p className="muted">Use your PIN at any of the active sites listed below.</p>
    </div></header>
    {error ? <section className="panel">
      <p className="error" role="alert">{error}</p>
      <button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </section> : !access ? <section className="panel" role="status">Loading your PIN…</section>
      : !access.pin ? <section className="panel">The office has yet to activate your PIN for a site.</section>
      : <div className="guard-access-layout">
        <section className="panel guard-access-pin" aria-labelledby="cortex-pin-title">
          <div className="guard-access-card-title">
            <span className="guard-access-icon"><KeyRound size={19} aria-hidden="true" /></span>
            <h3 id="cortex-pin-title">Your Cortex iTime PIN</h3>
          </div>
          <strong className="guard-pin-value">{access.pin}</strong>
          <p>Keep your code safe and use it to record your attendance.</p>
        </section>
        <section className="panel guard-access-sites" aria-labelledby="cortex-sites-title">
          <div className="guard-access-card-title">
            <span className="guard-access-icon"><MapPin size={19} aria-hidden="true" /></span>
            <h3 id="cortex-sites-title">Active sites</h3>
          </div>
          <ul>{access.sites.map(({ name, site_id }) => <li key={site_id}><strong>{name}</strong><span>{site_id}</span></li>)}</ul>
        </section>
        <section className="panel guard-access-instructions cortex-attendance-notice" aria-labelledby="cortex-notice-title">
          <div className="guard-access-card-title">
            <span className="guard-access-icon"><ShieldAlert size={19} aria-hidden="true" /></span>
            <h3 id="cortex-notice-title">Attendance &amp; salary deductions</h3>
          </div>
          <p>At the start and end of every shift at a Cortex-enabled Clipfine site, you must <strong>Book On and Book Off</strong> on the site phone or tablet using the Cortex app. Use Cortex for all attendance at these sites. Your PIN works at the active sites listed above.</p>
          <p>Clipfine uses Cortex to calculate working hours and process timesheets. Booking on or off late, forgetting to sign out, or recording attendance incorrectly may lead to missing payable hours and salary deductions. It is your responsibility to check that every shift is recorded correctly.</p>
          <p>If you are unsure how to use Cortex or have trouble booking on or off, contact <strong>Control Room</strong> or your site colleague immediately.</p>
          <p>Thank you for your cooperation.<br /><strong>Control Room</strong></p>
        </section>
      </div>}
  </>;
}
