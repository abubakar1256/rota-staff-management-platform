import test from "node:test";
import assert from "node:assert/strict";
import { formatArrivalDelay, formatArrivalSchedule } from "../src/arrivalFormatting.js";

test("arrival delays switch to hours at 60 minutes without redundant zero minutes", () => {
 for (const [value, expected] of [[null,"—"],[0,"On time"],[1,"1 min"],[59,"59 min"],[60,"1hr"],[62,"1hr 2min"],[120,"2hr"],[168,"2hr 48min"],[1502,"25hr 2min"]])
  assert.equal(formatArrivalDelay(value),expected);
});
test("assigned schedules retain complete day and overnight shift times", () => {
 assert.equal(formatArrivalSchedule("07:00:00","19:00:00"),"07:00–19:00");
 assert.equal(formatArrivalSchedule("19:00:00","07:00:00"),"19:00–07:00");
 assert.equal(formatArrivalSchedule("06:00:00","23:00:00"),"06:00–23:00");
 assert.equal(formatArrivalSchedule(null,null),"—");
});
