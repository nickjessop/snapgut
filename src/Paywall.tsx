import { useEffect, useState } from "react";
import { fetchPlans, checkout, type Plan, type Entitlement } from "./session";

interface Props {
  reason?: "out" | "upsell";
  onClose: () => void;
  onUpgraded: (ent: Entitlement) => void;
}

/** SnapGut Pro upsell. Dev: purchase is simulated and Pro unlocks instantly.
 *  Prod: redirects to Stripe Checkout. */
export default function Paywall({ reason = "upsell", onClose, onUpgraded }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPlans().then(setPlans);
  }, []);

  async function choose(plan: string) {
    setError(null);
    setBusy(plan);
    try {
      const r = await checkout(plan);
      if (r.url) {
        window.location.href = r.url; // Stripe Checkout
        return;
      }
      if (r.pro) onUpgraded(r as Entitlement); // dev simulated
    } catch {
      setError("Couldn't start checkout. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="action-sheet upgrade" onClick={(e) => e.stopPropagation()}>
        <div className="action-grip" />
        <div className="paywall-head">
          <div className="paywall-title">
            {reason === "out" ? "You've used your free AI" : "Unlock SnapGut Pro"}
          </div>
          <div className="paywall-sub">
            Unlimited AI meal recognition and AI insights. Your logging & on-device
            trends stay free forever.
          </div>
        </div>

        {plans.map((p) => (
          <button
            key={p.id}
            className={`plan-card${p.id === "lifetime" ? " best" : ""}`}
            disabled={busy !== null}
            onClick={() => choose(p.id)}
          >
            <div className="plan-left">
              <div className="plan-label">
                {p.label}
                {p.id === "lifetime" && <span className="plan-tag">Best value</span>}
              </div>
              <div className="plan-caption">{p.caption}</div>
            </div>
            <div className="plan-right">
              <div className="plan-price">
                {busy === p.id ? "…" : `$${(p.price / 100).toFixed(2).replace(/\.00$/, "")}`}
              </div>
              <div className="plan-per">{p.per}</div>
            </div>
          </button>
        ))}

        {error && <div className="error-banner">{error}</div>}

        <button className="action-cancel" onClick={onClose}>
          {reason === "out" ? "Maybe later" : "Not now"}
        </button>
      </div>
    </div>
  );
}
