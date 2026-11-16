import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Pencil, RefreshCw, X } from "lucide-react";
import { cortexActivationWarning } from "./CortexITime";
import { ukDate } from "./ukTime";
import "./guardInduction.css";

const statuses = {
  PLANNED: { label: "Planned", style: "pending" },
  COMPLETED: { label: "Completed", style: "active" },
  CANCELLED: { label: "Cancelled", style: "inactive" },
};
const newForm = () => ({ site: "", employee: "", induction_date: ukDate(), induction_time: "", status: "PLANNED", notes: "" });
const editForm = (record) => ({
  site: String(record.site), employee: String(record.employee), induction_date: record.induction_date,
  induction_time: record.induction_time?.slice(0, 5) || "", status: record.status, notes: record.notes || "",
});
const toPayload = (form) => ({
  ...form, site: Number(form.site), employee: Number(form.employee), induction_time: form.induction_time || null,
});
const activationWarning = (record) => record.cortex_activation_required
  ? cortexActivationWarning({ name: record.employee_name }, { name: record.site_name }) : "";

function InductionFields({ form, setForm, sites, guards, record }) {
  const change = ({ target: { name, value } }) => setForm((current) => ({ ...current, [name]: value }));

  return <>
    <label>Site
      <select required name="site" value={form.site} onChange={change}>
        <option value="">Select site</option>
        {record && !sites.some((site) => site.id === record.site) && <option value={record.site}>{record.site_name}</option>}
        {sites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.site_id}</option>)}
      </select>
    </label>
    <label>Guard
      <select required name="employee" value={form.employee} onChange={change}>
        <option value="">Select guard</option>
        {record && !guards.some((guard) => guard.id === record.employee) &&
          <option value={record.employee}>{record.employee_name} · {record.employee_code}</option>}
        {guards.map((guard) => <option key={guard.id} value={guard.id}>{guard.name} · {guard.employee_id}</option>)}
      </select>
    </label>
    <label>Induction date<input required type="date" name="induction_date" value={form.induction_date} onChange={change} /></label>
    <label>Induction time<input type="time" name="induction_time" value={form.induction_time} onChange={change} /></label>
    <label>Status
      <select name="status" value={form.status} onChange={change} autoFocus={Boolean(record)}>
        {Object.entries(statuses).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <label className="full-width">Notes<textarea name="notes" rows={2} maxLength={250} value={form.notes} onChange={change} placeholder="Induction notes" /></label>
  </>;
}

