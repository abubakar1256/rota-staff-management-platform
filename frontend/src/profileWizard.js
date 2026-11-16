import { findNationality } from "./nationalities.js";

export const profileSteps = ["Profile picture", "Personal details", "Contact details", "Emergency contact", "Review & submit"];
export const stepFields = { 1: ["name", "date_of_birth", "nationality"], 2: ["email", "phone", "whatsapp_number", "address"], 3: ["emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship"] };
export const profileReviewFields = Object.values(stepFields).flat();
export const profileFields = profileReviewFields.filter((field) => field !== "whatsapp_number");
export const profileFieldLabels = { name: "Full name", date_of_birth: "Date of birth", nationality: "Nationality", phone: "Phone number", whatsapp_number: "WhatsApp number", email: "Email (login username)", address: "Address", emergency_contact_name: "Emergency contact name", emergency_contact_phone: "Emergency contact phone", emergency_contact_relationship: "Relationship" };
export function profileDraft(profile) {
  return Object.fromEntries(profileReviewFields.map((field) => [field, field === "nationality" ? findNationality(profile?.[field])?.name || profile?.[field] || "" : profile?.[field] || ""]));
}
export function profileStepError(form, step) {
  for (const [fieldStep, fields] of Object.entries(stepFields)) {
    if (Number(fieldStep) > step) continue;
    for (const field of fields) {
      if (profileFields.includes(field) && !String(form[field] || "").trim()) {
        return { step: Number(fieldStep), message: `Please complete ${profileFieldLabels[field].toLowerCase()}.` };
      }
      if (field === "nationality" && !findNationality(form[field])) {
        return { step: Number(fieldStep), message: "Select your nationality from the list." };
      }
    }
  }
  return null;
}
export function profilePercentage(form, hasPhoto, declaration) {
  const completed = profileFields.filter((field) => field === "nationality" ? Boolean(findNationality(form[field])) : Boolean(String(form[field] || "").trim())).length;
  return Math.round((completed + Number(Boolean(hasPhoto)) + Number(Boolean(declaration))) / (profileFields.length + 2) * 100);
}
