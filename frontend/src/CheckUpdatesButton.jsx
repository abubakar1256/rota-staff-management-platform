import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { checkForUpdates } from "./updateCheck";

export default function CheckUpdatesButton({ api, paths, currentData, onUpdate, setError, select, disabled = false, className = "secondary-button" }) {
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  const latest = useRef(null);
  const context = JSON.stringify(paths);
  latest.current = { context, data: currentData, apply: onUpdate, setError };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const check = async () => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setChecking(true);
    try {
      await checkForUpdates({
        api, paths, select,
        getSnapshot: () => ({
          ...latest.current, active: active.current,
          apply: (data) => {
            const position = { left: window.scrollX, top: window.scrollY };
            const message = latest.current.apply(data);
            window.requestAnimationFrame(() => {
              if (active.current && latest.current.context === context) window.scrollTo({ ...position, behavior: "instant" });
            });
            return message;
          },
        }),
        notify: (message, type) => window.dispatchEvent(new CustomEvent("rota:toast", { detail: { message, type } })),
      });
    } finally {
      inFlight.current = false;
      if (active.current) setChecking(false);
    }
  };

  return <button type="button" className={`${className} check-updates-button`} disabled={disabled || checking} aria-busy={checking} onClick={check}>
    <span className={`check-updates-mark${checking ? " checking" : ""}`} aria-hidden="true"><ShieldCheck size={15} /></span>
    <span>{checking ? "Checking…" : "Check updates"}</span>
  </button>;
}
