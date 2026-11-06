import assert from "node:assert/strict";
import test from "node:test";
import { googleSiteLinks, parseSitePin, sitePoint } from "../src/siteCoordinates.js";

test("Maps pin import uses the destination rather than the viewport centre", () => {
  const point = { latitude: 51.507462, longitude: -0.127816 };
  assert.deepEqual(parseSitePin("51.507462, -0.127816"), point);
  assert.deepEqual(parseSitePin("https://www.google.com/maps/search/?api=1&query=51.507462%2C-0.127816"), point);
  assert.deepEqual(parseSitePin("https://www.google.co.uk/maps/place/Site/@51.4,-0.2,17z/data=!3d51.507462!4d-0.127816!16sTest"), point);
  assert.equal(parseSitePin("https://www.google.com/maps/@51.4,-0.2,17z"), null);
  assert.equal(parseSitePin("https://maps.app.goo.gl/example"), null);
  assert.equal(parseSitePin("https://www.google.com.example/maps/search/?query=51.507462,-0.127816"), null);
});

test("valid zero coordinates work and missing pins fall back to an encoded address", () => {
  const point = sitePoint(0, "0");
  const links = googleSiteLinks(point, "Example Road");
  assert.equal(new URL(links.map).searchParams.get("query"), "0,0");
  assert.equal(new URL(links.directions).searchParams.get("destination"), "0,0");
  assert.equal(sitePoint("", 0), null);
  assert.equal(sitePoint(91, 0), null);
  const address = "1 A&B Road, London";
  assert.equal(new URL(googleSiteLinks(null, address).directions).searchParams.get("destination"), address);
  assert.equal(googleSiteLinks(null, " "), null);
});
