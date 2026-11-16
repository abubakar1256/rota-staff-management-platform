import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import NationalitySelect from "./NationalitySelect";
import ProfilePictureStep from "./ProfilePictureStep";
import { findNationality } from "./nationalities";
import { hasValidWhatsAppNumber, profileDraft, profileFields, profileFieldLabels, profilePercentage, profileStepError, profileSteps, stepFields } from "./profileWizard";
import "./profileWizard.css";

export default function GuardProfileWizard({ api, Image }) {
  const [profile, setProfile] = useState(null), [form, setForm] = useState(() => profileDraft());
  const [step, setStep] = useState(0), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [accepted, setAccepted] = useState(false), [submitted, setSubmitted] = useState(false), [photoReady, setPhotoReady] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const picture = useRef(null);
  const heading = useRef(null), previousStep = useRef(0);
  const load = () => {
    setLoading(true); setError("");
    return api("/employees/me/", { silentLoading: true }).then((data) => {
      const draft = profileDraft(data);
      const confirmed = Boolean(data.profile_declaration_accepted_at);
      const needsWhatsApp = confirmed && Boolean(data.profile_photo_url) && !hasValidWhatsAppNumber(draft.whatsapp_number);
      setProfile(data);
      setForm(draft);
      setAccepted(confirmed);
      setSubmitted(profilePercentage(draft, data.profile_photo_url, confirmed) === 100);
      setEditingContact(needsWhatsApp);
      if (needsWhatsApp) setStep(2);
    }).catch((err) => setError(err.message)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (previousStep.current !== step) { previousStep.current = step; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ behavior: "smooth", block: "start" }); } }, [step]);
  const update = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (field !== "whatsapp_number") setAccepted(false);
    setError(""); setNotice("");
  };
  const withoutUnchangedWhatsApp = ({ whatsapp_number, ...payload }) =>
    whatsapp_number === undefined || whatsapp_number === (profile.whatsapp_number || "")
      ? payload : { ...payload, whatsapp_number };
  const saveDraft = async () => {
    setSaving(true); setError(""); setNotice("");
    try {
      const data = await api("/employees/me/", { method: "PATCH", body: JSON.stringify(withoutUnchangedWhatsApp(form)), silentToast: true });
      setProfile(data); setForm((current) => ({ ...current, whatsapp_number: data.whatsapp_number || "" }));
      setNotice("Progress saved. You can return and continue later.");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const next = async (event) => {
    event.preventDefault(); setError(""); setNotice("");
    if (step === 0) {
      if (!photoReady || !picture.current) { setError("Choose and crop a photo before continuing."); return; }
      setSaving(true);
      try {
        const data = await picture.current.save();
        if (!data?.profile_photo_url) throw new Error("Your picture could not be saved. Please try again.");
        setProfile(data); setAccepted(Boolean(data.profile_declaration_accepted_at)); setStep(1);
      } catch (err) { setError(err.message); } finally { setSaving(false); }
      return;
    }
    if (!profile.profile_photo_url) { setStep(0); setError("Choose a profile photo before continuing."); return; }
    const validationError = profileStepError(form, step);
    if (validationError) {
      if (editingContact && validationError.step !== 2) setEditingContact(false);
      setStep(validationError.step); setError(validationError.message); return;
    }
    if (step === 4) {
      if (!accepted) { setError("Please confirm that all your information is true and correct."); return; }
    }
    setSaving(true);
    try {
      const payload = step === 4 ? { ...form, nationality: findNationality(form.nationality).name, declaration_accepted: accepted } : Object.fromEntries(stepFields[step].map((field) => [field, field === "nationality" ? findNationality(form[field]).name : form[field]]));
      const data = await api(step === 4 ? "/employees/submit-profile/" : "/employees/me/", { method: step === 4 ? "POST" : "PATCH", body: JSON.stringify(withoutUnchangedWhatsApp(payload)), silentToast: step !== 4 });
      setProfile(data);
      if (step === 4) { setForm(profileDraft(data)); setSubmitted(true); setAccepted(true); }
      else if (editingContact && profilePercentage(profileDraft(data), data.profile_photo_url, data.profile_declaration_accepted_at) === 100) {
        setForm(profileDraft(data)); setAccepted(true); setSubmitted(true); setEditingContact(false);
        setNotice("Contact details saved.");
      } else {
        setForm((current) => ({ ...current, ...Object.fromEntries(stepFields[step].map((field) => [field, data[field] || ""])) }));
        setEditingContact(false); setNotice("Progress saved."); setStep((current) => current + 1);
      }
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  if (loading) return <section className="panel" role="status">Loading your profile…</section>;
  if (!profile) return <section className="panel"><p className="error" role="alert">{error || "Your profile could not be loaded."}</p><button type="button" className="secondary-button" onClick={load}>Try again</button></section>;
  const percentage = profilePercentage(form, profile.profile_photo_url, accepted && profile.profile_declaration_accepted_at);
  const review = <div className="profile-review-grid">{profile.profile_photo_url && <div className="profile-review-photo"><Image src={profile.profile_photo_url} alt="Your passport-size profile picture" /></div>}{profileFields.map((field) => <div key={field}><dt>{profileFieldLabels[field]}</dt><dd>{form[field] || "Not provided"}</dd></div>)}</div>;
  const openContactDetails = () => { setError(""); setNotice(""); setStep(2); setEditingContact(true); setSubmitted(false); };
  const cancelContactEdit = () => {
    setForm(profileDraft(profile)); setAccepted(true); setSubmitted(true); setEditingContact(false); setError(""); setNotice("");
  };
  return <>
    <div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2 tabIndex={-1} ref={heading}>My profile</h2><p className="muted">{percentage === 100 ? "Your profile is complete. Keep your picture and contact details up to date." : step === 2 && editingContact ? "Add your WhatsApp number to complete your profile." : "Complete the steps below to finish your profile."}</p></div><span className="profile-progress-badge">{percentage}% complete</span></div>
    <section className="panel profile-wizard-progress"><div><strong>{profile.name}</strong><span>{profile.employee_id} · {profile.position || "Guard"}</span></div><div className="profile-wizard-progress-row"><strong>Profile completion</strong><span>{percentage}%</span></div><div className="progress-track" role="progressbar" aria-label="Profile completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div><small>{percentage === 100 ? "Your details and confirmation are complete." : "Your percentage increases as you add your picture and complete your details."}</small></section>
    {submitted ? <section className="panel profile-wizard-success">
      <CheckCircle2 size={34} /><h3>Profile completed successfully</h3><p>Your profile is 100% complete and your declaration has been recorded.</p>
      {notice && <p className="success" role="status">{notice}</p>}
      {review}
      <div className="profile-wizard-actions">
        <button type="button" className="secondary-button" onClick={() => { setNotice(""); setSubmitted(false); setStep(0); }}>Edit profile</button>
        <button type="button" className="secondary-button" onClick={openContactDetails}>Edit contact details</button>
      </div>
    </section> : <section className="panel profile-wizard">
      <ol className="profile-wizard-steps" aria-label="Profile steps">{profileSteps.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} className={index === step ? "current" : index < step ? "done" : ""}><span>{index < step ? "✓" : index + 1}</span><strong>{label}</strong></li>)}</ol>
      <div className="profile-wizard-step-title"><span>Step {step + 1} of {profileSteps.length}</span><h3>{profileSteps[step]}</h3>{step > 0 && <p className="muted">{["", "Enter your personal details. Type to search for your nationality.", "Keep your contact details up to date so the office can send your rota.", "Tell us who to contact in an emergency.", "Check every detail below and confirm the declaration before submitting."][step]}</p>}</div>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
      {step === 0 && <ProfilePictureStep ref={picture} api={api} profile={profile} Image={Image} onReadyChange={setPhotoReady} onPhotoChange={() => setAccepted(false)} />}
      <form onSubmit={next} className="profile-wizard-form">
        <fieldset disabled={saving} className="profile-wizard-fields">
          {step === 1 && <div className="form-grid"><label>Full name<input required maxLength={160} autoComplete="name" value={form.name} onChange={(event) => update("name", event.target.value)} /></label><label>Date of birth<input required type="date" max={new Date().toLocaleDateString("en-CA")} value={form.date_of_birth} onChange={(event) => update("date_of_birth", event.target.value)} /></label><label className="full-width">Nationality<NationalitySelect value={form.nationality} onChange={(value) => update("nationality", value)} disabled={saving} /></label></div>}
          {step === 2 && <div className="form-grid">
            <label>Email (login username)<input required type="email" autoComplete="email" value={form.email} onChange={(event) => update("email", event.target.value)} /></label>
            <label>Phone number<input required type="tel" maxLength={40} autoComplete="tel" value={form.phone} onChange={(event) => update("phone", event.target.value)} /></label>
            <label className="full-width">WhatsApp number (required)
              <input required type="tel" inputMode="tel" maxLength={40} value={form.whatsapp_number} placeholder="+44 7700 900123"
                onChange={(event) => update("whatsapp_number", event.target.value)} aria-describedby="profile-whatsapp-help" />
              <small id="profile-whatsapp-help" className="muted">Include the country code. The office uses this number for WhatsApp rota and announcements.</small>
            </label>
            <label className="full-width">Address<textarea required rows={3} autoComplete="street-address" value={form.address} onChange={(event) => update("address", event.target.value)} /></label>
          </div>}
          {step === 3 && <div className="form-grid"><label>Emergency contact name<input required maxLength={160} value={form.emergency_contact_name} onChange={(event) => update("emergency_contact_name", event.target.value)} /></label><label>Emergency contact phone<input required type="tel" maxLength={40} value={form.emergency_contact_phone} onChange={(event) => update("emergency_contact_phone", event.target.value)} /></label><label className="full-width">Relationship<input required maxLength={80} value={form.emergency_contact_relationship} onChange={(event) => update("emergency_contact_relationship", event.target.value)} placeholder="For example: spouse, parent, sibling or friend" /></label></div>}
          {step === 4 && <>{review}<label className="profile-wizard-declaration"><input type="checkbox" required checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>{profile.profile_declaration_text}</span></label><small className="muted">Your confirmation and submission time will be recorded.</small></>}
        </fieldset>
        <div className="profile-wizard-actions">
          {editingContact ? hasValidWhatsAppNumber(profile.whatsapp_number) && <button type="button" className="secondary-button" disabled={saving} onClick={cancelContactEdit}>Cancel</button>
            : step > 0 && <><button type="button" className="secondary-button" disabled={saving} onClick={() => { setStep((current) => current - 1); setError(""); setNotice(""); }}><ChevronLeft size={16} />Back</button>
              <button type="button" className="secondary-button" disabled={saving} onClick={saveDraft}>Save draft</button></>}
          <button type="submit" className="primary-button" disabled={saving || (step === 0 && !photoReady) || (step === 4 && !accepted)}>
            {saving ? "Saving…" : editingContact ? "Save contact details" : step === 4 ? "Submit profile" : step === 0 ? "Next" : "Save & next"}
            {!editingContact && step < 4 && <ChevronRight size={16} />}
          </button>
        </div>
      </form>
    </section>}
  </>;
}
