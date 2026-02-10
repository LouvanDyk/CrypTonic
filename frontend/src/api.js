import axios from "axios";

const api = axios.create({ baseURL: "/api" });

export const listKeys = () => api.get("/keys").then((r) => r.data);

export const createKey = (data) => api.post("/keys", data).then((r) => r.data);

export const getKey = (slug) => api.get(`/keys/${slug}`).then((r) => r.data);

export const deleteKey = (slug) => api.delete(`/keys/${slug}`).then((r) => r.data);

export const validateKey = (slug, passphrase = null) =>
  api.post(`/keys/${slug}/validate`, { passphrase }).then((r) => r.data);

export const renewKey = (slug, passphrase, new_expiry_days) =>
  api.post(`/keys/${slug}/renew`, { passphrase, new_expiry_days }).then((r) => r.data);

export const revokeKey = (slug, passphrase, reason = "Key revoked") =>
  api.post(`/keys/${slug}/revoke`, { passphrase, reason }).then((r) => r.data);

export const changePassphrase = (slug, old_passphrase, new_passphrase) =>
  api.post(`/keys/${slug}/change-passphrase`, { old_passphrase, new_passphrase }).then((r) => r.data);

export const importKey = (publicFile, privateFile = null, passphrase = null) => {
  const form = new FormData();
  form.append("public_file", publicFile);
  if (privateFile) form.append("private_file", privateFile);
  if (passphrase) form.append("passphrase", passphrase);
  return api.post("/keys/import", form).then((r) => r.data);
};

export const exportKey = (slug, keyType = "public") =>
  api.get(`/keys/${slug}/export`, { params: { key_type: keyType }, responseType: "text" }).then((r) => r.data);

// ── Bulk Export ──────────────────────────────────────────────────────────
export const exportAllKeys = () =>
  api.get("/keys/export-all", { responseType: "blob" }).then((r) => r.data);

// ── Groups ───────────────────────────────────────────────────────────────
export const listGroups = () => api.get("/groups").then((r) => r.data);
export const createGroup = (data) => api.post("/groups", data).then((r) => r.data);
export const updateGroup = (id, data) => api.put(`/groups/${id}`, data).then((r) => r.data);
export const deleteGroup = (id) => api.delete(`/groups/${id}`).then((r) => r.data);
export const setKeyGroup = (slug, groupId) => api.put(`/keys/${slug}/group`, { group_id: groupId }).then((r) => r.data);
export const addKeyToGroup = (groupId, slug) => api.post(`/groups/${groupId}/keys/${slug}`).then((r) => r.data);
export const removeKeyFromGroup = (groupId, slug) => api.delete(`/groups/${groupId}/keys/${slug}`).then((r) => r.data);

// ── Tags ─────────────────────────────────────────────────────────────────
export const getAllTags = () => api.get("/tags").then((r) => r.data);
export const getKeyTags = (slug) => api.get(`/keys/${slug}/tags`).then((r) => r.data);
export const setKeyTags = (slug, tags) => api.put(`/keys/${slug}/tags`, { tags }).then((r) => r.data);

// ── Audit ────────────────────────────────────────────────────────────────
export const getAuditLog = (slug) => api.get(`/keys/${slug}/audit`).then((r) => r.data);

