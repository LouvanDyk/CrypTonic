import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  getKey, deleteKey, validateKey, renewKey, revokeKey,
  changePassphrase, exportKey,
  getAllTags, setKeyTags, getAuditLog,
  listGroups, setKeyGroup,
} from "../api";
import { Identicon } from "./Dashboard";

/* ── Helpers ──────────────────────────────────────────────────────── */
function expiryTip(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const diff = (d - Date.now()) / 86400000;
  const formatted = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  if (diff < 0) return `Expired ${Math.abs(Math.round(diff))} days ago`;
  return `${Math.round(diff)} days remaining`;
}

function formatRelativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr);
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (days > 30) return new Date(isoStr).toLocaleDateString();
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 10) return `${seconds}s ago`;
  return "just now";
}

/* ── Copyable value component ──────────────────────────────────────── */
function Copyable({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="copyable" onClick={copy} title="Click to copy">
      {text}
      {copied && <span className="copied-tip">Copied!</span>}
    </span>
  );
}

/* ── Skeleton for detail page ──────────────────────────────────────── */
function DetailSkeleton() {
  return (
    <div>
      <div className="skeleton skeleton-text" style={{ width: "40%", height: 20, marginBottom: "1.5rem" }} />
      <div className="card">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem" }}>
            <div className="skeleton skeleton-text short" />
            <div className="skeleton skeleton-text" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function KeyDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [key, setKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [validation, setValidation] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [exportData, setExportData] = useState(null);
  const [showQR, setShowQR] = useState(false);

  /* Tags state */
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState("");
  const [allTags, setAllTags] = useState([]);
  const [tagSuggestions, setTagSuggestions] = useState([]);

  /* Audit log state */
  const [auditLog, setAuditLog] = useState([]);

  /* Groups state */
  const [groups, setGroups] = useState([]);
  const [keyGroups, setKeyGroups] = useState([]);
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getKey(slug), getAuditLog(slug), listGroups(), getAllTags()])
      .then(([k, audit, grps, at]) => {
        setKey(k);
        setTags(k.tags || []);
        setKeyGroups(k.groups || []);
        setAuditLog(audit);
        setGroups(grps);
        setAllTags(at);
      })
      .catch(() => navigate("/"))
      .finally(() => setLoading(false));
  }, [slug, navigate]);

  useEffect(load, [load]);

  /* Tag helpers */
  const handleTagInputChange = (value) => {
    setTagInput(value);
    if (value.trim()) {
      setTagSuggestions(
        allTags.filter((t) => t.toLowerCase().includes(value.toLowerCase()) && !tags.includes(t))
      );
    } else {
      setTagSuggestions([]);
    }
  };

  const addTag = async (tag) => {
    const t = tag.trim().toLowerCase();
    if (!t || tags.includes(t)) return;
    const newTags = [...tags, t];
    setTags(newTags);
    setTagInput("");
    setTagSuggestions([]);
    try {
      await setKeyTags(slug, newTags);
      if (!allTags.includes(t)) setAllTags([...allTags, t]);
    } catch (e) {
      showToast("Failed to save tag", "error");
    }
  };

  const removeTag = async (tag) => {
    const newTags = tags.filter((t) => t !== tag);
    setTags(newTags);
    try {
      await setKeyTags(slug, newTags);
    } catch (e) {
      showToast("Failed to remove tag", "error");
    }
  };

  /* Group helpers */
  const handleSetGroup = async (groupId) => {
    try {
      await setKeyGroup(slug, groupId);
      if (groupId) {
        const grp = groups.find((g) => g.id === groupId);
        setKeyGroups(grp ? [grp] : []);
      } else {
        setKeyGroups([]);
      }
      setShowGroupDropdown(false);
    } catch (e) {
      showToast("Failed to set group", "error");
    }
  };

  /* Close dropdowns on outside click */
  useEffect(() => {
    const handler = (e) => {
      if (showGroupDropdown && !e.target.closest(".group-assign-dropdown") && !e.target.closest("[data-group-toggle]")) {
        setShowGroupDropdown(false);
      }
      if (tagSuggestions.length > 0 && !e.target.closest(".tag-input") && !e.target.closest(".group-assign-dropdown")) {
        setTagSuggestions([]);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showGroupDropdown, tagSuggestions]);

  if (loading || !key) return <DetailSkeleton />;

  return (
    <div>
      {/* Breadcrumb */}
      <nav className="breadcrumb">
        <Link to="/">Keys</Link>
        <span className="sep">›</span>
        <span>{key.name || key.slug}</span>
      </nav>

      <div className="key-list-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Identicon fingerprint={key.fingerprint} size={40} />
          {key.name || key.slug}
          <span className={`badge ${key.is_expired ? "expired" : "valid"}`} style={{ verticalAlign: "middle" }}
            data-tooltip={expiryTip(key.expires_iso)} data-tooltip-pos="bottom">
            {key.is_expired ? "Expired" : "Valid"}
          </span>
        </h1>
      </div>

      {/* Key Info */}
      <div className="card">
        <dl className="detail-grid">
          <dt>Key ID</dt><dd><Copyable text={key.key_id} /></dd>
          <dt>Fingerprint</dt><dd><Copyable text={key.fingerprint} /></dd>
          <dt>Algorithm</dt><dd><span data-tooltip="Sign & Encrypt">{key.algorithm}</span></dd>
          <dt>Created</dt><dd>{key.created}</dd>
          <dt>Expires</dt><dd><span data-tooltip={expiryTip(key.expires_iso)}>{key.expires}</span></dd>
          <dt>User ID</dt><dd>{key.user_id}</dd>
          <dt>Email</dt><dd>{key.email}</dd>
          {key.comment && <><dt>Comment</dt><dd>{key.comment}</dd></>}
          <dt>Private Key</dt><dd><span data-tooltip={key.has_private_key ? "Private key file found on disk" : "No private key file in keys directory"}>{key.has_private_key ? "✅ Present" : "❌ Not found"}</span></dd>
          <dt>Protected</dt><dd><span data-tooltip={key.is_protected ? "Key is encrypted with a passphrase" : "Key has no passphrase protection"}>{key.is_protected ? "🔒 Yes" : "🔓 No"}</span></dd>
        </dl>
      </div>

      {/* Tags & Groups row */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {/* Group (single) */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-dim)" }}>Group</span>
          {keyGroups.length > 0 ? (
            <span className="group-badge" style={{ background: keyGroups[0].color + "18", color: keyGroups[0].color }}>
              <span className="group-color-dot" style={{ background: keyGroups[0].color, width: 7, height: 7 }} />
              {keyGroups[0].name}
            </span>
          ) : (
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>None</span>
          )}
          <div style={{ position: "relative" }}>
            <button className="btn btn-outline" data-group-toggle style={{ padding: "0.15rem 0.4rem", fontSize: "0.75rem" }}
              onClick={(e) => { e.stopPropagation(); setShowGroupDropdown((v) => !v); }}>
              {keyGroups.length === 0 ? "+ Add to group" : "✎"}
            </button>
            {showGroupDropdown && (
              <div className="group-assign-dropdown" onClick={(e) => e.stopPropagation()}>
                {groups.length === 0 ? (
                  <div style={{ padding: "0.5rem", fontSize: "0.8rem", color: "var(--text-dim)" }}>
                    No groups yet. Create one from the Dashboard.
                  </div>
                ) : (
                  <>
                    <div className="group-assign-item" onClick={() => handleSetGroup(null)}>
                      <span className="check-mark">{keyGroups.length === 0 ? "●" : ""}</span>
                      <span>None (ungrouped)</span>
                    </div>
                    {groups.map((g) => {
                      const isSelected = keyGroups.length > 0 && keyGroups[0].id === g.id;
                      return (
                        <div key={g.id} className="group-assign-item" onClick={() => handleSetGroup(g.id)}>
                          <span className="check-mark">{isSelected ? "●" : ""}</span>
                          <span className="group-color-dot" style={{ background: g.color, width: 8, height: 8 }} />
                          <span>{g.name}</span>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Tags */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-dim)" }}>Tags</span>
          <div className="tag-input-row">
            {tags.map((t) => (
              <span key={t} className="tag tag-blue">
                {t}
                <span className="tag-remove" onClick={() => removeTag(t)}>×</span>
              </span>
            ))}
            <div style={{ position: "relative" }}>
              <input
                className="tag-input"
                placeholder="Add tag…"
                value={tagInput}
                onChange={(e) => handleTagInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim()) {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                }}
              />
              {tagSuggestions.length > 0 && (
                <div className="group-assign-dropdown" style={{ left: 0, right: "auto", minWidth: 140 }}>
                  {tagSuggestions.slice(0, 8).map((s) => (
                    <div key={s} className="group-assign-item" onClick={() => addTag(s)}>
                      {s}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Subkeys */}
      {key.subkeys?.length > 0 && (
        <>
          <h2 className="section-title">Subkeys</h2>
          {key.subkeys.map((s) => (
            <div className="card" key={s.key_id}>
              <dl className="detail-grid">
                <dt>Subkey ID</dt><dd>{s.key_id}</dd>
                <dt>Algorithm</dt><dd>{s.algorithm}</dd>
                <dt>Created</dt><dd>{s.created}</dd>
                <dt>Expires</dt><dd>{s.expires}</dd>
              </dl>
            </div>
          ))}
        </>
      )}

      {/* Actions */}
      <h2 className="section-title">Actions</h2>
      <div className="actions">
        <button className="btn btn-outline" onClick={() => setModal("validate")}>✅ Validate</button>
        <button className="btn btn-outline" onClick={() => setModal("renew")}>🔄 Renew</button>
        <button className="btn btn-outline" onClick={() => setModal("revoke")}>🚫 Revoke</button>
        <button className="btn btn-outline" onClick={() => setModal("passphrase")}>🔑 Change Passphrase</button>
        <button className="btn btn-outline" onClick={async () => {
          try {
            const data = await exportKey(slug, "public");
            setExportData({ type: "Public Key", content: data });
          } catch (e) { showToast(e.response?.data?.detail || e.message, "error"); }
        }}>📤 Export Public</button>
        <button className="btn btn-outline" onClick={async () => {
          try {
            const data = await exportKey(slug, "private");
            setExportData({ type: "Private Key", content: data });
          } catch (e) { showToast(e.response?.data?.detail || e.message, "error"); }
        }}>📤 Export Private</button>
        <button className="btn btn-outline" onClick={async () => {
          try {
            const data = await exportKey(slug, "public");
            setExportData({ type: "Public Key", content: data });
            setShowQR(true);
          } catch (e) { showToast(e.response?.data?.detail || e.message, "error"); }
        }}>📱 QR Code</button>
        <button className="btn btn-danger" onClick={() => setModal("delete")}>🗑 Delete</button>
      </div>

      {/* Export display */}
      {exportData && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3>{exportData.type}</h3>
            <div className="actions">
              <button className="btn btn-outline" onClick={() => {
                navigator.clipboard.writeText(exportData.content);
                showToast("Copied to clipboard!");
              }}>📋 Copy</button>
              <button className="btn btn-outline" onClick={() => {
                const blob = new Blob([exportData.content], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${slug}_${exportData.type.toLowerCase().replace(" ", "_")}.asc`;
                a.click();
                URL.revokeObjectURL(url);
              }}>💾 Download</button>
              <button className="btn btn-outline" onClick={() => { setExportData(null); setShowQR(false); }}>✕ Close</button>
            </div>
          </div>
          <div className="export-block">{exportData.content}</div>
          {showQR && exportData.type === "Public Key" && (
            <div className="qr-container">
              <QRCodeSVG value={exportData.content} size={200} level="L" />
              <span style={{ fontSize: "0.75rem", color: "#666" }}>Scan to import public key</span>
            </div>
          )}
        </div>
      )}

      {/* Validation results */}
      <ValidationResults validation={validation} />

      {/* Audit Timeline */}
      {auditLog.length > 0 && (
        <>
          <h2 className="section-title">Activity Timeline</h2>
          <div className="timeline">
            {auditLog.map((entry, i) => (
              <div key={i} className="timeline-item">
                <div className="tl-action">{entry.action}</div>
                {entry.detail && <div className="tl-detail" style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>{entry.detail}</div>}
                <div className="tl-time">{formatRelativeTime(entry.timestamp)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Modals */}
      {modal === "validate" && <ValidateModal slug={slug} onClose={() => setModal(null)} onResult={setValidation} showToast={showToast} />}
      {modal === "renew" && <RenewModal slug={slug} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); showToast("Key renewed!"); }} showToast={showToast} />}
      {modal === "revoke" && <RevokeModal slug={slug} onClose={() => setModal(null)} onDone={() => { setModal(null); showToast("Revocation certificate generated!"); }} showToast={showToast} />}
      {modal === "passphrase" && <PassphraseModal slug={slug} onClose={() => setModal(null)} onDone={() => { setModal(null); showToast("Passphrase changed!"); }} showToast={showToast} />}
      {modal === "delete" && <DeleteModal slug={slug} onClose={() => setModal(null)} onDone={() => navigate("/")} showToast={showToast} />}

      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}



const CHECK_INFO = {
  public_key_readable: {
    label: "Public key readable",
    what: "Verifies that the public key file (.asc) can be parsed as a valid OpenPGP key.",
    fail: "The public key file is missing, corrupted, or not in a valid OpenPGP format. Try re-importing the key from a trusted source, or re-generate the key pair.",
  },
  not_expired: {
    label: "Not expired",
    what: "Checks whether the key is still within its validity period based on the expiration date set during creation.",
    fail: "The key has passed its expiration date and can no longer be used for encryption or signing. Use the Renew action to extend the expiration, or generate a new key pair.",
  },
  self_signature_valid: {
    label: "Self-signature valid",
    what: "Every PGP key contains a self-signature — the key signs its own User ID (name + email) to cryptographically prove that the identity belongs to this key. This check verifies that signature is intact and valid.",
    fail: "The self-signature could not be verified. This can happen if the key was modified or corrupted after creation, was generated by a tool with incomplete signature support, or uses an unsupported signature algorithm. Try re-importing the original key from a trusted source, or generate a new key pair.",
  },
  private_key_exists: {
    label: "Private key exists",
    what: "Checks whether a matching private key file is present on disk alongside the public key.",
    fail: "No private key file was found. Without the private key you cannot decrypt messages, sign data, or perform management actions (renew, revoke, change passphrase). Import the private key using the Import function on the dashboard.",
  },
  fingerprint_match: {
    label: "Fingerprint match",
    what: "Compares the fingerprints of the public and private key files to confirm they belong to the same key pair.",
    fail: "The public and private key fingerprints do not match — they belong to different key pairs. Delete the mismatched files and re-import the correct public and private key together using the Import function.",
  },
  passphrase_unlock: {
    label: "Passphrase unlock",
    what: "Attempts to decrypt the private key using the passphrase you provided, confirming you have the correct passphrase.",
    fail: "The passphrase you entered could not unlock the private key. Double-check for typos, extra spaces, or incorrect capitalization. If you have lost the passphrase, the private key cannot be recovered — you will need to generate a new key pair.",
  },
};

function ValidationResults({ validation }) {
  const [expanded, setExpanded] = useState({});
  if (!validation) return null;

  const toggle = (i) => setExpanded((prev) => ({ ...prev, [i]: !prev[i] }));

  return (
    <>
      <h2 className="section-title">
        Validation {validation.valid ? "✅ Passed" : "❌ Failed"}
      </h2>
      <ul className="check-list">
        {validation.checks.map((c, i) => {
          const info = CHECK_INFO[c.check];
          const isOpen = expanded[i];
          return (
            <li key={i} className="check-item-wrap">
              <div className="check-item-row">
                <span className="check-icon">{c.ok ? "✅" : "❌"}</span>
                <span>{info?.label || c.check.replace(/_/g, " ")}</span>
                {c.detail && (
                  <span style={{ color: "var(--text-dim)", marginLeft: "0.5rem" }}>— {c.detail}</span>
                )}
                {info && (
                  <button
                    className="info-toggle"
                    onClick={() => toggle(i)}
                    title="More info"
                    aria-label="More info"
                  >
                    ℹ️
                  </button>
                )}
              </div>
              {info && isOpen && (
                <div className="check-info-panel">
                  <p><strong>What this checks:</strong> {info.what}</p>
                  {!c.ok && <p className="check-info-fix"><strong>How to fix:</strong> {info.fail}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ValidateModal({ slug, onClose, onResult, showToast }) {
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const result = await validateKey(slug, passphrase || null);
      onResult(result);
      onClose();
    } catch (e) {
      showToast(e.response?.data?.detail || e.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>✅ Validate Key</h3>
        <div className="form-group">
          <label>Passphrase (optional — to test unlock)</label>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </div>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={run} disabled={loading}>
            {loading ? "Validating…" : "Validate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenewModal({ slug, onClose, onDone, showToast }) {
  const [passphrase, setPassphrase] = useState("");
  const [days, setDays] = useState(365);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!passphrase) return showToast("Passphrase required", "error");
    setLoading(true);
    try {
      await renewKey(slug, passphrase, Number(days));
      onDone();
    } catch (e) {
      showToast(e.response?.data?.detail || e.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🔄 Renew Key</h3>
        <div className="form-group">
          <label>Passphrase *</label>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </div>
        <div className="form-group">
          <label>New expiration (days from now)</label>
          <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={run} disabled={loading}>
            {loading ? "Renewing…" : "Renew"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RevokeModal({ slug, onClose, onDone, showToast }) {
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!passphrase) return showToast("Passphrase required", "error");
    setLoading(true);
    try {
      await revokeKey(slug, passphrase);
      onDone();
    } catch (e) {
      showToast(e.response?.data?.detail || e.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🚫 Revoke Key</h3>
        <p style={{ color: "var(--text-dim)", fontSize: "0.85rem", marginBottom: "1rem" }}>
          This will generate a revocation certificate. The key itself will not be deleted.
        </p>
        <div className="form-group">
          <label>Passphrase *</label>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </div>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={run} disabled={loading}>
            {loading ? "Revoking…" : "Revoke"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PassphraseModal({ slug, onClose, onDone, showToast }) {
  const [oldPass, setOldPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!oldPass) return showToast("Current passphrase required", "error");
    if (!newPass) return showToast("New passphrase required", "error");
    if (newPass !== confirm) return showToast("New passphrases do not match", "error");
    setLoading(true);
    try {
      await changePassphrase(slug, oldPass, newPass);
      onDone();
    } catch (e) {
      showToast(e.response?.data?.detail || e.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🔑 Change Passphrase</h3>
        <div className="form-group">
          <label>Current Passphrase *</label>
          <input type="password" value={oldPass} onChange={(e) => setOldPass(e.target.value)} />
        </div>
        <div className="form-group">
          <label>New Passphrase *</label>
          <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Confirm New Passphrase *</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={run} disabled={loading}>
            {loading ? "Changing…" : "Change Passphrase"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteModal({ slug, onClose, onDone, showToast }) {
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      await deleteKey(slug);
      showToast("Key deleted!");
      onDone();
    } catch (e) {
      showToast(e.response?.data?.detail || e.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🗑 Delete Key</h3>
        <p style={{ color: "var(--red)", fontSize: "0.85rem", marginBottom: "1rem" }}>
          This will permanently delete all files for this key pair. This action cannot be undone.
        </p>
        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={run} disabled={loading}>
            {loading ? "Deleting…" : "Delete Permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}