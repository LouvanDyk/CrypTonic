import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  listKeys, importKey, exportAllKeys,
  listGroups, createGroup, updateGroup, deleteGroup,
  setKeyGroup,
} from "../api";

/* ── Helpers ───────────────────────────────────────────────────────── */
function formatDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

function expiryInfo(isoStr) {
  if (!isoStr) return { label: "No expiry", cls: "valid", days: Infinity, fullDate: "" };
  const diff = (new Date(isoStr) - Date.now()) / 86400000;
  const fullDate = formatDate(isoStr);
  if (diff < 0) return { label: `Expired ${Math.abs(Math.round(diff))}d ago`, cls: "expired", days: diff, fullDate };
  if (diff < 30) return { label: `${Math.round(diff)}d left`, cls: "warning", days: diff, fullDate };
  return { label: `${Math.round(diff)}d left`, cls: "valid", days: diff, fullDate };
}

function borderClass(cls) {
  if (cls === "expired") return "border-red";
  if (cls === "warning") return "border-yellow";
  return "border-green";
}

function healthTip(h) {
  const parts = [];
  if (h.valid) parts.push(`${h.valid} valid`);
  if (h.expiring) parts.push(`${h.expiring} expiring soon`);
  if (h.expired) parts.push(`${h.expired} expired`);
  return parts.join(" · ") || "No keys";
}

/** Simple 5×5 identicon from fingerprint hex */
export function Identicon({ fingerprint, size = 32 }) {
  if (!fingerprint) return null;
  const hex = fingerprint.replace(/\s/g, "").toUpperCase();
  const cells = [];
  // Use first 15 hex chars to fill a 5×5 mirrored grid
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const i = row * 3 + col;
      const on = parseInt(hex[i] || "0", 16) % 2 === 0;
      cells.push({ row, col, on });
      if (col < 2) cells.push({ row, col: 4 - col, on }); // mirror
    }
  }
  // Pick a hue from the fingerprint
  const hue = parseInt(hex.slice(0, 4), 16) % 360;
  const cellSize = size / 5;
  return (
    <svg width={size} height={size} className="identicon-sm" style={{ borderRadius: 6, background: "var(--surface2)" }}>
      {cells.map((c, i) =>
        c.on ? <rect key={i} x={c.col * cellSize} y={c.row * cellSize} width={cellSize} height={cellSize} fill={`hsl(${hue},60%,55%)`} /> : null
      )}
    </svg>
  );
}

/* ── Skeleton ──────────────────────────────────────────────────────── */
function SkeletonCards({ count = 4 }) {
  return Array.from({ length: count }).map((_, i) => (
    <div key={i} className="skeleton skeleton-card" />
  ));
}

/* ── Key Card (draggable) ─────────────────────────────────────────── */
function KeyCard({ k, draggingKey, onDragStart, onDragEnd }) {
  const exp = expiryInfo(k.expires_iso);
  const expiryTip = exp.fullDate
    ? (exp.cls === "expired" ? `Expired: ${exp.fullDate}` : `Expires: ${exp.fullDate}`)
    : "No expiration set";
  const fpShort = k.fingerprint ? k.fingerprint.slice(-16).replace(/(.{4})/g, "$1 ").trim() : "";
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, k.slug)}
      onDragEnd={onDragEnd}
      className={`card ${borderClass(exp.cls)}${draggingKey === k.slug ? " dragging" : ""}`}
    >
      <Link to={`/keys/${k.slug}`}>
        <div className="key-card-header">
          <div className="key-card-left">
            <span data-tooltip={fpShort} data-tooltip-pos="bottom">
              <Identicon fingerprint={k.fingerprint} size={32} />
            </span>
            <h3>{k.name || k.slug}</h3>
          </div>
          <div className="key-card-badges">
            <span className={`badge ${exp.cls}`} data-tooltip={expiryTip} data-tooltip-align="left">{exp.label}</span>
            {k.has_private_key && (
              <span className="badge valid" data-tooltip={k.is_protected ? "Private key · Passphrase protected" : "Private key · Not passphrase protected"} data-tooltip-align="left">🔑</span>
            )}
          </div>
        </div>
        <div className="key-card-meta">
          <span data-tooltip={`Fingerprint: ${k.fingerprint}`}>🆔 {k.key_id}</span>
          <span data-tooltip={k.user_id || k.email}>📧 {k.email}</span>
          <span data-tooltip={`${k.algorithm} · Sign & Encrypt`}>🔑 {k.algorithm}</span>
        </div>
        {(k.tags || []).length > 0 && (
          <div className="tags-row">
            {k.tags.map((t) => (
              <span key={t} className="tag tag-blue">{t}</span>
            ))}
          </div>
        )}
      </Link>
    </div>
  );
}

