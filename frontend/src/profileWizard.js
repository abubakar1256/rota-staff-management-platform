import { findCountry } from "./countries.js";

export const profileFields = ["name", "date_of_birth", "nationality", "phone", "email", "address", "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship"];
export const profileSteps = ["Profile picture", "Personal details", "Contact details", "Emergency contact", "Review & submit"];
export const stepFields = { 1: ["name", "date_of_birth", "nationality"], 2: ["email", "phone", "address"], 3: ["emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship"] };
export const profileFieldLabels = { name: "Full name", date_of_birth: "Date of birth", nationality: "Nationality", phone: "Phone number", email: "Email (login username)", address: "Address", emergency_contact_name: "Emergency contact name", emergency_contact_phone: "Emergency contact phone", emergency_contact_relationship: "Relationship" };
export function profileDraft(profile) {
  return Object.fromEntries(profileFields.map((field) => [field, profile?.[field] || ""]));
}
export function profileStepError(form, step) {
  for (const [fieldStep, fields] of Object.entries(stepFields)) {
    if (Number(fieldStep) > step) continue;
    for (const field of fields) {
      if (!String(form[field] || "").trim()) {
        return { step: Number(fieldStep), message: `Please complete ${profileFieldLabels[field].toLowerCase()}.` };
      }
      if (field === "nationality" && !findCountry(form[field])) {
        return { step: Number(fieldStep), message: "Select your nationality from the country list." };
      }
    }
  }
  return null;
}
export function profilePercentage(form, hasPhoto, declaration) {
  const completed = profileFields.filter((field) => field === "nationality" ? Boolean(findCountry(form[field])) : Boolean(String(form[field] || "").trim())).length;
  return Math.round((completed + Number(Boolean(hasPhoto)) + Number(Boolean(declaration))) / (profileFields.length + 2) * 100);
}
