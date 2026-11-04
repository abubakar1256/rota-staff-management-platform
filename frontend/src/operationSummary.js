export function operationSummary(data) {
  const operations = Array.isArray(data) ? data : data?.operations || [];
  const assigned = operations.filter((item) => item.employee);
  const groups = new Map();
  for (const item of operations.filter((entry) => !entry.employee)) {
    const key = `${item.site}-${item.shift_type}`;
    const group = groups.get(key) || { ...item, id: key, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return { assigned, unfilled: [...groups.values()], notes: data?.unassigned_notes || [],
    reached: assigned.filter((item) => item.reached_at).length,
    late: assigned.filter((item) => item.arrival_status === "LATE").length,
    pending: assigned.filter((item) => !item.reached_at && item.arrival_status !== "UPCOMING").length,
    upcoming: assigned.filter((item) => !item.reached_at && item.arrival_status === "UPCOMING").length,
    unfilledCount: [...groups.values()].reduce((total, group) => total + group.count, 0) };
}
