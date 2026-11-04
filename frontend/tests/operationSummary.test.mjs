import test from "node:test";
import assert from "node:assert/strict";
import { operationSummary } from "../src/operationSummary.js";

test("operations separate real guards, current gaps and office notes", () => {
 const assigned=[{id:1,employee:1,reached_at:"2026-11-04T09:48:00Z",arrival_status:"LATE"},
 {id:2,employee:2,arrival_status:"NOT_REACHED"},{id:3,employee:3,arrival_status:"UPCOMING"}];
 const gaps=[{id:4,site:1,shift_type:2,employee:null},{id:5,site:1,shift_type:2,employee:null},
 {id:6,site:2,shift_type:2,employee:null}];
 const result=operationSummary({operations:[...assigned,...gaps],unassigned_notes:[{id:7,notes:"Call office"}]});
 assert.deepEqual(result.assigned,assigned);
 assert.equal(result.reached,1);assert.equal(result.late,1);assert.equal(result.pending,1);assert.equal(result.upcoming,1);
 assert.equal(result.unfilledCount,3);assert.deepEqual(result.unfilled.map(row=>row.count),[2,1]);
 assert.equal(result.notes.length,1);
});
test("empty response and legacy backend arrays remain supported", () => {
 assert.equal(operationSummary(null).assigned.length,0);
 assert.equal(operationSummary([]).unfilledCount,0);
 assert.equal(operationSummary([{employee:1,reached_at:"2026-11-04T07:00:00Z",arrival_status:"REACHED"}]).reached,1);
});
