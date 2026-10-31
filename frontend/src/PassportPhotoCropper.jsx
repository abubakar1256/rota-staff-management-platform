import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Minus, Plus, RotateCw, X } from "lucide-react";
import { drawPassportCrop, panPassportCrop } from "./passportCrop";
import "./passportPhoto.css";

const initialSettings = () => ({ zoom: 1, position: { x: 0, y: 0 }, rotation: 0 });

export default function PassportPhotoCropper({ file, initialCrop, onConfirm, onCancel }) {
  const [image, setImage] = useState(null);
  const [settings, setSettings] = useState(initialCrop || initialSettings);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const previewRef = useRef(null), stageRef = useRef(null), dialogRef = useRef(null), dragRef = useRef(null);
  const callbacks = useRef(null);
  callbacks.current = { onCancel, preparing };
  const titleId = useId(), helpId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector("button")?.focus({ preventScroll: true });
    const keyboard = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!callbacks.current.preparing) callbacks.current.onCancel();
      }
      if (event.key !== "Tab") return;
      const targets = [...dialogRef.current.querySelectorAll("button:not(:disabled), input:not(:disabled), [tabindex='0']")];
      const first = targets[0], last = targets[targets.length - 1];
      if (!targets.includes(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keyboard);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let active = true;
    const url = URL.createObjectURL(file);
    const photo = new Image();
    photo.onload = () => { if (active) setImage(photo); };
    photo.onerror = () => { if (active) setError("This photo could not be opened. Choose a JPG, PNG or WebP image."); };
    photo.src = url;
    return () => { active = false; photo.onload = null; photo.onerror = null; URL.revokeObjectURL(url); };
  }, [file]);

  useEffect(() => {
    if (!image || !previewRef.current) return;
    try { drawPassportCrop(previewRef.current, image, settings, 420); }
    catch (err) { setError(err.message); }
  }, [image, settings]);

  const pan = (dx, dy) => {
    if (!image || preparing) return;
    const bounds = stageRef.current.getBoundingClientRect();
    setSettings((current) => ({ ...current, position: panPassportCrop(image.naturalWidth, image.naturalHeight, current, dx, dy, bounds.width, bounds.height) }));
  };
  const zoom = (value) => setSettings((current) => ({ ...current, zoom: Math.max(1, Math.min(4, value)) }));
  const endDrag = () => { dragRef.current = null; setDragging(false); };
  const confirm = async () => {
    if (!image || preparing) return;
    setPreparing(true); setError("");
    try {
      const canvas = document.createElement("canvas");
      drawPassportCrop(canvas, image, settings);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not prepare the cropped photo. Please try again.")), "image/jpeg", .94));
      const name = `${file.name.replace(/\.[^.]+$/, "") || "profile"}-passport.jpg`;
      onConfirm(new File([blob], name, { type: "image/jpeg", lastModified: Date.now() }), settings);
    } catch (err) { setError(err.message); setPreparing(false); }
  };

  return createPortal(<div className="modal-backdrop passport-crop-backdrop"><section className="modal-card passport-crop-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={helpId} ref={dialogRef}>
    <div className="passport-crop-heading"><div><p className="eyebrow">PROFILE PICTURE</p><h3 id={titleId}>Adjust passport photo</h3></div><button type="button" className="icon-button" aria-label="Close photo editor" disabled={preparing} onClick={onCancel}><X size={20} /></button></div>
    <p className="muted" id={helpId}>Drag your photo to position your face, then zoom to adjust. The frame stays 35 × 45 mm.</p>
    <div className={`passport-crop-stage${dragging ? " dragging" : ""}`} ref={stageRef} tabIndex={0} role="img" aria-label="Passport crop preview. Drag or use the arrow keys to move your photo."
      onPointerDown={(event) => {
        if (!image || preparing || !event.isPrimary || event.button !== 0) return;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        pan(event.clientX - drag.x, event.clientY - drag.y);
        dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        const movement = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] }[event.key];
        if (movement) { event.preventDefault(); pan(...movement); }
      }}>
      <canvas ref={previewRef} aria-hidden="true" />
      {!image && <span className="passport-crop-loading">{error ? "Choose another photo to continue" : "Opening photo…"}</span>}
      {image && <span className="passport-crop-guide" aria-hidden="true" />}
    </div>
    <div className="passport-crop-dimensions">35 × 45 mm <span>·</span> Passport ratio</div>
    <div className="passport-crop-zoom"><button type="button" className="icon-button" aria-label="Zoom out" disabled={!image || preparing || settings.zoom <= 1} onClick={() => zoom(settings.zoom - .1)}><Minus size={17} /></button><label>Zoom<input type="range" min="1" max="4" step=".01" value={settings.zoom} disabled={!image || preparing} onChange={(event) => zoom(Number(event.target.value))} /></label><button type="button" className="icon-button" aria-label="Zoom in" disabled={!image || preparing || settings.zoom >= 4} onClick={() => zoom(settings.zoom + .1)}><Plus size={17} /></button><output>{Math.round(settings.zoom * 100)}%</output></div>
    <div className="passport-crop-tools"><button type="button" className="secondary-button" disabled={!image || preparing} onClick={() => setSettings((current) => ({ ...initialSettings(), rotation: (current.rotation + 90) % 360 }))}><RotateCw size={15} /> Rotate</button><button type="button" className="text-button" disabled={!image || preparing} onClick={() => setSettings(initialSettings())}>Reset</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="passport-crop-actions"><button type="button" className="secondary-button" disabled={preparing} onClick={onCancel}>Cancel</button><button type="button" className="primary-button" disabled={!image || preparing} onClick={confirm}><Check size={16} />{preparing ? "Preparing…" : "Use cropped photo"}</button></div>
  </section></div>, document.body);
}
