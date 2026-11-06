import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, FileText, Plus, Upload } from "lucide-react";
import { certificateLabel, certificateTypes, documentComplete, documentFileUrl, documentsProgress, findStepDocument, localDate, optionalDocumentItems, requiredDocumentItems, saveDocument } from "./documentWizard";
import "./profileWizard.css";
import "./documentWizard.css";

function ReviewStatus({ document }) {
  if (!document) return null;
  return <div className={`document-review-state ${(document.verification_status || "PENDING").toLowerCase()}`}><strong>{document.verification_status === "REJECTED" ? "Needs correction" : document.verification_status === "VERIFIED" ? "Verified by the office" : "Saved — awaiting office review"}</strong>{document.rejection_reason && <small>{document.rejection_reason}</small>}</div>;
}

function DocumentEditor({ item, existing, draft, onChange, disabled, FilePreview, Image }) {
  const file = draft.file;
  return <div className="guard-document-editor">
    <ReviewStatus document={existing} />
    {item.photo && documentFileUrl(existing) && <div className="guard-document-photo"><Image src={documentFileUrl(existing)} alt="Your profile picture" /></div>}
    {!item.photo && <div className="form-grid">
      {(item.number || item.code) && <label>{item.code ? "Code / number" : "Card number"}<input required={Boolean(item.number)} maxLength={100} value={draft.document_number ?? existing?.document_number ?? ""} onChange={(event) => onChange({ document_number: event.target.value })} /></label>}
      {item.issue && <label>Document date<input required type="date" max={localDate()} value={draft.issue_date ?? existing?.issue_date ?? ""} onChange={(event) => onChange({ issue_date: event.target.value })} /></label>}
      {(item.expiry || item.optionalExpiry) && <label>
        {item.optionalExpiry ? "Expiry date (optional)" : "Expiry date"}
        <input required={Boolean(item.expiry)} type="date" min={localDate()}
          value={draft.expiry_date ?? existing?.expiry_date ?? ""}
          onChange={(event) => onChange({ expiry_date: event.target.value })} />
      </label>}
    </div>}
    {item.photo ? (!existing && <p className="muted">Upload your passport-size picture in <strong>My profile</strong>, then return here.</p>) : <label className="guard-document-upload"><Upload size={21} /><strong>{file ? file.name : existing ? "Choose a replacement file" : "Choose a file"}</strong><span>PDF, JPG, PNG or WEBP · up to 10 MB</span><input key={`${item.key}-${existing?.updated_at || "new"}-${file?.name || "empty"}`} disabled={disabled} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => onChange({ file: event.target.files?.[0] || null })} /></label>}
    {item.code && existing?.notes && <p className="guard-document-note">Saved code / notes: {existing.notes}</p>}
    {!item.photo && documentFileUrl(existing) && <FilePreview value={documentFileUrl(existing)} label={item.label} buttonLabel="View saved file" />}
  </div>;
}

function Certificates({ profile, documents, api, onSaved, FilePreview, onDirty }) {
  const [type, setType] = useState("ACT"), [name, setName] = useState(""), [expiry, setExpiry] = useState("");
  const [files, setFiles] = useState([]), [editing, setEditing] = useState(null), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [fileKey, setFileKey] = useState(0);
  useEffect(() => { onDirty(Boolean(files.length || editing || name || expiry)); }, [files, editing, name, expiry]);
  const reset = () => { setFiles([]); setEditing(null); setName(""); setExpiry(""); setError(""); setFileKey((value) => value + 1); };
  const submit = async (event) => {
    event.preventDefault(); setError("");
    if (!files.length && !editing) { setError("Choose at least one certificate file."); return; }
    if (type === "OTHER" && !name.trim()) { setError("Enter the certificate name."); return; }
    if (files.some((file) => file.size > 10 * 1024 * 1024)) { setError("Each certificate must be 10 MB or smaller."); return; }
    setSaving(true);
    const remaining = [...files];
    try {
      for (const file of files.length ? files : [null]) {
        const saved = await saveDocument(api, profile, { label: "Certificates", certificate: true, expiry: type === "ACT" }, editing, { ...(file ? { file } : {}), certificate_type: type, certificate_name: name, expiry_date: expiry });
        onSaved(saved);
        if (file) remaining.shift();
      }
      reset();
    } catch (err) { setFiles(remaining); setError(err.message); } finally { setSaving(false); }
  };
  const filename = (document) => { try { return decodeURIComponent(String(document.file || document.file_url || "").split("?")[0].split("/").pop() || ""); } catch { return ""; } };
  const certificates = documents.filter((document) => ["Certificates", "ACT certificate"].includes(document.document_type));
  return <section className="guard-certificates"><h4>Certificates <span className="status-pill neutral">Optional</span></h4>
    <p className="muted">Add as many certificates as you need. You can select multiple files for the same certificate type.</p>
    {certificates.map((document) => <article key={document.id} className="guard-certificate-record"><div><strong>{certificateLabel(document)}</strong>{filename(document) && <small>{filename(document)}</small>}{document.expiry_date && <small>Expires: {document.expiry_date}</small>}<ReviewStatus document={document} /></div><div className="row-actions">{documentFileUrl(document) && <FilePreview value={documentFileUrl(document)} label={certificateLabel(document)} buttonLabel="View" />}<button type="button" className="mini-button" disabled={saving} onClick={() => { setEditing(document); setType(document.certificate_type || "ACT"); setName(document.certificate_name || ""); setExpiry(document.expiry_date || ""); setFiles([]); setFileKey((value) => value + 1); }}>Update</button></div></article>)}
    <form onSubmit={submit}><fieldset disabled={saving}><div className="form-grid"><label>Certificate type<select disabled={editing?.document_type === "ACT certificate"} value={type} onChange={(event) => setType(event.target.value)}>{certificateTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{type === "OTHER" && <label>Certificate name<input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></label>}<label>Expiry date {type !== "ACT" && "(optional)"}<input required={type === "ACT"} type="date" min={localDate()} value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label><label className="full-width">{editing ? "Replacement file (optional)" : "Certificate files"}<input key={fileKey} required={!editing} type="file" multiple={!editing} accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => setFiles(Array.from(event.target.files || []))} /></label></div>{files.length > 0 && <ul className="guard-certificate-files">{files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name}</li>)}</ul>}{error && <p className="error" role="alert">{error}</p>}<div className="row-actions"><button type="submit" className="secondary-button">{saving ? "Saving…" : editing ? "Save certificate changes" : <><Plus size={15} />Add certificates</>}</button>{(editing || files.length > 0 || name || expiry) && <button type="button" className="mini-button" onClick={reset}>Cancel</button>}</div></fieldset></form>
  </section>;
}