function EditInductionDialog({ api, record, sites, guards, onClose, onSaved }) {
  const [form, setForm] = useState(() => editForm(record));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal(); }, []);

  const initial = editForm(record);
  const updates = Object.fromEntries(Object.entries(toPayload(form)).filter(([field]) => form[field] !== initial[field]));
  const hasUpdates = Object.keys(updates).length > 0;

  async function save(event) {
    event.preventDefault();
    if (saving || !hasUpdates) return;
    setError("");
    setSaving(true);
    try {
      const updated = await api(`/site-inductions/${record.id}/`, {
        method: "PATCH", body: JSON.stringify(updates), silentLoading: true, silentError: true, silentToast: true,
      });
      onSaved(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return <dialog className="modal-card induction-edit-dialog" ref={dialog} aria-labelledby="edit-induction-title"
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <header className="modal-header">
      <div><h3 id="edit-induction-title">Edit induction</h3><p className="muted">{record.employee_name} · {record.site_name}</p></div>
      <button type="button" className="icon-button" aria-label="Close edit induction" disabled={saving} onClick={onClose}><X size={19} /></button>
    </header>
    <form onSubmit={save}>
      <fieldset className="form-grid induction-edit-fields" disabled={saving}>
        <InductionFields form={form} setForm={setForm} sites={sites} guards={guards} record={record} />
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Close</button>
        <button type="submit" className="primary-button" disabled={saving || !hasUpdates}>{saving ? "Saving…" : "Save changes"}</button>
      </div>
    </form>
  </dialog>;
}

function GuardInductionSummary({ guard, documents }) {
  const cardDetails = (card) => {
    const types = [`${card} Card (Front)`, `${card} Card (Front & Back)`, `${card} Card (Back)`];
    const matches = documents.filter((document) => types.includes(document.document_type));
    return [matches.find((document) => document.document_number)?.document_number, matches.find((document) => document.expiry_date)?.expiry_date].filter(Boolean).join(" · ");
  };
  const ppac = documents.find((document) => document.document_type === "PPAC Code");
  const details = [
    ["First name / surname", guard.name],
    ["Date of birth", guard.date_of_birth],
    ["Nationality", guard.nationality],
    ["Contact number", guard.phone],
    ["Email", guard.email],
    ["Emergency contact", [guard.emergency_contact_name || guard.emergency_contact, guard.emergency_contact_phone, guard.emergency_contact_relationship].filter(Boolean).join(" · ")],
    ["Address", guard.address],
    ["SIA card number / expiry", cardDetails("SIA")],
    ["CSCS card number / expiry", cardDetails("CSCS")],
    ["Compliant / PPAC code", ppac?.notes || ppac?.document_number],
  ];
  return <div className="induction-guard-summary">
    <div className="panel-header">
      <div><h3>Guard induction information</h3><p className="muted">Review the guard’s profile and document details.</p></div>
      <span className="status-pill active">Profile linked</span>
    </div>
    <div className="induction-detail-grid">
      {details.map(([label, value]) => <div key={label} className={label === "Address" ? "full-width" : undefined}>
        <span>{label}</span><strong>{value || "Not added yet"}</strong>
      </div>)}
    </div>
    <p className="form-help">After the guard updates My profile or Documents, use Refresh in Induction records to load the latest details.</p>
  </div>;
}

const readOptions = (signal) => ({ signal, cache: "no-store", silentLoading: true, silentError: true });

export default function GuardInductionPage({ api, downloadFile, canManageCortex }) {
  const [form, setForm] = useState(newForm);
  const [siteFilter, setSiteFilter] = useState("");
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [addResult, setAddResult] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activationNotice, setActivationNotice] = useState("");
  const siteQuery = useQuery({ queryKey: ["rota", "sites", "induction"], queryFn: ({ signal }) => api("/sites/", readOptions(signal)), refetchOnMount: "always" });
  const employeeQuery = useQuery({ queryKey: ["rota", "employees", "induction"], queryFn: ({ signal }) => api("/employees/?status=ACTIVE", readOptions(signal)), refetchOnMount: "always" });
  const recordsQuery = useQuery({
    queryKey: ["rota", "site-inductions", siteFilter],
    queryFn: ({ signal }) => api(`/site-inductions/${siteFilter ? `?site=${siteFilter}` : ""}`, readOptions(signal)),
    refetchOnMount: "always",
  });
  const documentsQuery = useQuery({
    queryKey: ["rota", "documents", "induction", form.employee],
    queryFn: ({ signal }) => api(`/documents/?employee=${form.employee}`, readOptions(signal)),
    enabled: Boolean(form.employee),
    refetchOnMount: "always",
  });

  const sites = siteQuery.data || [];
  const guards = (employeeQuery.data || []).filter((employee) => employee.portal_status === "ACTIVE");
  const inductions = recordsQuery.data || [];
  const selectedGuard = guards.find((guard) => String(guard.id) === form.employee);
  const selectedSite = sites.find((site) => String(site.id) === form.site);
  const needsCortexActivation = canManageCortex && form.status !== "CANCELLED" && selectedGuard && selectedSite?.is_active
    && selectedSite.cortex_itime_enabled && (!selectedGuard.cortex_itime_enabled || !selectedGuard.cortex_itime_sites?.some((entry) => entry.id === selectedSite.id));

  async function refresh() {
    setRefreshing(true); setError(""); setNotice(""); setActivationNotice("");
    try {
      const queries = [siteQuery, employeeQuery, recordsQuery, ...(form.employee ? [documentsQuery] : [])];
      await Promise.all(queries.map((query) => query.refetch({ throwOnError: true })));
      setNotice("Induction records refreshed.");
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true); setAddResult(null);
    try {
      const record = await api("/site-inductions/", { method: "POST", body: JSON.stringify(toPayload(form)), silentToast: true, silentError: true });
      setAddResult({ saved: true, warning: activationWarning(record) });
      setForm((current) => ({ ...current, employee: "", induction_time: "", notes: "" }));
    } catch (err) {
      setAddResult({ error: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function downloadInduction(record) {
    setError(""); setNotice("");
    try {
      const name = (record.employee_name || "Guard").replace(/[^a-z0-9 ._-]/gi, "").trim() || "Guard";
      await downloadFile(`/site-inductions/${record.id}/download-csv/`, `${name} - induction.csv`, { cache: "no-store" });
      setNotice(`${record.employee_name} induction downloaded.`);
    } catch (err) {
      setError(err.message);
    }
  }

  const queryError = [siteQuery.error, employeeQuery.error, recordsQuery.error, documentsQuery.error].find(Boolean);
  return <>
    <div className="page-heading">
      <div><p className="eyebrow">SITE COMPLIANCE</p><h2>Guard induction</h2><p className="muted">Review guard details before assigning them to a site.</p></div>
    </div>
    <section className="panel induction-page-form">
      <div className="panel-header">
        <div><h3>Add induction</h3><p className="muted">Select a guard with active portal access to review their profile and documents.</p></div>
      </div>
      <form className="form-grid" onSubmit={save}>
        <InductionFields form={form} setForm={setForm} sites={sites} guards={guards} />
        {needsCortexActivation && <p className="cortex-itime-warning full-width" role="status">{cortexActivationWarning(selectedGuard, selectedSite)}</p>}
        <div className="form-actions full-width">
          <button className="primary-button" disabled={saving || !guards.length || !sites.length}>{saving ? "Saving…" : "Save induction"}</button>
        </div>
      </form>
      {addResult?.error && <p className="error" role="alert">{addResult.error}</p>}
      {addResult?.saved && <p className="success" role="status">Induction saved.</p>}
      {addResult?.warning && <p className="cortex-itime-warning" role="status">{addResult.warning}</p>}
      {selectedGuard && <GuardInductionSummary guard={selectedGuard} documents={documentsQuery.data || []} />}
      {employeeQuery.isSuccess && !guards.length && <p className="muted form-help">No guards with completed portal access are available yet.</p>}
    </section>
    <section className="panel induction-records">
      <div className="panel-header">
        <div><h3>Induction records</h3><p className="muted">Weekly Rota uses completed inductions to find guards for each site.</p></div>
        <div className="document-toolbar">
          <select aria-label="Filter inductions by site" value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}>
            <option value="">All sites</option>
            {sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
          </select>
          <button type="button" className="secondary-button" disabled={refreshing || saving} onClick={refresh}>
            <RefreshCw size={15} /> {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {!recordsQuery.isPending && !recordsQuery.isError && <span className="muted">{inductions.length} records</span>}
        </div>
      </div>
      {(error || queryError) && <p className="error" role="alert">{error || queryError.message}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {activationNotice && <p className="cortex-itime-warning" role="status">{activationNotice}</p>}
      {recordsQuery.isPending ? <div className="empty-state compact-empty">Loading induction records…</div>
        : inductions.length ? <div className="table-wrap"><table>
          <thead><tr><th>Site</th><th>Guard</th><th>Induction date/time</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>{inductions.map((record) => {
            const status = statuses[record.status];
            return <tr key={record.id}>
              <td><strong>{record.site_name}</strong></td>
              <td>{record.employee_name}<small className="table-subtext">{record.employee_code}</small></td>
              <td>{record.induction_date}{record.induction_time && ` · ${record.induction_time.slice(0, 5)}`}</td>
              <td><span className={`status-pill ${status.style}`}>{status.label}</span>
                {record.cortex_activation_required && <small className="table-subtext">Cortex iTime PIN activation required</small>}
              </td>
              <td>{record.notes || "—"}</td>
              <td><div className="induction-record-actions">
                <button type="button" className="mini-button" onClick={() => { setEditing(record); setError(""); setNotice(""); setActivationNotice(""); }}>
                  <Pencil size={13} /> Edit
                </button>
                <button type="button" className="mini-button" onClick={() => downloadInduction(record)}><Download size={13} /> CSV</button>
              </div></td>
            </tr>;
          })}</tbody>
        </table></div> : !recordsQuery.isError && <div className="empty-state compact-empty">No induction records found.</div>}
    </section>
    {editing && <EditInductionDialog api={api} record={editing} sites={sites} guards={guards} onClose={() => setEditing(null)}
      onSaved={(record) => { setEditing(null); setNotice("Induction updated."); setActivationNotice(activationWarning(record)); }} />}
  </>;
}
