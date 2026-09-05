import { useState } from "react";
import { signIn, type Me } from "./session";
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

/** Single-password sign-in. Calls onAuthed with the user on success. */
export default function AuthGate({ onAuthed, onCancel, heading, sub }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const me = await signIn(password);
      onAuthed(me);
    } catch {
      setError("Sign in failed");
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
        <h1 className="intro-title">{heading ?? "Sign in to SnapGut"}</h1>
        <p className="intro-sub">
          {sub ?? "Enter your password to continue."}
        </p>

        <input
          className="search auth-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && password && submit()}
        />

        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="intro-footer">
        <button
          className="primary"
          disabled={busy || !password}
          onClick={submit}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {onCancel && (
          <button className="link-btn" onClick={onCancel}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}
