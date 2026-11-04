import test from "node:test";
import assert from "node:assert/strict";
import { DutyGeofenceWatcher } from "../src/dutyGeofenceWatcher.js";
const base=Date.parse("2026-11-04T08:00:00Z");
const site={operation_id:7,site_name:"Assigned Office",site_address:"10 Example Road, London",site_latitude:51.5,site_longitude:-.12,site_geofence_radius_m:50,stop_at:"2026-11-04T20:00:00Z"};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let elapsed=0,visible=true,success,failure,watches=0,clears=0;
 const reports=[],exits=[],states=[];let broken=false;
 const watcher=new DutyGeofenceWatcher({api:async(path,options)=>{if(broken)throw new Error("Offline");reports.push({path,body:JSON.parse(options.body)});return {};},
 onChange:value=>states.push(value),onExit:value=>exits.push(value),notifyChanged:()=>{},
 watch:(yes,no)=>{success=yes;failure=no;return ++watches;},clear:()=>clears++,clock:()=>elapsed,now:()=>base+elapsed,visible:()=>visible});
 const point=(latitude=51.5,accuracy=8)=>({coords:{latitude,longitude:-.12,accuracy},timestamp:base+elapsed});
 return {watcher,reports,exits,states,point,capture:(lat,accuracy)=>success(point(lat,accuracy)),fail:code=>failure({code}),setTime:time=>{elapsed=time;},setVisible:value=>{visible=value;},breakApi:value=>{broken=value;},watches:()=>watches,clears:()=>clears};
}
test("movement warns immediately and reports once per outside episode without uploading every fix",async()=>{
 const f=fixture();f.watcher.sync([site],new Date(base).toISOString());
 f.capture(51.5);await settle();assert.equal(f.reports.length,0);
 f.capture(51.5006);await settle();assert.equal(f.exits.length,1);assert.equal(f.reports.length,1);
 assert.equal(f.exits[0].site_address,site.site_address);assert.equal(f.states.at(-1).outside.length,1);
 for(let i=0;i<5;i++)f.capture(51.5007);await settle();assert.equal(f.exits.length,1);assert.equal(f.reports.length,1);
 f.capture(51.5);await settle();assert.equal(f.states.at(-1).outside.length,0);assert.equal(f.reports.length,2);
 f.capture(51.5006);await settle();assert.equal(f.exits.length,2);assert.equal(f.reports.length,3);
 f.watcher.stop();
});
test("uncertain or missing GPS never claims the guard is outside or clears an existing breach",async()=>{
 const f=fixture();f.watcher.sync([site],new Date(base).toISOString());
 f.capture(51.5006,100);f.fail(1);await settle();assert.equal(f.exits.length,0);assert.equal(f.reports.length,0);
 f.capture(51.5006);await settle();assert.equal(f.states.at(-1).outside.length,1);
 f.capture(51.5,100);await settle();assert.equal(f.states.at(-1).outside.length,1);
 assert.match(f.states.at(-1).issue,/accuracy/);f.watcher.stop();
});
test("off duty, hidden pages, shift end and unmount stop the location watch",async()=>{
 const f=fixture();f.watcher.sync([],new Date(base).toISOString());assert.equal(f.watches(),0);
 f.watcher.sync([site],new Date(base).toISOString());assert.equal(f.watches(),1);
 f.setVisible(false);f.watcher.reconcile();assert.equal(f.clears(),1);
 f.capture(51.5006);await settle();assert.equal(f.exits.length,0);
 f.setVisible(true);f.watcher.reconcile();assert.equal(f.watches(),2);
 f.setTime(43200000);f.capture(51.5006);await settle();assert.equal(f.exits.length,0);assert.equal(f.clears(),2);
 f.watcher.stop();assert.equal(f.watcher.controller.signal.aborted,true);
});
test("late GPS callbacks after Book Off or signout never send alerts",async()=>{
 const f=fixture();f.watcher.sync([site],new Date(base).toISOString());
 f.watcher.sync([],new Date(base).toISOString());f.capture(51.5006);await settle();assert.equal(f.reports.length,0);
 f.watcher.stop();f.capture(51.5006);await settle();assert.equal(f.exits.length,0);
});
test("restored connections retry a saved outside episode without repeating its popup",async()=>{
 const f=fixture();f.watcher.sync([site],new Date(base).toISOString());f.breakApi(true);f.capture(51.5006);await settle();
 assert.equal(f.exits.length,1);assert.match(f.states.at(-1).issue,/connection/);
 f.breakApi(false);f.setTime(60000);f.capture(51.5006);await settle();assert.equal(f.reports.length,1);assert.equal(f.exits.length,1);
 f.watcher.stop();
});
test("a stale GPS point cannot create a boundary alert",async()=>{
 const f=fixture();f.watcher.sync([site],new Date(base).toISOString());f.setTime(180000);
 f.watcher.position({...f.point(51.5006),timestamp:base});await settle();assert.equal(f.exits.length,0);assert.equal(f.reports.length,0);f.watcher.stop();
});

test("a report skipped while the page hides is retried when it becomes visible",async()=>{
 const f=fixture();f.watcher.sync([site],new Date(base).toISOString());
 f.capture(51.5006);f.setVisible(false);f.watcher.reconcile();await settle();assert.equal(f.reports.length,0);
 f.setVisible(true);f.watcher.reconcile();f.capture(51.5006);await settle();
 assert.equal(f.reports.length,1);assert.equal(f.exits.length,1);f.watcher.stop();
});
