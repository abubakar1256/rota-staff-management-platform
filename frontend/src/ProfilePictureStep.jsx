import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import PassportPhotoCropper from "./PassportPhotoCropper";
import { saveProfilePhoto } from "./profilePhotoUpload.js";

export default forwardRef(function ProfilePictureStep({ api, profile, Image, onReadyChange, onPhotoChange }, ref) {
  const [photo, setPhoto] = useState(null), [source, setSource] = useState(null), [crop, setCrop] = useState(null);
  const [settings, setSettings] = useState(null), [preview, setPreview] = useState("");
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const input = useRef(null);
  useEffect(() => {
    if (!photo) { setPreview(""); return undefined; }
    const url = URL.createObjectURL(photo); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => { onReadyChange(Boolean(photo || profile.profile_photo_url) && !crop && !saving); }, [photo, profile.profile_photo_url, crop, saving, onReadyChange]);
  useImperativeHandle(ref, () => ({
    save: async () => {
      if (crop) throw new Error("Finish adjusting your photo before continuing.");
      setSaving(true); setError("");
      try { return await saveProfilePhoto({ api, profile, photo }); }
      catch (err) { setError(err.message); throw err; }
      finally { setSaving(false); }
    },
  }));
  const choose = (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError("Profile picture must be 10 MB or smaller."); return; }
    if (!/\.(jpe?g|png|webp)$/i.test(file.name)) { setError("Choose a JPG, PNG or WebP photo."); return; }
    setError(""); setCrop(file);
  };
  return <>
    <div className="profile-picture-step">
      <div className="profile-picture-centered">{preview ? <img src={preview} alt="Your cropped profile picture" /> : profile.profile_photo_url ? <Image src={profile.profile_photo_url} alt="Your profile picture" /> : <UserRound size={54} aria-label="No profile picture selected" />}</div>
      <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp" disabled={saving} onChange={choose} aria-label="Choose profile photo" />
      <div className="profile-picture-controls"><button type="button" className="secondary-button" disabled={saving} onClick={() => input.current?.click()}>{photo || profile.profile_photo_url ? "Change photo" : "Choose photo"}</button>{photo && source && <button type="button" className="text-button" disabled={saving} onClick={() => setCrop(source)}>Adjust crop</button>}</div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    {crop && <PassportPhotoCropper file={crop} initialCrop={crop === source ? settings : undefined} onCancel={() => setCrop(null)} onConfirm={(cropped, cropSettings) => { setPhoto(cropped); setSource(crop); setSettings(cropSettings); setCrop(null); onPhotoChange(); }} />}
  </>;
});
