import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

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
    <header className="page-heading"><div>
      <p className="eyebrow">GUARD PORTAL</p><h2>Cortex iTime</h2>
      <p className="muted">Use your PIN at any of the active sites listed below.</p>
    </div></header>
    {error ? <section className="panel">
      <p className="error" role="alert">{error}</p>
      <button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </section> : !access ? <section className="panel" role="status">Loading your PIN…</section>
      : !access.pin ? <section className="panel">The office has yet to activate your PIN for a site.</section>
      : <section className="panel">
        <h3>Your Cortex iTime PIN</h3>
        <strong className="guard-pin-value">{access.pin}</strong>
        <h3>Active sites</h3>
        <ul>{access.sites.map(({ name, site_id }) => <li key={site_id}>{name} · {site_id}</li>)}</ul>
      </section>}
  </>;
}
