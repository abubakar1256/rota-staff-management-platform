import { useEffect, useState } from "react";

export function EmployeeTimeGateFields({ form, setForm }) {
  const [editing, setEditing] = useState(false);
  return <fieldset className="full-width guard-pin-setting">
    <legend>TimeGate</legend>
    <div className="guard-pin-actions">
      <p className="muted">{form.timegate_pin_saved ? "Guard PIN saved." : "Add the guard’s TimeGate PIN to show it in the guard portal."}</p>
      <button type="button" className="mini-button" aria-expanded={editing} onClick={() => {
        if (editing) setForm({ ...form, timegate_pin: "" });
        setEditing(!editing);
      }}>{editing ? "Cancel PIN change" : form.timegate_pin_saved ? "Edit TimeGate PIN" : "Add TimeGate PIN"}</button>
    </div>
    {editing && <label>TimeGate PIN<input value={form.timegate_pin} onChange={(event) => setForm({ ...form, timegate_pin: event.target.value })}
      type="password" inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32} autoComplete="new-password" required /></label>}
  </fieldset>;
}

export function GuardTimeGate({ api }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api("/employees/timegate/", { cache: "no-store", signal: controller.signal, silentLoading: true, silentError: true })
      .then((data) => { if (!controller.signal.aborted) setPin(data.pin); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [api, attempt]);

  return <>
    <header className="page-heading"><div>
      <p className="eyebrow">GUARD PORTAL</p><h2>TimeGate</h2>
      <p className="muted">Your TimeGate PIN for use at TimeGate sites.</p>
    </div></header>
    {error ? <section className="panel">
      <p className="error" role="alert">{error}</p>
      <button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </section> : pin ? <section className="panel">
      <h3>Your TimeGate PIN</h3>
      <strong className="guard-pin-value">{pin}</strong>
    </section> : <section className="panel" role="status">Loading your PIN…</section>}
  </>;
}
