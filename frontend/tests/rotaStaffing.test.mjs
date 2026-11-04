import assert from "node:assert/strict";
import test from "node:test";
import { siteWeekStaffing } from "../src/rotaStaffing.js";

const site = { id: 1, required_guards: 1, is_active: true };
const shifts = [{ id: 1 }, { id: 2 }];
const days = Array.from({ length: 7 }, (_, index) => `2026-11-${String(index + 2).padStart(2, "0")}`);

test("weekly gaps sum all seven days and exclude unassigned placeholders", () => {
  const assignments = [{ site: 1, shift_type: 1, work_date: days[0], employee: 7 }, { site: 1, shift_type: 2, work_date: days[2], employee: 7 }, { site: 1, shift_type: 2, work_date: days[2], employee: null }];
  assert.deepEqual(siteWeekStaffing({ site, shifts, days, assignments, requirements: [] }), { requiredSlots: 14, unfilled: 12 });
});

test("zero weekday requirements override defaults and a saved requirement changes the badge count", () => {
  const requirements = days.flatMap((_, weekday) => shifts.map((shift) => ({ site: 1, weekday, shift_type: shift.id, required_guards: 0 })));
  assert.equal(siteWeekStaffing({ site, shifts, days, assignments: [], requirements }).unfilled, 0);
  const saved = requirements.map((row) => row.weekday === 2 && row.shift_type === 1 ? { ...row, required_guards: 4 } : row);
  assert.equal(siteWeekStaffing({ site, shifts, days, assignments: [], requirements: saved }).unfilled, 4);
});

test("overstaffing one slot cannot cancel the gap on another shift or date", () => {
  const assignments = [1, 2, 3].map((employee) => ({ site: 1, employee, work_date: days[0], shift_type: 1 }));
  assert.equal(siteWeekStaffing({ site, shifts, days: [days[0]], assignments, requirements: [] }).unfilled, 1);
});

test("inactive sites and shifts add no gaps; numeric and string IDs agree", () => {
  assert.equal(siteWeekStaffing({ site: { ...site, is_active: false }, shifts, days, assignments: [], requirements: [] }).unfilled, 0);
  assert.equal(siteWeekStaffing({ site, shifts: shifts.map((item) => ({ ...item, is_active: false })), days, assignments: [], requirements: [] }).unfilled, 0);
  assert.equal(siteWeekStaffing({ site, shifts, days: [days[0]], assignments: [{ site: "1", employee: 7, shift_type: "1", work_date: days[0] }], requirements: [{ site: "1", weekday: 0, shift_type: "2", required_guards: 0 }] }).unfilled, 0);
});

test("a selected daily count remains distinct from a whole week and uses the actual weekday", () => {
  const requirements = [{ site: 1, weekday: 2, shift_type: 1, required_guards: 4 }];
  const wholeWeek = siteWeekStaffing({ site, shifts, days, assignments: [], requirements });
  const wednesday = siteWeekStaffing({ site, shifts, days: [days[2]], assignments: [], requirements });
  assert.equal(wholeWeek.unfilled, 17);
  assert.equal(wednesday.unfilled, 5);
});
