import assert from "node:assert/strict";
import test from "node:test";
import { certificateLabel, certificateTypes, documentComplete, documentDriveStatus, documentFieldRules, documentsProgress, findStepDocument, optionalDocumentItems, optionalDocumentItemsFor, requiredDocumentItems, saveDocument } from "../src/documentWizard.js";

const today = "2026-11-03";
const complete = (nationality = "Pakistani") => requiredDocumentItems({ nationality }).map((item, index) => ({ id: index + 1, document_type: item.label, file: `/file-${index}.pdf`, document_number: "123456", expiry_date: "2099-01-01", issue_date: today, verification_status: "PENDING" }));

test("custom required steps keep the same upload across edits and leave progress when removed", () => {
  const profile = { nationality: "Pakistani" };
  const required = { id: 10, name: "Staff handbook", required: true, is_active: true };
  const optional = { id: 11, name: "Training evidence", required: false, is_active: true };
  const evidence = { id: 99, document_option: 10, document_type: "Signed handbook", file: "/handbook.pdf" };
  const options = [required, optional];
  const previous = complete();
  const step = requiredDocumentItems(profile, options).at(-1);
  assert.equal(step.label, required.name);
  assert.equal(findStepDocument(step, [evidence]), evidence);
  assert.equal(optionalDocumentItemsFor(options).at(-1).label, optional.name);
  assert.equal(documentsProgress(profile, previous, today, options).required, 8);
  assert.equal(documentsProgress(profile, [...previous, evidence], today, options).percentage, 100);
  assert.equal(documentsProgress(profile, previous, today, [{ ...required, is_active: false }, optional]).required, 7);
});

test("British guards have no share code step, including saved country names", () => {
  for (const nationality of ["British", "United Kingdom", "UK", " british "]) {
    assert.equal(requiredDocumentItems({ nationality }).length, 6);
    assert.ok(!requiredDocumentItems({ nationality }).some((item) => item.key === "share_code"));
    assert.equal(documentsProgress({ nationality }, complete(nationality), today).percentage, 100);
  }
  assert.ok(requiredDocumentItems({ nationality: "Pakistani" }).some((item) => item.key === "share_code"));
});

test("one address proof and required files reach 100% without optional documents", () => {
  const profile = { nationality: "Pakistani" }, documents = complete();
  assert.equal(documentsProgress(profile, [], today).percentage, 0);
  assert.equal(documentsProgress(profile, documents.slice(0, 1), today).completed, 1);
  assert.deepEqual(documentsProgress(profile, documents, today), { completed: 7, required: 7, percentage: 100 });
  assert.equal(requiredDocumentItems(profile).filter((item) => item.issue).length, 1);
  for (const document_type of ["Proof of Address 1 (last 3 months)", "Proof of Address 2 (last 3 months)"]) {
    const previous = documents.map((document) => document.document_type.startsWith("Proof of Address") ? { ...document, document_type } : document);
    assert.equal(documentsProgress(profile, previous, today).percentage, 100);
  }
  const extras = optionalDocumentItems.map((item) => ({ document_type: item.label, file: "/optional.pdf" }));
  assert.equal(documentsProgress(profile, extras, today).percentage, 0);
});

test("missing files, rejected or expired evidence and stale address proofs do not count", () => {
  const items = requiredDocumentItems({ nationality: "Pakistani" }), documents = complete();
  for (const [index, patch] of [[0, { file: "" }], [1, { document_number: " " }], [2, { verification_status: "REJECTED" }], [3, { issue_date: "2025-01-01" }], [4, { expiry_date: "2026-10-01" }]]) {
    assert.equal(documentComplete(items[index], { ...documents[index], ...patch }, today), false);
  }
  const share = items.find((item) => item.key === "share_code");
  assert.equal(documentComplete(share, { notes: "Code123", expiry_date: "2099-01-01" }, today), true);
  const sia = { id: 20, document_type: "SIA Card (Front & Back)", file: "/sia.pdf", document_number: "123", expiry_date: "2099-01-01" };
  assert.equal(findStepDocument(items[1], [sia], today), sia);
  assert.equal(documentComplete(items[2], sia, today), true);
});

test("failed uploads retain the caller's draft and cannot report a successful step", async () => {
  const item = requiredDocumentItems({ nationality: "British" })[0];
  const draft = { file: new File(["%PDF-test"], "passport.pdf", { type: "application/pdf" }), expiry_date: "2099-01-01" };
  let calls = 0;
  const api = async () => { calls++; throw new Error("Upload failed"); };
  await assert.rejects(saveDocument(api, { id: 1 }, item, null, draft), /Upload failed/);
  assert.equal(draft.file.name, "passport.pdf");
  await assert.rejects(saveDocument(api, { id: 1 }, item, null, {}), /Choose a document/);
  assert.equal(calls, 1);
});

