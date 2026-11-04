import test from "node:test";
import assert from "node:assert/strict";
import { attendanceGeofenceIssue } from "../src/attendanceGeofence.js";
const site={site_latitude:51.5,site_longitude:-.12,site_geofence_radius_m:50};
const gps={latitude:51.5,longitude:-.12,accuracy:8};
test("only fresh points within the configured radius pass",()=>{
 assert.equal(attendanceGeofenceIssue(site,gps),"");
 assert.match(attendanceGeofenceIssue(site,{...gps,latitude:51.5006}),/outside.*50m geofence/);
 assert.match(attendanceGeofenceIssue(site,{...gps,longitude:-.13}),/outside/);
 assert.equal(attendanceGeofenceIssue({...site,site_geofence_radius_m:100},{...gps,latitude:51.5006}),"");
});
test("a point just outside is not rounded back inside",()=>{
 const origin={site_latitude:0,site_longitude:0,site_geofence_radius_m:50};
 const point=(distance)=>({latitude:distance/6371000*180/Math.PI,longitude:0,accuracy:8});
 assert.equal(attendanceGeofenceIssue(origin,point(49.99)),"");
 assert.match(attendanceGeofenceIssue(origin,point(50.004)),/outside/);
});
test("missing and invalid GPS or low accuracy cannot verify the site",()=>{
 for(const change of [{latitude:NaN},{longitude:Infinity},{latitude:91},{longitude:-181},{accuracy:-1},{accuracy:null},{accuracy:51}])
  assert.notEqual(attendanceGeofenceIssue(site,{...gps,...change}),"");
 assert.notEqual(attendanceGeofenceIssue(site,null),"");
 assert.equal(attendanceGeofenceIssue(site,{...gps,accuracy:50}),"");
});
test("site configuration is required and zero latitude/longitude are valid",()=>{
 for(const change of [{site_latitude:null},{site_longitude:null},{site_latitude:91},{site_longitude:-181},{site_geofence_radius_m:0}])
  assert.notEqual(attendanceGeofenceIssue({...site,...change},gps),"");
 assert.equal(attendanceGeofenceIssue({site_latitude:0,site_longitude:0,site_geofence_radius_m:50},{latitude:0,longitude:0,accuracy:8}),"");
});
