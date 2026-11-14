import { useState } from "react";
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";

const empty = { name: "", instructions: "", required: false };

export default function DocumentOptions({ api, options, onChange }) {
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = async (option, method, values) => {
    setBusy(true);
    setError("");
    try {
      const saved = await api(`/document-options/${option ? `${option.id}/` : ""}`, {
        method, body: values ? JSON.stringify(values) : undefined, silentError: true,
      });
      onChange(method === "DELETE" ? { ...option, is_active: false } : saved);
      setDraft(null);
      setEditing(null);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const edit = (option) => {
    setEditing(option);
    setDraft(option || empty);
    setError("");
  };

  return <section className="panel document-options-panel" aria-label="Manage document options">
    <div className="panel-header">
      <div>
        <h3>Document options</h3>
        <p className="muted">Add uploads for all guards. Required uploads count towards document completion.</p>
      </div>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => edit(null)}><Plus size={15} /> Add option</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {draft && <form className="document-option-form" onSubmit={(event) => {
      event.preventDefault();
      update(editing, editing ? "PATCH" : "POST", { name: draft.name.trim(), instructions: draft.instructions.trim(), required: draft.required });
    }}>
      <fieldset disabled={busy}>
        <legend>{editing ? "Edit document option" : "New document option"}</legend>
        <div className="form-grid">
          <label>Document name<input autoFocus required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>Upload requirement<select value={draft.required ? "required" : "optional"} onChange={(event) => setDraft({ ...draft, required: event.target.value === "required" })}>
            <option value="optional">Optional</option><option value="required">Required</option>
          </select></label>
          <label className="full-width">Instructions for guards (optional)<textarea rows={2} maxLength={500} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
        </div>
        <div className="row-actions">
          <button type="button" className="secondary-button" onClick={() => { setDraft(null); setEditing(null); setError(""); }}>Cancel</button>
          <button type="submit" className="primary-button" disabled={!draft.name.trim()}>{busy ? "Saving…" : "Save option"}</button>
        </div>
      </fieldset>
    </form>}
    {options.length ? <ul className="document-option-list">
      {options.map((option) => <li key={option.id}>
        <div><strong>{option.name}</strong>{option.instructions && <p>{option.instructions}</p>}</div>
        <span className={`status-pill ${option.is_active && option.required ? "pending" : "neutral"}`}>
          {option.is_active ? (option.required ? "Required" : "Optional") : "Removed"}
        </span>
        <div className="row-actions">
          <button type="button" className="mini-button" disabled={busy} onClick={() => edit(option)}><Pencil size={13} /> Edit</button>
          {option.is_active
            ? <button type="button" className="mini-button" disabled={busy} onClick={() => {
              if (window.confirm(`Remove "${option.name}" from the guard checklist? Existing uploads will be kept.`)) update(option, "DELETE");
            }}><Trash2 size={13} /> Remove</button>
            : <button type="button" className="mini-button" disabled={busy} onClick={() => update(option, "PATCH", { is_active: true })}><RotateCcw size={13} /> Restore</button>}
        </div>
      </li>)}
    </ul> : <p className="muted">No custom document options yet.</p>}
  </section>;
}
