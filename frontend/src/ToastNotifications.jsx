import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const kinds = {
  success: { title: "Saved", icon: "✓", duration: 4500 },
  info: { title: "Update", icon: "i", duration: 6000 },
  warning: { title: "Please check", icon: "!", duration: 8000 },
  error: { title: "Action needed", icon: "!", duration: 8000 },
};

function ToastMessage({ toast, dismiss }) {
  const [paused, setPaused] = useState(false);
  const kind = kinds[toast.type];
  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setTimeout(() => dismiss(toast.id), kind.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, kind.duration, paused, dismiss]);
  return <div className={`toast toast-${toast.type}`} role={toast.type === "error" || toast.type === "warning" ? "alert" : "status"} aria-atomic="true"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    <span className="toast-indicator" aria-hidden="true">{kind.icon}</span>
    <div className="toast-copy"><strong>{kind.title}</strong><p>{toast.message}</p></div>
    <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><X size={17} /></button>
  </div>;
}

export default function ToastNotifications() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);
  // A stable callback keeps other visible messages' dismissal timers intact.
  const dismiss = useRef((id) => setToasts((current) => current.filter((toast) => toast.id !== id))).current;
  useEffect(() => {
    const receive = ({ detail }) => {
      const message = typeof detail?.message === "string" ? detail.message.trim() : "";
      if (!message) return;
      const type = Object.hasOwn(kinds, detail.type) ? detail.type : "info";
      const toast = { id: ++nextId.current, message, type };
      setToasts((current) => [...current.filter((item) => item.message !== message || item.type !== type), toast].slice(-3));
    };
    window.addEventListener("rota:toast", receive);
    return () => window.removeEventListener("rota:toast", receive);
  }, []);
  return createPortal(<section className="toast-stack" aria-label="Notifications">{toasts.map((toast) => <ToastMessage key={toast.id} toast={toast} dismiss={dismiss} />)}</section>, document.body);
}
