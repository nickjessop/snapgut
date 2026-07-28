import { useState } from "react";
import { requestCode, verifyCode } from "./session";
import { MealIcon } from "./icons";

/** Email + 6-digit code sign-in. Calls onAuthed with the starting credit balance. */
export default function AuthGate({ onAuthed }: { onAuthed: (credits: number) => void }) {
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
      onAuthed(r.credits);
    } catch (e) {
      setError(friendly((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app intro auth-gate">
      <div className="auth-body">
        <div className="intro-badge">
          <MealIcon size={48} strokeWidth={1.75} />
        </div>
        <h1 className="intro-title">
          {phase === "email" ? "Sign in to SnapGut" : "Check your email"}
        </h1>
        <p className="intro-sub">
          {phase === "email"
            ? "We'll email you a 6-digit code. No password needed."
            : `Enter the code we sent to ${email}.`}
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
          <button
            className="primary"
            disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)}
            onClick={sendCode}
          >
            {busy ? "Sending…" : "Send code"}
          </button>
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
