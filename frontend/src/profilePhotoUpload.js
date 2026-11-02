export async function saveProfilePhoto({ api, profile, photo }) {
  if (!photo) {
    if (!profile.profile_photo_url) throw new Error("Choose and crop a photo before continuing.");
    return profile;
  }
  const documents = await api(`/documents/?employee=${profile.id}`, { silentLoading: true });
  const existing = documents.find((document) => document.document_type.toLowerCase() === "personal photograph");
  const body = new FormData();
  body.append("employee", String(profile.id));
  body.append("document_type", "Personal Photograph");
  body.append("file", photo);
  await api(existing ? `/documents/${existing.id}/` : "/documents/", { method: existing ? "PATCH" : "POST", body, silentToast: true, silentLoading: true });
  return api("/employees/me/", { silentLoading: true });
}
