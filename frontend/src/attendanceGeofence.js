const numeric = (value) => value == null || typeof value === "boolean" || String(value).trim() === "" ? NaN : Number(value);
const latitudeValid = (value) => Number.isFinite(value) && value >= -90 && value <= 90;
const longitudeValid = (value) => Number.isFinite(value) && value >= -180 && value <= 180;

export function attendanceGeofenceIssue(site, location) {
  const siteLat = numeric(site.site_latitude), siteLon = numeric(site.site_longitude), radius = numeric(site.site_geofence_radius_m);
  if (!latitudeValid(siteLat) || !longitudeValid(siteLon) || !Number.isFinite(radius) || radius <= 0)
    return "This site's GPS coordinates or geofence radius are not configured correctly. Contact the office.";
  const lat = numeric(location?.latitude), lon = numeric(location?.longitude), accuracy = numeric(location?.accuracy);
  if (!latitudeValid(lat) || !longitudeValid(lon) || !Number.isFinite(accuracy) || accuracy < 0)
    return "A valid GPS location and accuracy are required. Set GPS again.";
  const radians = (value) => value * Math.PI / 180;
  const a = Math.sin(radians(siteLat - lat) / 2) ** 2 + Math.cos(radians(lat)) * Math.cos(radians(siteLat)) * Math.sin(radians(siteLon - lon) / 2) ** 2;
  const distance = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
  if (distance > radius)
    return `You are outside this site's ${radius}m geofence (about ${Math.ceil(distance)}m from the site). Move inside the site boundary before submitting attendance.`;
  if (accuracy > radius)
    return `GPS accuracy is too low to verify this site's ${radius}m geofence. Enable precise location, move to an open area and set GPS again.`;
  return "";
}
