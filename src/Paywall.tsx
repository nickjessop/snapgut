import { useEffect, useState } from "react";
import { fetchPacks, checkout, type Pack } from "./session";

interface Props {
  reason?: "out" | "topup";
  onClose: () => void;
  onPurchased: (credits: number) => void;
}

/** Credit packs. Dev: purchase is simulated and credits update instantly.
 *  Prod: redirects to Stripe Checkout. */
export default function Paywall({ reason = "topup", onClose, onPurchased }: Props) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPacks().then(setPacks);
  }, []);

  async function buy(pack: string) {
    setError(null);
    setBusy(pack);
    try {
      const r = await checkout(pack);
      if (r.url) {
        window.location.href = r.url; // Stripe Checkout
        return;
      }
      if (typeof r.credits === "number") onPurchased(r.credits); // dev simulated
    } catch {
      setError("Couldn't start checkout. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="action-grip" />
        <div className="paywall-head">
          <div className="paywall-title">
            {reason === "out" ? "You're out of credits" : "Get more credits"}
          </div>
          <div className="paywall-sub">
            Credits power AI meal recognition. 1 credit per meal analyzed.
          </div>
        </div>

        {packs.map((p) => (
          <button
            key={p.id}
            className="action-item pack"
            disabled={busy !== null}
            onClick={() => buy(p.id)}
          >
            <div>
              <div className="ai-title">{p.credits} credits</div>
              <div className="ai-sub">{(p.credits / (p.price / 100)).toFixed(0)} per $1</div>
            </div>
            <div className="pack-price">
              {busy === p.id ? "…" : `$${(p.price / 100).toFixed(0)}`}
            </div>
          </button>
        ))}

        {error && <div className="error-banner">{error}</div>}

        <button className="action-cancel" onClick={onClose}>
          {reason === "out" ? "Not now" : "Close"}
        </button>
      </div>
    </div>
  );
}
