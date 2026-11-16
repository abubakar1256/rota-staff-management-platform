import { useId, useState } from "react";
import { ChevronDown, MapPin } from "lucide-react";
import { SiteLocationLinks } from "./SiteLocation";
import { sitePoint } from "./siteCoordinates";
import "./guardAttendancePage.css";

export function GuardAttendanceDetails({ label, icon: Icon, hint, onToggle, children }) {
  return <details className="guard-attendance-details" onToggle={onToggle}>
    <summary>
      {Icon && <Icon size={16} aria-hidden="true" />}
      <span>{label}</span>
      {hint && <small>{hint}</small>}
      <ChevronDown size={16} className="guard-attendance-chevron" aria-hidden="true" />
    </summary>
    <div className="guard-attendance-details-body">{children}</div>
  </details>;
}

export function GuardAttendanceReason({ label, value, onChange, onSave, saved, saving, hint, maxLength, inline = false }) {
  const inputId = useId();
  const fields = <div className="guard-attendance-reason-fields">
    <label htmlFor={inputId}>{label}</label>
    {hint && <small>{hint}</small>}
    <textarea id={inputId} rows={2} value={value} onChange={(event) => onChange(event.target.value)} maxLength={maxLength} />
    {onSave && <button type="button" className="secondary-button" disabled={saving} onClick={onSave}>
      {saving ? "Saving…" : saved ? "Update reason" : "Save reason"}
    </button>}
  </div>;

  return inline ? fields : <GuardAttendanceDetails label={saved ? "Reason saved" : "Add reason"}>{fields}</GuardAttendanceDetails>;
}

function attendanceMapUrl(location, item) {
  const point = sitePoint(location?.latitude, location?.longitude);
  if (!point) return "";
  const site = sitePoint(item.site_latitude, item.site_longitude) || point;
  const { latitude, longitude } = point;
  const padding = Math.max(0.002, Math.abs(latitude - site.latitude) * 0.35, Math.abs(longitude - site.longitude) * 0.35);
  const bounds = [
    Math.min(longitude, site.longitude) - padding,
    Math.min(latitude, site.latitude) - padding,
    Math.max(longitude, site.longitude) + padding,
    Math.max(latitude, site.latitude) + padding,
  ].map((value) => value.toFixed(6)).join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bounds)}&layer=mapnik&marker=${latitude},${longitude}`;
}

export function GuardAttendanceSite({ item, location, locationLabel, current }) {
  const [mapOpen, setMapOpen] = useState(false);
  const mapUrl = mapOpen ? attendanceMapUrl(location, item) : "";
  return <GuardAttendanceDetails
    label="Site directions & GPS" icon={MapPin}
    hint={item.site_geofence_radius_m > 0 ? `Stay within ${item.site_geofence_radius_m} m` : undefined}
    onToggle={(event) => setMapOpen(event.currentTarget.open)}
  >
    <SiteLocationLinks item={item} />
    {mapUrl && <div className="guard-attendance-map">
      <strong>{current ? "Current location" : "Last recorded location"}</strong>
      <small>{locationLabel}{location.accuracy ? ` · ±${Math.round(location.accuracy)} m` : ""}</small>
      <iframe title={`Attendance location at ${item.site_name}`} src={mapUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
    </div>}
  </GuardAttendanceDetails>;
}
