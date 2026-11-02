import test from "node:test";
import assert from "node:assert/strict";
import { saveProfilePhoto } from "../src/profilePhotoUpload.js";

const profile = { id: 7, profile_photo_url: null };
const photo = new File(["cropped image"], "passport.jpg", { type: "image/jpeg" });

test("Next uploads the cropped file and returns the refreshed profile", async () => {
  const saved = { ...profile, profile_photo_url: "/api/media/document/9/" };
  const calls = [];
  const result = await saveProfilePhoto({ profile, photo, api: async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/documents/?")) return [];
    return path === "/employees/me/" ? saved : { id: 9 };
  } });
  assert.equal(result, saved);
  const upload = calls.find((call) => call.path === "/documents/");
  assert.equal(upload.options.method, "POST");
  assert.equal(upload.options.body.get("file").name, "passport.jpg");
  assert.equal(upload.options.body.get("employee"), "7");
  assert.equal(upload.options.body.get("document_type"), "Personal Photograph");
});

test("changing a picture replaces the existing document rather than creating another", async () => {
  const calls = [];
  await saveProfilePhoto({ profile, photo, api: async (path, options = {}) => {
    calls.push({ path, options });
    return path.startsWith("/documents/?") ? [{ id: 9, document_type: "Personal Photograph" }] : profile;
  } });
  assert.ok(calls.some((call) => call.path === "/documents/9/" && call.options.method === "PATCH"));
  assert.ok(!calls.some((call) => call.path === "/documents/"));
});

test("an existing saved picture continues without uploading again", async () => {
  const saved = { ...profile, profile_photo_url: "/saved.jpg" };
  assert.equal(await saveProfilePhoto({ profile: saved, photo: null, api: () => { throw new Error("Unexpected request"); } }), saved);
});

test("a missing picture or failed upload cannot be reported as saved", async () => {
  await assert.rejects(saveProfilePhoto({ profile, photo: null, api: () => [] }), /Choose and crop/);
  const calls = [];
  await assert.rejects(saveProfilePhoto({ profile, photo, api: async (path) => {
    calls.push(path);
    if (path.startsWith("/documents/?")) return [];
    throw new Error("Upload failed");
  } }), /Upload failed/);
  assert.ok(!calls.includes("/employees/me/"));
});
