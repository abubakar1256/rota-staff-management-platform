const coordinateNumber = "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)";
const coordinatePair = new RegExp(`^\\s*(${coordinateNumber})\\s*,\\s*(${coordinateNumber})\\s*$`);
const pinCoordinates = new RegExp(`!3d(${coordinateNumber})!4d(${coordinateNumber})(?=!|$)`, "g");
const googleHost = /^(?:(?:www|maps)\.)?google\.(?:com|co\.uk|com\.pk)$/;

export function sitePoint(latitude, longitude) {
  if ([latitude, longitude].some((value) =>
    !["number", "string"].includes(typeof value) || String(value).trim() === ""
  )) return null;

  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: lat, longitude: lon };
}

function parsePair(text) {
  const match = coordinatePair.exec(text ?? "");
  return match ? sitePoint(match[1], match[2]) : null;
}

export function parseSitePin(input) {
  const point = parsePair(input);
  if (point) return point;

  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !googleHost.test(url.hostname)) return null;
    if (!/^\/maps(?:\/|$)/.test(url.pathname) && !url.hostname.startsWith("maps.")) return null;

    const queryPoint = parsePair(url.searchParams.get("query") ?? url.searchParams.get("q"));
    if (queryPoint) return queryPoint;

    if (!url.pathname.startsWith("/maps/place/")) return null;
    // The @latitude,longitude segment is the map centre and can differ from the pin.
    const path = decodeURIComponent(url.pathname);
    const coordinateLabel = parsePair(path.split("/")[3].replaceAll("+", " "));
    if (coordinateLabel) return coordinateLabel;
    const pins = [...path.matchAll(pinCoordinates)];
    return pins.length === 1 ? sitePoint(pins[0][1], pins[0][2]) : null;
  } catch {
    return null;
  }
}

export function googleSiteLinks(point, address = "") {
  const destination = point ? `${point.latitude},${point.longitude}` : address.trim();
  if (!destination) return null;

  const encoded = encodeURIComponent(destination);
  return {
    map: `https://www.google.com/maps/search/?api=1&query=${encoded}`,
    directions: `https://www.google.com/maps/dir/?api=1&destination=${encoded}`,
  };
}
