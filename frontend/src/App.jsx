import { BrowserRouter, Routes, Route, Link, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback, createContext, useContext } from "react";
import { listKeys } from "./api";
import Dashboard from "./pages/Dashboard";
import CreateKey from "./pages/CreateKey";
import KeyDetail from "./pages/KeyDetail";
import "./App.css";

/* ── Theme Context ─────────────────────────────────────────────────── */
const ThemeCtx = createContext();
export const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}

/* ── Command Palette ───────────────────────────────────────────────── */
function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState("");
  const [keys, setKeys] = useState([]);
  const [idx, setIdx] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQuery("");
      setIdx(0);
      listKeys().then(setKeys).catch(() => {});
    }
  }, [open]);

  const actions = [
    { icon: "➕", label: "Create new key", path: "/create" },
    { icon: "🏠", label: "Go to dashboard", path: "/" },
  ];

  const keyItems = keys
    .filter((k) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (k.name || "").toLowerCase().includes(q) ||
        (k.email || "").toLowerCase().includes(q) ||
        (k.key_id || "").toLowerCase().includes(q);
    })
    .map((k) => ({ icon: "🔑", label: k.name || k.slug, hint: k.key_id, path: `/keys/${k.slug}` }));

  const items = [...actions, ...keyItems].filter((it) => {
    if (!query) return true;
    return it.label.toLowerCase().includes(query.toLowerCase());
  });

  const go = (item) => { navigate(item.path); onClose(); };

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && items[idx]) { go(items[idx]); }
    else if (e.key === "Escape") { onClose(); }
  };

  if (!open) return null;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          placeholder="Search keys or actions…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIdx(0); }}
          onKeyDown={onKey}
          autoFocus
        />
        <div className="palette-results">
          {items.map((it, i) => (
            <div
              key={i}
              className={`palette-item${i === idx ? " selected" : ""}`}
              onClick={() => go(it)}
              onMouseEnter={() => setIdx(i)}
            >
              <span className="palette-icon">{it.icon}</span>
              <span className="palette-label">{it.label}</span>
              {it.hint && <span className="palette-hint">{it.hint}</span>}
            </div>
          ))}
          {items.length === 0 && (
            <div className="palette-item" style={{ color: "var(--text-dim)" }}>No results</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── App Shell ─────────────────────────────────────────────────────── */
function AppShell() {
  const { theme, toggle } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();

  const handleGlobalKeys = useCallback((e) => {
    // Don't fire shortcuts when typing in inputs
    const tag = e.target.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setPaletteOpen((v) => !v);
      return;
    }
    if (e.key === "Escape") {
      setPaletteOpen(false);
      return;
    }
    if (inInput) return;
    if (e.key === "n" || e.key === "N") { navigate("/create"); }
    else if (e.key === "i" || e.key === "I") { navigate("/"); /* import handled on dashboard */ }
    else if (e.key === "/") { e.preventDefault(); document.querySelector(".search-input")?.focus(); }
  }, [navigate]);

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeys);
    return () => window.removeEventListener("keydown", handleGlobalKeys);
  }, [handleGlobalKeys]);

  return (
    <div className="app">
      <header className="header">
        <Link to="/" className="logo">🔐 CrypTonic</Link>
        <div className="header-right">
          <nav>
            <Link to="/">Keys</Link>
            <Link to="/create">Create Key</Link>
          </nav>
          <button className="theme-toggle" onClick={toggle} title="Toggle theme">
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button className="btn btn-outline" onClick={() => setPaletteOpen(true)} style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}>
            <span className="kbd">⌘K</span>
          </button>
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/create" element={<CreateKey />} />
          <Route path="/keys/:slug" element={<KeyDetail />} />
        </Routes>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