export default function GuardDocumentsWizard({ api, FilePreview, Image, onProfile, initialDocumentId }) {
  const [profile, setProfile] = useState(null), [documents, setDocuments] = useState([]), [drafts, setDrafts] = useState({});
  const [step, setStep] = useState(0), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [certificateDirty, setCertificateDirty] = useState(false);
  const heading = useRef(null), previousStep = useRef(0);
  const load = async () => {
    setLoading(true); setError("");
    try {
      const person = await api("/employees/me/", { silentLoading: true });
      const uploaded = await api(`/documents/?employee=${person.id}`, { silentLoading: true });
      setProfile(person); setDocuments(uploaded);
      const required = requiredDocumentItems(person);
      const missing = required.findIndex((item) => !documentComplete(item, findStepDocument(item, uploaded)));
      const requested = uploaded.find((document) => document.id === initialDocumentId);
      const requestedStep = requested ? required.findIndex((item) => [item.label, ...(item.aliases || [])].includes(requested.document_type)) : -1;
      setStep(requested ? (requestedStep >= 0 ? requestedStep : required.length) : missing < 0 ? required.length + 1 : missing);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (step !== previousStep.current) { previousStep.current = step; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: "start", behavior: "smooth" }); } }, [step]);
  const onSaved = (saved) => setDocuments((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
  const setDraft = (key, changes) => { setDrafts((current) => ({ ...current, [key]: { ...current[key], ...changes } })); setError(""); setNotice(""); };
  const persist = async (item) => {
    const draft = drafts[item.key] || {};
    if (draft.file?.size > 10 * 1024 * 1024) throw new Error("Each document must be 10 MB or smaller.");
    const saved = await saveDocument(api, profile, item, findStepDocument(item, documents), draft);
    onSaved(saved); setDrafts((current) => ({ ...current, [item.key]: {} }));
    return saved;
  };
  const saveOptional = async (item) => {
    setSaving(true); setError(""); setNotice("");
    try { await persist(item); setNotice(`${item.label} saved. The office will review your update.`); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  if (loading) return <section className="panel" role="status">Loading your documents…</section>;
  if (!profile) return <section className="panel"><p className="error" role="alert">{error || "Your documents could not be loaded."}</p><button type="button" className="secondary-button" onClick={load}>Try again</button></section>;
  const required = requiredDocumentItems(profile), progress = documentsProgress(profile, documents);
  const optionalStep = required.length, reviewStep = optionalStep + 1;
  const item = required[step];
  const changeStep = (next) => { setStep(next); setError(""); setNotice(""); };
  const next = async (event) => {
    event.preventDefault(); setError(""); setNotice("");
    if (step === optionalStep) {
      if (certificateDirty || optionalDocumentItems.some((option) => Object.keys(drafts[option.key] || {}).length)) { setError("Save your selected optional documents or cancel the changes before continuing."); return; }
      changeStep(reviewStep); return;
    }
    setSaving(true);
    try { await persist(item); changeStep(step + 1); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  return <>
    <div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2>My documents</h2><p className="muted">Follow each step to complete your required documents. Your progress is saved as you continue.</p></div><span className="profile-progress-badge">{progress.percentage}% complete</span></div>
    <section className="panel profile-wizard-progress"><div><strong>{profile.name}</strong><span>{profile.employee_id}</span></div><div className="profile-wizard-progress-row"><strong>Required documents</strong><span>{progress.completed} of {progress.required} · {progress.percentage}%</span></div><div className="progress-track" role="progressbar" aria-label="Documents completion" aria-valuenow={progress.percentage} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress.percentage}%` }} /></div><small>Optional documents do not affect your percentage. Saved documents are reviewed by the office.</small></section>
    <section className="panel guard-documents-wizard">
      <nav className="guard-document-steps" aria-label="Document steps">{[...required, { key: "optional", label: "Optional documents" }, { key: "review", label: "Review" }].map((entry, index) => <button key={entry.key} type="button" disabled={saving} aria-current={step === index ? "step" : undefined} onClick={() => { if (index !== step && (certificateDirty || (index > step && Object.values(drafts).some((draft) => Object.keys(draft).length)))) { setError("Save or cancel your changes before changing steps."); return; } if (index > step && required.slice(0, Math.min(index, required.length)).some((option) => !documentComplete(option, findStepDocument(option, documents)))) { setError("Complete each required document before moving to a later step."); return; } changeStep(index); }}><span>{index < required.length && documentComplete(entry, findStepDocument(entry, documents)) ? "✓" : index + 1}</span>{entry.label}</button>)}</nav>
      <div className="profile-wizard-step-title"><span>Step {step + 1} of {required.length + 2}</span><h3 ref={heading} tabIndex={-1}>{item?.label || (step === optionalStep ? "Optional documents" : "Review your documents")}</h3>{item?.hint && <p className="muted">{item.hint}</p>}</div>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
      {item && <form onSubmit={next}><fieldset disabled={saving}><DocumentEditor item={item} existing={findStepDocument(item, documents)} draft={drafts[item.key] || {}} onChange={(changes) => setDraft(item.key, changes)} disabled={saving} FilePreview={FilePreview} Image={Image} />{item.photo && <button type="button" className="secondary-button" onClick={onProfile}>Open My profile</button>}<div className="profile-wizard-actions">{step > 0 && <button type="button" className="secondary-button" onClick={() => changeStep(step - 1)}><ChevronLeft size={16} />Back</button>}<button type="submit" className="primary-button">{saving ? "Saving…" : "Save & next"}<ChevronRight size={16} /></button></div></fieldset></form>}
      {step === optionalStep && <>
        <p className="muted">Upload these only if you have them. You can continue without adding any optional documents.</p>
        <div className="guard-optional-documents">{optionalDocumentItems.map((option) => <details key={option.key} open={initialDocumentId && findStepDocument(option, documents)?.id === initialDocumentId ? true : undefined}><summary>{option.label}<span className="status-pill neutral">Optional</span></summary><form onSubmit={(event) => { event.preventDefault(); saveOptional(option); }}><fieldset disabled={saving}><DocumentEditor item={option} existing={findStepDocument(option, documents)} draft={drafts[option.key] || {}} onChange={(changes) => setDraft(option.key, changes)} disabled={saving} FilePreview={FilePreview} Image={Image} /><div className="row-actions"><button className="secondary-button" type="submit">{saving ? "Saving…" : "Save document"}</button>{Object.keys(drafts[option.key] || {}).length > 0 && <button type="button" className="mini-button" onClick={() => setDrafts((current) => ({ ...current, [option.key]: {} }))}>Cancel changes</button>}</div></fieldset></form></details>)}</div>
        <Certificates profile={profile} documents={documents} api={api} onSaved={onSaved} FilePreview={FilePreview} onDirty={setCertificateDirty} />
        <div className="profile-wizard-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => { if (certificateDirty) { setError("Save or cancel your certificate changes first."); return; } changeStep(step - 1); }}><ChevronLeft size={16} />Back</button><button type="button" className="primary-button" disabled={saving} onClick={next}>Next<ChevronRight size={16} /></button></div>
      </>}
      {step === reviewStep && <><div className="guard-documents-summary">{progress.percentage === 100 ? <><CheckCircle2 size={32} /><h3>Required documents complete</h3><p>Your documents are saved. The office will verify them and notify you if changes are needed.</p></> : <><FileText size={32} /><h3>Some documents need attention</h3><p>Complete or replace the required documents below.</p></>}</div><div className="guard-document-review-list">{required.map((option, index) => { const existing = findStepDocument(option, documents); return <article key={option.key}><div><strong>{option.label}</strong><span>{documentComplete(option, existing) ? "Saved" : "Needs attention"}</span></div><button type="button" className="mini-button" onClick={() => changeStep(index)}>View / update</button></article>; })}</div><div className="profile-wizard-actions"><button type="button" className="secondary-button" onClick={() => changeStep(optionalStep)}>View optional documents</button></div></>}
    </section>
  </>;
}