test("certificates create separate records and preserve category/name in each payload", async () => {
  assert.deepEqual(certificateTypes.map((option) => option.label), ["ACT", "NASDU", "Fire Marshal", "Other"]);
  const bodies = [];
  const api = async (path, options) => { assert.equal(path, "/documents/"); bodies.push(options.body); return { id: bodies.length }; };
  for (const name of ["first.pdf", "second.pdf"]) await saveDocument(api, { id: 1 }, { label: "Certificates", certificate: true }, null, { certificate_type: "OTHER", certificate_name: "First aid", file: new File(["%PDF-test"], name) });
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.get("document_type") === "Certificates" && body.get("certificate_name") === "First aid"));
  assert.equal(certificateLabel({ document_type: "ACT certificate" }), "ACT");
  assert.equal(certificateLabel({ certificate_type: "FIRE_MARSHAL" }), "Fire Marshal");
});

test("an unchanged rejected document cannot advance even when an empty draft triggers a request", async () => {
  const item = requiredDocumentItems({ nationality: "British" })[0];
  const existing = { id: 1, document_type: item.label, file: "/passport.pdf", expiry_date: "2099-01-01", verification_status: "REJECTED" };
  await assert.rejects(saveDocument(async () => existing, { id: 1 }, item, existing, { file: null }), /still needs attention/);
});

test("office fields follow the document type including older names and certificate choices", () => {
  assert.equal(documentFieldRules("SIA Card (Front & Back)").expiry, true);
  assert.equal(documentFieldRules("Proof of Address 2 (last 3 months)").issue, true);
  assert.equal(documentFieldRules("National Insurance Number (NI)").code, true);
  assert.equal(documentFieldRules("National Insurance Number (NI)").expiry, undefined);
  assert.equal(documentFieldRules("Right to Work").optionalExpiry, true);
  assert.equal(documentFieldRules("Personal Photograph").photo, true);
  assert.equal(documentFieldRules("ACT certificate").expiry, true);
  for (const option of certificateTypes) {
    assert.equal(documentFieldRules("Certificates", option.value).expiry, option.value === "ACT");
  }
});

test("replacing an optional file can clear a previously saved expiry date", async () => {
  const item = { label: "Certificates", certificate: true };
  const existing = { id: 9, document_type: item.label, certificate_type: "NASDU", expiry_date: "2099-01-01" };
  const replacement = new File(["%PDF-test"], "replacement.pdf", { type: "application/pdf" });
  const api = async (path, options) => {
    assert.equal(path, "/documents/9/");
    assert.equal(options.method, "PATCH");
    assert.equal(options.body.get("expiry_date"), "");
    assert.equal(options.body.get("issue_date"), null);
    return { id: 9, expiry_date: null };
  };
  await saveDocument(api, { id: 1 }, item, existing, { file: replacement, expiry_date: "" });
});

test("Drive status distinguishes completed uploads, previous folders, and documents still needing a copy", () => {
  const verified = { file: "/files/passport.pdf", verification_status: "VERIFIED", reviewed_at: "2026-11-11T09:00:00Z" };
  const uploaded = { ...verified, drive_file_id: "drive-file", drive_synced_at: "2026-11-11T09:00:01Z", drive_root_folder_id: "current" };
  const current = documentDriveStatus(uploaded, "current");
  assert.equal(current.label, "Uploaded");
  assert.equal(current.url, "https://drive.google.com/file/d/drive-file/view");
  assert.equal(current.syncedAt, uploaded.drive_synced_at);
  assert.equal(documentDriveStatus(uploaded, "another").label, "Previous Drive folder");
  assert.equal(documentDriveStatus({ ...uploaded, drive_root_folder_id: "" }, "current").detail, "Drive account unknown");
  assert.equal(documentDriveStatus({ ...uploaded, reviewed_at: "2026-11-11T09:10:00Z" }, "current").label, "Earlier copy");
  assert.equal(documentDriveStatus({ ...uploaded, drive_sync_error: "test failure" }, "current").label, "Upload failed");
  assert.equal(documentDriveStatus({ ...verified, drive_sync_error: "test failure" }, "current").canRetry, true);
  assert.equal(documentDriveStatus({ ...verified, drive_sync_error: "test failure", verification_status: "PENDING" }, "current").canRetry, undefined);
  assert.equal(documentDriveStatus({ ...uploaded, verification_status: "PENDING" }, "current").label, "Awaiting verification");
  assert.equal(documentDriveStatus({ ...uploaded, verification_status: "REJECTED" }, "current").label, "On hold");
  assert.equal(documentDriveStatus({ ...verified, file: null }, "current").label, "No uploaded file");
  assert.equal(documentDriveStatus(verified, "current").label, "Not uploaded");
});
