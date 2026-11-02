import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import NationalitySelect from "./NationalitySelect";
import ProfilePictureStep from "./ProfilePictureStep";
import { findNationality } from "./nationalities";
import { profileDraft, profileFields, profileFieldLabels, profilePercentage, profileStepError, profileSteps, stepFields } from "./profileWizard";
import "./profileWizard.css";

export default function GuardProfileWizard({ api, Image }) {
  const [profile, setProfile] = useState(null), [form, setForm] = useState(() => profileDraft());
  const [step, setStep] = useState(0), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [accepted, setAccepted] = useState(false), [submitted, setSubmitted] = useState(false), [photoReady, setPhotoReady] = useState(false);
  const picture = useRef(null);
  const heading = useRef(null), previousStep = useRef(0);
  const load = () => {
    setLoading(true); setError("");
    return api("/employees/me/", { silentLoading: true }).then((data) => { setProfile(data); setForm(profileDraft(data)); setAccepted(Boolean(data.profile_declaration_accepted_at)); setSubmitted(Boolean(data.profile_declaration_accepted_at)); }).catch((err) => setError(err.message)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (previousStep.current !== step) { previousStep.current = step; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ behavior: "smooth", block: "start" }); } }, [step]);
  const update = (field, value) => { setForm((current) => ({ ...current, [field]: value })); setAccepted(false); setSubmitted(false); setError(""); setNotice(""); };
  const saveDraft = async () => {
    setSaving(true); setError(""); setNotice("");
    try {
      const data = await api("/employees/me/", { method: "PATCH", body: JSON.stringify(form), silentToast: true });
      setProfile(data); setNotice("Progress saved. You can return and continue later.");
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
    if (validationError) { setStep(validationError.step); setError(validationError.message); return; }
    if (step === 4) {
      if (!accepted) { setError("Please confirm that all your information is true and correct."); return; }
    }
    setSaving(true);
    try {
      const payload = step === 4 ? { ...form, nationality: findNationality(form.nationality).name, declaration_accepted: accepted } : Object.fromEntries(stepFields[step].map((field) => [field, field === "nationality" ? findNationality(form[field]).name : form[field]]));
      const data = await api(step === 4 ? "/employees/submit-profile/" : "/employees/me/", { method: step === 4 ? "POST" : "PATCH", body: JSON.stringify(payload), silentToast: step !== 4 });
      setProfile(data);
      if (step === 4) { setForm(profileDraft(data)); setSubmitted(true); setAccepted(true); }
      else { setForm((current) => ({ ...current, ...Object.fromEntries(stepFields[step].map((field) => [field, data[field] || ""])) })); setNotice("Progress saved."); setStep((current) => current + 1); }
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  if (loading) return <section className="panel" role="status">Loading your profile…</section>;
  if (!profile) return <section className="panel"><p className="error" role="alert">{error || "Your profile could not be loaded."}</p><button type="button" className="secondary-button" onClick={load}>Try again</button></section>;
  const percentage = profilePercentage(form, profile.profile_photo_url, accepted && profile.profile_declaration_accepted_at);
  const review = <div className="profile-review-grid">{profile.profile_photo_url && <div className="profile-review-photo"><Image src={profile.profile_photo_url} alt="Your passport-size profile picture" /></div>}{profileFields.map((field) => <div key={field}><dt>{profileFieldLabels[field]}</dt><dd>{form[field] || "Not provided"}</dd></div>)}</div>;
  return <>
    <div className="page-heading"><div><p className="eyebrow">GUARD PORTAL</p><h2 tabIndex={-1} ref={heading}>My profile</h2><p className="muted">{percentage === 100 ? "Your profile is complete. Keep your picture and contact details up to date." : "Please complete your profile to 100%. Start with your passport-size picture, then follow the steps below."}</p></div><span className="profile-progress-badge">{percentage}% complete</span></div>
    <section className="panel profile-wizard-progress"><div><strong>{profile.name}</strong><span>{profile.employee_id} · {profile.position || "Guard"}</span></div><div className="profile-wizard-progress-row"><strong>Profile completion</strong><span>{percentage}%</span></div><div className="progress-track" role="progressbar" aria-label="Profile completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div><small>{percentage === 100 ? "Your details and confirmation are complete." : "Your percentage increases as you add your picture and complete your details."}</small></section>
    {submitted ? <section className="panel profile-wizard-success"><CheckCircle2 size={34} /><h3>Profile completed successfully</h3><p>Your profile is 100% complete and your declaration has been recorded.</p>{review}<button type="button" className="secondary-button" onClick={() => { setSubmitted(false); setStep(0); }}>Edit profile</button></section> : <section className="panel profile-wizard">
      <ol className="profile-wizard-steps" aria-label="Profile steps">{profileSteps.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} className={index === step ? "current" : index < step ? "done" : ""}><span>{index < step ? "✓" : index + 1}</span><strong>{label}</strong></li>)}</ol>
      <div className="profile-wizard-step-title"><span>Step {step + 1} of {profileSteps.length}</span><h3>{profileSteps[step]}</h3>{step > 0 && <p className="muted">{["", "Enter your personal details. Type to search for your nationality.", "Keep your phone, login email and address up to date.", "Tell us who to contact in an emergency.", "Check every detail below and confirm the declaration before submitting."][step]} All fields are required.</p>}</div>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
      {step === 0 && <ProfilePictureStep ref={picture} api={api} profile={profile} Image={Image} onReadyChange={setPhotoReady} onPhotoChange={() => setAccepted(false)} />}
      <form onSubmit={next} className="profile-wizard-form">
        <fieldset disabled={saving} className="profile-wizard-fields">
          {step === 1 && <div className="form-grid"><label>Full name<input required maxLength={160} autoComplete="name" value={form.name} onChange={(event) => update("name", event.target.value)} /></label><label>Date of birth<input required type="date" max={new Date().toLocaleDateString("en-CA")} value={form.date_of_birth} onChange={(event) => update("date_of_birth", event.target.value)} /></label><label className="full-width">Nationality<NationalitySelect value={form.nationality} onChange={(value) => update("nationality", value)} disabled={saving} /></label></div>}
          {step === 2 && <div className="form-grid"><label>Email (login username)<input required type="email" autoComplete="email" value={form.email} onChange={(event) => update("email", event.target.value)} /></label><label>Phone number<input required type="tel" maxLength={40} autoComplete="tel" value={form.phone} onChange={(event) => update("phone", event.target.value)} /></label><label className="full-width">Address<textarea required rows={3} autoComplete="street-address" value={form.address} onChange={(event) => update("address", event.target.value)} /></label></div>}
          {step === 3 && <div className="form-grid"><label>Emergency contact name<input required maxLength={160} value={form.emergency_contact_name} onChange={(event) => update("emergency_contact_name", event.target.value)} /></label><label>Emergency contact phone<input required type="tel" maxLength={40} value={form.emergency_contact_phone} onChange={(event) => update("emergency_contact_phone", event.target.value)} /></label><label className="full-width">Relationship<input required maxLength={80} value={form.emergency_contact_relationship} onChange={(event) => update("emergency_contact_relationship", event.target.value)} placeholder="For example: spouse, parent, sibling or friend" /></label></div>}
          {step === 4 && <>{review}<label className="profile-wizard-declaration"><input type="checkbox" required checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>{profile.profile_declaration_text}</span></label><small className="muted">Your confirmation and submission time will be recorded.</small></>}
        </fieldset>
        <div className="profile-wizard-actions">{step > 0 && <button type="button" className="secondary-button" disabled={saving} onClick={() => { setStep((current) => current - 1); setError(""); setNotice(""); }}><ChevronLeft size={16} />Back</button>}{step > 0 && <button type="button" className="secondary-button" disabled={saving} onClick={saveDraft}>Save draft</button>}<button type="submit" className="primary-button" disabled={saving || (step === 0 && !photoReady) || (step === 4 && !accepted)}>{saving ? "Saving…" : step === 4 ? "Submit profile" : step === 0 ? "Next" : "Save & next"}{step < 4 && <ChevronRight size={16} />}</button></div>
      </form>
    </section>}
  </>;
}
