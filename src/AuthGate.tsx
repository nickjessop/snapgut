import { useState } from "react";
import { requestCode, verifyCode, type Me } from "./session";
import AppIcon from "./AppIcon";

interface Props {
  onAuthed: (me: Me) => void;
  /**
   * Present when sign-in was asked for by an AI call site rather than reached at
   * the Login_Route. Renders a way back, because the visitor did not come here to
   * sign in — they came to log a meal, and declining has to leave them where they
   * were with their photo intact.
   */
  onCancel?: () => void;
  /** Overrides the heading and subheading, so the prompt can say why it appeared. */
  heading?: string;
  sub?: string;
}

/** Email + 6-digit code sign-in. Calls onAuthed with the user's entitlement. */
export default function AuthGate({ onAuthed, onCancel, heading, sub }: Props) {
  const [phase, setPhase] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  async function sendCode() {
    setError(null);
    setBusy(true);
    try {
      const r = await requestCode(email.trim());
      setDevCode(r.dev && r.code ? r.code : null);
      setPhase("code");
    } catch (e) {
      setError(friendly((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    setBusy(true);
    try {
      const r = await verifyCode(email.trim(), code.trim());
      onAuthed(r);
    } catch (e) {
      setError(friendly((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app intro auth-gate">
      <div className="auth-body">
        {/* The heading below names the product, so the icon stays decorative. */}
        <div className="intro-badge">
          <AppIcon size={108} />
        </div>
        <h1 className="intro-title">
          {phase === "code"
            ? "Check your email"
            : (heading ?? "Sign in to SnapGut")}
        </h1>
        <p className="intro-sub">
          {phase === "code"
            ? `Enter the code we sent to ${email}.`
            : (sub ?? "We'll email you a 6-digit code. No password needed.")}
        </p>

        {phase === "email" ? (
          <input
            className="search auth-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email && sendCode()}
          />
        ) : (
          <>
            <input
              className="search auth-input code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && code.length === 6 && verify()}
            />
            {devCode && <p className="dev-hint">Dev code: {devCode}</p>}
          </>
        )}

        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="intro-footer">
        {phase === "email" ? (
          <>
            <button
              className="primary"
              disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)}
              onClick={sendCode}
            >
              {busy ? "Sending…" : "Send code"}
            </button>
            {onCancel && (
              <button className="link-btn" onClick={onCancel}>
                Not now
              </button>
            )}
          </>
        ) : (
          <>
            <button className="primary" disabled={busy || code.length !== 6} onClick={verify}>
              {busy ? "Verifying…" : "Verify & continue"}
            </button>
            <button
              className="link-btn"
              onClick={() => {
                setPhase("email");
                setCode("");
                setError(null);
              }}
            >
              Use a different email
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function friendly(err: string): string {
  const map: Record<string, string> = {
    invalid_email: "That email doesn't look right.",
    too_soon: "Hang on a moment before requesting another code.",
    expired: "That code expired — request a new one.",
    wrong_code: "That code isn't right. Try again.",
    too_many_attempts: "Too many attempts. Request a new code.",
  };
  return map[err] || "Something went wrong. Please try again.";
}
