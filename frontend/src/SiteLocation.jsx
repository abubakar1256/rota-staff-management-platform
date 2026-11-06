import { useState } from "react";
import { ExternalLink, MapPin, Navigation } from "lucide-react";
import { googleSiteLinks, parseSitePin, sitePoint } from "./siteCoordinates.js";
import "./siteLocation.css";

export function SiteLocationLinks({ item }) {
  const address = (item.site_address || "").trim();
  const point = sitePoint(item.site_latitude, item.site_longitude);
  const links = googleSiteLinks(point, address);

  return (
    <div className="site-location-links">
      {address && <p className="site-location-address"><MapPin size={15} aria-hidden="true" />{address}</p>}
      {!point && <p className="site-location-hint">
        {links ? "Exact pin not set. Directions use the site address." : "Site location not set. Contact the office for directions."}
      </p>}
      {links && <div className="site-location-actions">
        <a href={links.map} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />View in Google Maps</a>
        <a href={links.directions} target="_blank" rel="noopener noreferrer"><Navigation size={14} aria-hidden="true" />Get directions</a>
      </div>}
    </div>
  );
}

export function SitePinInput({ latitude, longitude, address, onChange }) {
  const [input, setInput] = useState("");
  const [message, setMessage] = useState("");
  const point = sitePoint(latitude, longitude);
  const search = googleSiteLinks(point, address)?.map
    ?? "https://www.google.com/maps/";

  function applyPin() {
    const next = parseSitePin(input);
    if (!next) {
      setMessage("Paste latitude and longitude separated by a comma, or open the short Maps link and copy the full dropped-pin URL.");
      return;
    }
    onChange(next);
    setInput("");
    setMessage("");
  }

  return (
    <section className="site-pin-input full-width" aria-label="Exact site location">
      <div className="site-pin-heading">
        <strong><MapPin size={17} aria-hidden="true" />Exact site location</strong>
        <a href={search} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />{point ? "Preview pin in Google Maps" : "Find in Google Maps"}</a>
      </div>
      <p>Drop a pin at the site entrance in Google Maps, then paste the coordinates or the full pin link. You can also edit Latitude and Longitude above.</p>
      <div className="site-pin-controls">
        <input aria-label="Site pin coordinates or Google Maps link" placeholder="51.5074, -0.1278 or Google Maps pin link"
          value={input} onChange={(event) => { setInput(event.target.value); setMessage(""); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyPin(); } }} />
        <button type="button" className="secondary-button" disabled={!input.trim()} onClick={applyPin}>Set pin</button>
      </div>
      {message && <p className="error" role="alert">{message}</p>}
      <p className="site-location-hint" aria-live="polite">
        {point ? `Pin set at ${point.latitude}, ${point.longitude}. Save the site to use this location for directions and attendance.` : "No exact pin set."}
      </p>
    </section>
  );
}
