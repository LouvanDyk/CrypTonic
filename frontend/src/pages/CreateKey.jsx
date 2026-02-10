import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import zxcvbn from "zxcvbn";
import { createKey } from "../api";

/* ── Passphrase Strength Meter ─────────────────────────────────────── */
const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Strong", "Excellent"];
const STRENGTH_COLORS = ["var(--red)", "#f97316", "var(--yellow)", "#22d3ee", "var(--green)"];

function StrengthMeter({ passphrase }) {
  const result = useMemo(() => (passphrase ? zxcvbn(passphrase) : null), [passphrase]);
  if (!passphrase) return null;
  const score = result.score; // 0-4
  const pct = ((score + 1) / 5) * 100;
  return (
    <>
      <div className="strength-meter">
        <div className="strength-fill" style={{ width: `${pct}%`, background: STRENGTH_COLORS[score] }} />
      </div>
      <div className="strength-label" style={{ color: STRENGTH_COLORS[score] }}>
        {STRENGTH_LABELS[score]}
        {result.feedback?.warning && <span style={{ color: "var(--text-dim)", marginLeft: "0.5rem" }}>— {result.feedback.warning}</span>}
      </div>
    </>
  );
}

/* ── Progress Stepper ──────────────────────────────────────────────── */
const STEPS = ["Validating", "Generating primary key", "Generating subkey", "Signing", "Saving"];

function ProgressStepper({ active }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) { setStep(0); return; }
    // Simulate progress through steps
    const timers = STEPS.map((_, i) =>
      setTimeout(() => setStep(i), i * 1200)
    );
    return () => timers.forEach(clearTimeout);
  }, [active]);

  if (!active) return null;

  return (
    <div className="progress-stepper">
      {STEPS.map((label, i) => (
        <span key={i} style={{ display: "contents" }}>
          <div className={`step${i < step ? " done" : i === step ? " active" : ""}`}>
            <span className="step-dot" />
            <span>{label}</span>
          </div>
          {i < STEPS.length - 1 && <span className={`step-line${i < step ? " done" : ""}`} />}
        </span>
      ))}
    </div>
  );
}

/* ── Create Key Page ───────────────────────────────────────────────── */
export default function CreateKey() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "", email: "", comment: "", passphrase: "", confirm: "",
    key_size: 4096, expiry_days: 365,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) return setError("Name is required");
    if (!form.email.trim()) return setError("Email is required");
    if (!form.passphrase) return setError("Passphrase is required");
    if (form.passphrase !== form.confirm) return setError("Passphrases do not match");

    setLoading(true);
    try {
      const result = await createKey({
        name: form.name, email: form.email, comment: form.comment,
        passphrase: form.passphrase, key_size: Number(form.key_size),
        expiry_days: Number(form.expiry_days),
      });
      navigate(`/keys/${result.slug}`);
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">🔐 Create Key Pair</h1>

      <ProgressStepper active={loading} />

      <form onSubmit={submit} style={{ maxWidth: 520 }}>
        <div className="form-group">
          <label>Full Name *</label>
          <input value={form.name} onChange={set("name")} placeholder="John Doe" />
        </div>
        <div className="form-group">
          <label>Email Address *</label>
          <input type="email" value={form.email} onChange={set("email")} placeholder="john@example.com" />
        </div>
        <div className="form-group">
          <label>Comment (optional)</label>
          <input value={form.comment} onChange={set("comment")} placeholder="e.g. File Encryption" />
        </div>
        <div style={{ display: "flex", gap: "1rem" }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Key Size</label>
            <select value={form.key_size} onChange={set("key_size")}>
              <option value={4096}>4096 bits (recommended)</option>
              <option value={2048}>2048 bits</option>
            </select>
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Expiration (days)</label>
            <input type="number" min="1" value={form.expiry_days} onChange={set("expiry_days")} />
          </div>
        </div>
        <div className="form-group">
          <label>Passphrase *</label>
          <input type="password" value={form.passphrase} onChange={set("passphrase")} />
          <StrengthMeter passphrase={form.passphrase} />
        </div>
        <div className="form-group">
          <label>Confirm Passphrase *</label>
          <input type="password" value={form.confirm} onChange={set("confirm")} />
        </div>

        {error && <div style={{ color: "var(--red)", marginBottom: "1rem", fontSize: "0.85rem" }}>{error}</div>}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? "⏳ Generating…" : "🔑 Generate Key Pair"}
        </button>
      </form>
    </div>
  );
}
