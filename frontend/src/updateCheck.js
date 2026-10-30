// Countdown values change without an underlying record changing.
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => key !== "approval_remaining_seconds")
      .map((key) => [key, comparable(value[key])]));
  }
  return value;
}

export function sameUpdateData(previous, next) {
  return JSON.stringify(comparable(previous)) === JSON.stringify(comparable(next));
}

export async function checkForUpdates({ api, paths, select = (value) => value, getSnapshot, notify }) {
  const context = getSnapshot().context;
  const latest = () => {
    const snapshot = getSnapshot();
    return snapshot.active && snapshot.context === context ? snapshot : null;
  };
  try {
    const options = { silentLoading: true, silentError: true };
    const response = Array.isArray(paths)
      ? await Promise.all(paths.map((path) => api(path, options)))
      : await api(paths, options);
    const snapshot = latest();
    if (!snapshot) return "ignored";
    const data = select(response);
    snapshot.setError?.("");
    if (sameUpdateData(snapshot.data, data)) {
      notify("You're up to date.", "info");
      return "unchanged";
    }
    const message = snapshot.apply(data);
    notify(message || "Latest updates loaded.", "success");
    return "updated";
  } catch (error) {
    const snapshot = latest();
    if (!snapshot) return "ignored";
    snapshot.setError?.(error.message || "Could not check for updates. Please try again.");
    notify(error.message || "Could not check for updates. Please try again.", "error");
    return "error";
  }
}