/* ── Dashboard ─────────────────────────────────────────────────────── */
export default function Dashboard() {
  const [keys, setKeys] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [view, setView] = useState("list");
  const navigate = useNavigate();

  /* Treeview state */
  const [expandedGroups, setExpandedGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cryptonic-expanded-groups") || "{}"); }
    catch { return {}; }
  });
  const [draggingKey, setDraggingKey] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  useEffect(() => {
    localStorage.setItem("cryptonic-expanded-groups", JSON.stringify(expandedGroups));
  }, [expandedGroups]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([listKeys(), listGroups()])
      .then(([k, g]) => { setKeys(k); setGroups(g); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const handleBulkExport = async () => {
    try {
      const blob = await exportAllKeys();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cryptonic_keys_backup.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.response?.data?.detail || e.message);
    }
  };

  /* Stats */
  const stats = useMemo(() => {
    let valid = 0, expiring = 0, expired = 0;
    keys.forEach((k) => {
      const info = expiryInfo(k.expires_iso);
      if (info.cls === "expired") expired++;
      else if (info.cls === "warning") expiring++;
      else valid++;
    });
    return { total: keys.length, valid, expiring, expired };
  }, [keys]);

  /* ── Filter keys, then group by their group ── */
  const sortFn = useCallback((a, b) => {
    if (sortBy === "name") return (a.name || a.slug).localeCompare(b.name || b.slug);
    if (sortBy === "created") return (b.created_iso || "").localeCompare(a.created_iso || "");
    if (sortBy === "expiry") return (a.expires_iso || "9999").localeCompare(b.expires_iso || "9999");
    return 0;
  }, [sortBy]);

  const groupedKeys = useMemo(() => {
    // 1. Apply search + status filter
    let list = [...keys];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((k) =>
        (k.name || "").toLowerCase().includes(q) ||
        (k.email || "").toLowerCase().includes(q) ||
        (k.key_id || "").toLowerCase().includes(q) ||
        (k.fingerprint || "").toLowerCase().includes(q) ||
        (k.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    if (filter !== "all") {
      list = list.filter((k) => {
        const info = expiryInfo(k.expires_iso);
        if (filter === "valid") return info.cls === "valid";
        if (filter === "expiring") return info.cls === "warning";
        if (filter === "expired") return info.cls === "expired";
        return true;
      });
    }

    // 2. Bucket keys by group
    const buckets = {};
    const ungrouped = [];
    list.forEach((k) => {
      const g = (k.groups || [])[0];
      if (g) {
        if (!buckets[g.id]) buckets[g.id] = { group: g, keys: [] };
        buckets[g.id].keys.push(k);
      } else {
        ungrouped.push(k);
      }
    });

    // 3. Sort keys within each bucket
    Object.values(buckets).forEach((b) => b.keys.sort(sortFn));
    ungrouped.sort(sortFn);

    // 4. Build ordered group list (match the order from the groups array)
    const ordered = groups
      .map((g) => {
        const b = buckets[g.id];
        const gKeys = b ? b.keys : [];
        let valid = 0, expiring = 0, expired = 0;
        gKeys.forEach((k) => {
          const info = expiryInfo(k.expires_iso);
          if (info.cls === "expired") expired++;
          else if (info.cls === "warning") expiring++;
          else valid++;
        });
        return { group: g, keys: gKeys, health: { valid, expiring, expired } };
      })
      .filter((entry) => entry.keys.length > 0 || !search); // hide empty groups when searching

    // 5. Ungrouped health
    let uValid = 0, uExpiring = 0, uExpired = 0;
    ungrouped.forEach((k) => {
      const info = expiryInfo(k.expires_iso);
      if (info.cls === "expired") uExpired++;
      else if (info.cls === "warning") uExpiring++;
      else uValid++;
    });

    return { groups: ordered, ungrouped, ungroupedHealth: { valid: uValid, expiring: uExpiring, expired: uExpired } };
  }, [keys, groups, search, filter, sortFn]);

  /* ── Drag-and-drop handlers ── */
  const handleDragStart = (e, keySlug) => {
    e.dataTransfer.setData("text/plain", keySlug);
    e.dataTransfer.effectAllowed = "move";
    // Delay so the dragging class applies after the drag image is captured
    requestAnimationFrame(() => setDraggingKey(keySlug));
  };
  const handleDragEnd = () => { setDraggingKey(null); setDropTarget(null); };
  const handleDragOver = (e, groupId) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(groupId); };
  const handleDragLeave = (e) => {
    // Only clear if we actually left the group section (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null);
  };
  const handleDrop = async (e, groupId) => {
    e.preventDefault();
    const keySlug = e.dataTransfer.getData("text/plain");
    setDropTarget(null);
    setDraggingKey(null);
    if (!keySlug) return;
    try {
      await setKeyGroup(keySlug, groupId);
      load();
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };
  const toggleGroup = (groupId) => {
    setExpandedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };
  const isExpanded = (groupId) => expandedGroups[groupId] !== false; // default expanded

  return (
    <div>
      <div className="key-list-header">
        <h1 className="page-title">🔑 Key Pairs</h1>
        <div className="actions">
          {keys.length > 0 && (
            <button className="btn btn-outline btn-bulk-export" onClick={handleBulkExport} title="Download all keys as zip">
              📦 Export All
            </button>
          )}
          <button className="btn btn-outline" onClick={() => setShowGroupManager(true)} title="Manage groups">
            📁 Groups
          </button>
          <button className="btn btn-outline" onClick={() => setShowImport(true)}>
            📥 Import <span className="kbd" style={{ marginLeft: 4 }}>I</span>
          </button>
          <Link to="/create" className="btn btn-primary">+ Create Key <span className="kbd" style={{ marginLeft: 4, background: "rgba(255,255,255,0.2)", border: "none", color: "#fff" }}>N</span></Link>
        </div>
      </div>

      {error && <div className="toast error">{error}</div>}

      {/* Stats bar */}
      {!loading && keys.length > 0 && (
        <div className="stats-bar">
          <div className="stat"><span className="stat-value">{stats.total}</span> Total</div>
          <div className="stat" style={{ color: "var(--green)" }}><span className="stat-value">{stats.valid}</span> Valid</div>
          <div className="stat" style={{ color: "var(--yellow)" }}><span className="stat-value">{stats.expiring}</span> Expiring</div>
          <div className="stat" style={{ color: "var(--red)" }}><span className="stat-value">{stats.expired}</span> Expired</div>
        </div>
      )}

      {/* Toolbar: search + filter + sort + view */}
      {!loading && keys.length > 0 && (
        <div className="toolbar">
          <div className="search-wrap">
            <input
              className="search-input"
              placeholder="Search keys…  (/)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="filter-chips">
            {["all", "valid", "expiring", "expired"].map((f) => (
              <button key={f} className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div className="sort-controls">
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="name">Name</option>
              <option value="created">Newest</option>
              <option value="expiry">Expiry</option>
            </select>
            <div className="view-toggle">
              <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} title="List view">☰</button>
              <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} title="Grid view">▦</button>
            </div>
          </div>
        </div>
      )}

      {/* Grouped treeview */}
      {loading ? (
        <SkeletonCards />
      ) : groupedKeys.groups.length === 0 && groupedKeys.ungrouped.length === 0 ? (
        <div className="empty-state">
          <p>{keys.length === 0 ? "No keys found." : "No keys match your search."}</p>
          {keys.length === 0 && <p style={{ marginTop: "0.5rem" }}>Create your first key pair or import an existing one.</p>}
        </div>
      ) : (
        <>
          {groupedKeys.groups.map(({ group, keys: gKeys, health }) => (
            <div
              key={group.id}
              className={`group-section${dropTarget === group.id ? " drop-target" : ""}`}
              style={{ borderLeftColor: group.color }}
              onDragOver={(e) => handleDragOver(e, group.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, group.id)}
            >
              <div className="group-header" onClick={() => toggleGroup(group.id)}>
                <span className={`group-chevron${isExpanded(group.id) ? " expanded" : ""}`}>▶</span>
                <div className="group-info">
                  <span className="group-color-dot" style={{ background: group.color }} data-tooltip={group.description || group.name} data-tooltip-pos="bottom" />
                  <span className="group-name">{group.name}</span>
                  <span className="group-count">({gKeys.length})</span>
                </div>
                <div className="group-health" data-tooltip={healthTip(health)} data-tooltip-align="left">
                  {health.valid > 0 && <span className="health-dot valid">{health.valid}</span>}
                  {health.expiring > 0 && <span className="health-dot warning">{health.expiring}</span>}
                  {health.expired > 0 && <span className="health-dot expired">{health.expired}</span>}
                </div>
              </div>
              <div className={`group-keys${isExpanded(group.id) ? " expanded" : " collapsed"}`}>
                {gKeys.length === 0 ? (
                  <div className="group-keys-empty">No keys — drag keys here to add them</div>
                ) : (
                  <div className={view === "grid" ? "keys-grid" : ""}>
                    {gKeys.map((k) => <KeyCard key={k.slug} k={k} draggingKey={draggingKey} onDragStart={handleDragStart} onDragEnd={handleDragEnd} />)}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Ungrouped section */}
          {groupedKeys.ungrouped.length > 0 && (
            <div
              className={`group-section${dropTarget === "ungrouped" ? " drop-target" : ""}`}
              style={{ borderLeftColor: "var(--text-dim)" }}
              onDragOver={(e) => handleDragOver(e, "ungrouped")}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, null)}
            >
              <div className="group-header" onClick={() => toggleGroup("ungrouped")}>
                <span className={`group-chevron${isExpanded("ungrouped") ? " expanded" : ""}`}>▶</span>
                <div className="group-info">
                  <span style={{ fontSize: "0.9rem" }}>📂</span>
                  <span className="group-name">Ungrouped</span>
                  <span className="group-count">({groupedKeys.ungrouped.length})</span>
                </div>
                <div className="group-health" data-tooltip={healthTip(groupedKeys.ungroupedHealth)} data-tooltip-align="left">
                  {groupedKeys.ungroupedHealth.valid > 0 && <span className="health-dot valid">{groupedKeys.ungroupedHealth.valid}</span>}
                  {groupedKeys.ungroupedHealth.expiring > 0 && <span className="health-dot warning">{groupedKeys.ungroupedHealth.expiring}</span>}
                  {groupedKeys.ungroupedHealth.expired > 0 && <span className="health-dot expired">{groupedKeys.ungroupedHealth.expired}</span>}
                </div>
              </div>
              <div className={`group-keys${isExpanded("ungrouped") ? " expanded" : " collapsed"}`}>
                <div className={view === "grid" ? "keys-grid" : ""}>
                  {groupedKeys.ungrouped.map((k) => <KeyCard key={k.slug} k={k} draggingKey={draggingKey} onDragStart={handleDragStart} onDragEnd={handleDragEnd} />)}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onDone={(slug) => { setShowImport(false); navigate(`/keys/${slug}`); }}
          onError={(msg) => setError(msg)}
        />
      )}

      {showGroupManager && (
        <GroupManagerModal
          groups={groups}
          onClose={() => setShowGroupManager(false)}
          onRefresh={load}
        />
      )}
    </div>
  );
}

/* ── Import Modal with Drag & Drop ─────────────────────────────────── */
function ImportModal({ onClose, onDone, onError }) {
  const [publicFile, setPublicFile] = useState(null);
  const [privateFile, setPrivateFile] = useState(null);
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(null); // "public" | "private"

  const handleDrop = (field) => (e) => {
    e.preventDefault();
    setDragOver(null);
    const file = e.dataTransfer.files[0];
    if (file) field === "public" ? setPublicFile(file) : setPrivateFile(file);
  };

  const dropProps = (field) => ({
    onDragOver: (e) => { e.preventDefault(); setDragOver(field); },
    onDragLeave: () => setDragOver(null),
    onDrop: handleDrop(field),
  });

  const run = async () => {
    if (!publicFile) { setError("Public key file is required."); return; }
    setError(null);
    setLoading(true);
    try {
      const result = await importKey(publicFile, privateFile || null, passphrase || null);
      onDone(result.slug);
    } catch (e) {
      setError(e.response?.data?.detail || e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3>📥 Import Key Pair</h3>

        <div className="form-group">
          <label>Public Key File *</label>
          <div className={`drop-zone${dragOver === "public" ? " drag-over" : ""}`} {...dropProps("public")}
            onClick={() => document.getElementById("pub-file-input").click()}>
            <div className="drop-icon">📄</div>
            <div className="drop-text">{publicFile ? `✅ ${publicFile.name}` : "Drop public key here or click to browse"}</div>
            <div className="drop-hint">.asc, .gpg, .pgp, .txt</div>
          </div>
          <input id="pub-file-input" type="file" accept=".asc,.gpg,.pgp,.txt" style={{ display: "none" }}
            onChange={(e) => setPublicFile(e.target.files[0] || null)} />
        </div>

        <div className="form-group">
          <label>Private Key File (optional)</label>
          <div className={`drop-zone${dragOver === "private" ? " drag-over" : ""}`} {...dropProps("private")}
            onClick={() => document.getElementById("priv-file-input").click()}>
            <div className="drop-icon">🔒</div>
            <div className="drop-text">{privateFile ? `✅ ${privateFile.name}` : "Drop private key here or click to browse"}</div>
            <div className="drop-hint">.asc, .gpg, .pgp, .txt</div>
          </div>
          <input id="priv-file-input" type="file" accept=".asc,.gpg,.pgp,.txt" style={{ display: "none" }}
            onChange={(e) => setPrivateFile(e.target.files[0] || null)} />
        </div>

        <div className="form-group">
          <label>Passphrase (optional — to verify private key)</label>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter passphrase to verify" />
        </div>

        {error && <div style={{ color: "var(--red)", fontSize: "0.85rem", marginBottom: "1rem" }}>{error}</div>}

        <div className="actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={run} disabled={loading}>
            {loading ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}


/* ── Group Manager Modal ──────────────────────────────────────── */
function GroupManagerModal({ groups, onClose, onRefresh }) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#7c8aff");
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [error, setError] = useState(null);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await createGroup({ name: newName.trim(), color: newColor });
      setNewName("");
      onRefresh();
    } catch (e) {
      setError(e.response?.data?.detail || e.message);
    }
  };

  const handleUpdate = async (id) => {
    try {
      await updateGroup(id, { name: editName, color: editColor });
      setEditId(null);
      onRefresh();
    } catch (e) {
      setError(e.response?.data?.detail || e.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteGroup(id);
      onRefresh();
    } catch (e) {
      setError(e.response?.data?.detail || e.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3>📁 Manage Groups</h3>
        <p style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: "1rem" }}>
          Create groups to organize your keys by project, environment, or purpose.
        </p>

        {error && <div style={{ color: "var(--red)", fontSize: "0.85rem", marginBottom: "0.5rem" }}>{error}</div>}

        {/* Existing groups */}
        {groups.map((g) => (
          <div key={g.id} className="group-list-item">
            <span className="group-color-dot" style={{ background: g.color }} />
            {editId === g.id ? (
              <>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                  style={{ flex: 1, padding: "0.3rem 0.5rem", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: "0.85rem" }}
                  onKeyDown={(e) => e.key === "Enter" && handleUpdate(g.id)} />
                <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)}
                  style={{ width: 28, height: 28, border: "none", cursor: "pointer", background: "none", padding: 0 }} />
                <div className="group-actions">
                  <button onClick={() => handleUpdate(g.id)} title="Save">✓</button>
                  <button onClick={() => setEditId(null)} title="Cancel">✕</button>
                </div>
              </>
            ) : (
              <>
                <span className="group-name">{g.name}</span>
                <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{g.keys?.length || 0} keys</span>
                <div className="group-actions">
                  <button onClick={() => { setEditId(g.id); setEditName(g.name); setEditColor(g.color); }} title="Edit">✏️</button>
                  <button onClick={() => handleDelete(g.id)} title="Delete">🗑️</button>
                </div>
              </>
            )}
          </div>
        ))}

        {groups.length === 0 && (
          <div style={{ textAlign: "center", padding: "1rem", color: "var(--text-dim)", fontSize: "0.85rem" }}>
            No groups yet. Create one below.
          </div>
        )}

        {/* Create new group */}
        <div className="group-form-row">
          <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
          <input type="text" placeholder="New group name…" value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
          <button className="btn btn-primary" onClick={handleCreate} style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem" }}>
            + Add
          </button>
        </div>

        <div className="actions" style={{ marginTop: "1.2rem" }}>
          <button className="btn btn-outline" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
