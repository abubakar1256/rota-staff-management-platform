import { findNationality } from "./nationalities.js";

export const certificateTypes = [{ value: "ACT", label: "ACT" }, { value: "NASDU", label: "NASDU" }, { value: "FIRE_MARSHAL", label: "Fire Marshal" }, { value: "OTHER", label: "Other" }];
export const localDate = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; };
const clean = (value) => String(value || "").trim();
export const hasDocumentFile = (document) => Boolean(document?.file || document?.file_url || document?.secure_file_url);
export const documentFileUrl = (document) => document?.secure_file_url || document?.file || document?.file_url || "";

export function requiredDocumentItems(profile) {
  const items = [
    { key: "passport", label: "Passport (First 2 pages)", hint: "Upload the first two pages together as one file.", expiry: true },
    { key: "sia_front", label: "SIA Card (Front)", hint: "Upload the front of your SIA card and enter its number.", number: true, expiry: true, aliases: ["SIA Card (Front & Back)"] },
    { key: "sia_back", label: "SIA Card (Back)", hint: "Upload the back of your SIA card.", aliases: ["SIA Card (Front & Back)"] },
    { key: "proof_address", label: "Proof of Address (last 3 months)", hint: "One proof of address is enough. It must be dated within the last 3 months.", issue: true, aliases: ["Proof of Address 1 (last 3 months)", "Proof of Address 2 (last 3 months)"] },
  ];
  if (findNationality(profile?.nationality)?.name !== "British") items.push({ key: "share_code", label: "Share Code", hint: "Enter your share code or upload supporting evidence.", code: true, expiry: true });
  items.push(
    { key: "ni_number", label: "National Insurance Number (NI)", hint: "Enter your NI number or upload supporting evidence.", code: true },
    { key: "photograph", label: "Personal Photograph", hint: "Your saved profile picture is used here. You can replace it in My profile.", photo: true },
  );
  return items.map((item) => ({ ...item, required: true }));
}

export const optionalDocumentItems = [
  { key: "right_to_work", label: "Right to Work", optionalExpiry: true },
  { key: "cscs_front", label: "CSCS Card (Front)", number: true, expiry: true },
  { key: "cscs_back", label: "CSCS Card (Back)" },
  { key: "driving_front", label: "Driving License (Front)" },
  { key: "driving_back", label: "Driving License (Back)" },
  { key: "ppac_code", label: "PPAC Code", code: true },
];

export function documentFieldRules(type, certificateType) {
  if (type === "ACT certificate" || type === "Certificates") {
    return { expiry: type === "ACT certificate" || certificateType === "ACT" };
  }
  const items = [...requiredDocumentItems(), ...optionalDocumentItems];
  return items.find((item) => item.label === type || item.aliases?.includes(type)) || {};
}

export function documentError(item, document, today = localDate()) {
  const file = hasDocumentFile(document);
  if (!file && !(item.code && (clean(document?.document_number) || clean(document?.notes)))) return item.code ? "Enter the code / number or upload supporting evidence." : "Choose a document file before continuing.";
  if (item.photo && document.file instanceof File && !["image/jpeg", "image/png", "image/webp"].includes(document.file.type)) return "Choose a JPG, PNG or WEBP profile picture.";
  if (item.number && !clean(document?.document_number)) return "Enter the card number.";
  if (item.expiry && !document?.expiry_date) return "Enter the expiry date.";
  if (document?.expiry_date && document.expiry_date < today) return "This document has expired. Please upload a current document.";
  if (item.issue) {
    const earliest = new Date(`${today}T12:00:00`); earliest.setDate(earliest.getDate() - 92);
    const issue = new Date(`${document?.issue_date}T12:00:00`);
    if (!document?.issue_date || Number.isNaN(issue.getTime()) || document.issue_date > today || issue < earliest) return "Enter a document date within the last 3 months.";
  }
  return "";
}

export function documentComplete(item, document, today = localDate()) {
  return Boolean(document && document.verification_status !== "REJECTED" && !documentError(item, document, today));
}
export function findStepDocument(item, documents, today = localDate()) {
  const names = [item.label, ...(item.aliases || [])].map((name) => name.toLowerCase());
  const matches = documents.filter((document) => names.includes(document.document_type.toLowerCase()));
  return matches.find((document) => documentComplete(item, document, today)) || matches[0];
}
export function documentsProgress(profile, documents, today = localDate()) {
  const items = requiredDocumentItems(profile);
  const completed = items.filter((item) => documentComplete(item, findStepDocument(item, documents, today), today)).length;
  return { completed, required: items.length, percentage: Math.round(completed / items.length * 100) };
}
export function certificateLabel(document) {
  if (document.document_type === "ACT certificate") return "ACT";
  return document.certificate_type === "OTHER" ? document.certificate_name || "Other" : certificateTypes.find((item) => item.value === document.certificate_type)?.label || "Certificate";
}

export async function saveDocument(api, employee, item, existing, draft = {}) {
  const merged = { ...existing, ...draft, file: draft.file || existing?.file };
  const error = documentError(item, merged);
  if (error) throw new Error(error);
  if (existing?.verification_status === "REJECTED" && !Object.keys(draft).length) throw new Error("Replace or correct this rejected document before continuing.");
  if (existing && !Object.keys(draft).length) return existing;
  const values = { employee: employee.id, document_type: existing?.document_type || item.label, document_number: clean(merged.document_number), notes: clean(merged.notes), issue_date: merged.issue_date || null, expiry_date: merged.expiry_date || null };
  if (item.certificate) Object.assign(values, { certificate_type: merged.certificate_type || "", certificate_name: clean(merged.certificate_name) });
  let body;
  if (draft.file) {
    body = new FormData();
    Object.entries(values).forEach(([key, value]) => { if (value !== null) body.append(key, String(value)); });
    for (const field of ["issue_date", "expiry_date"]) {
      if (existing?.[field] && draft[field] === "") body.set(field, "");
    }
    body.append("file", draft.file);
  } else body = JSON.stringify(values);
  const saved = await api(existing ? `/documents/${existing.id}/` : "/documents/", { method: existing ? "PATCH" : "POST", body, silentLoading: true });
  if (item.required && !documentComplete(item, saved)) throw new Error("This document still needs attention. Correct or replace it before continuing.");
  return saved;
}
