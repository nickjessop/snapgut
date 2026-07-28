import { useState } from "react";
import type { Entitlement } from "./session";
import { InsightsIcon, StreakIcon } from "./icons";

interface Props {
  entitlement: Entitlement | null;
  streak?: number; // 0 / omitted hides the streak chip
  onUpgrade: () => void;
}

type Modal = null | "credits" | "streak";

/**
 * The header chips (logging streak + free-AI count / PRO badge). Each chip is
 * just an icon + number; tapping opens a small sheet explaining it.
 */
export default function HeaderStats({ entitlement, streak = 0, onUpgrade }: Props) {
  const [modal, setModal] = useState<Modal>(null);
  const freeLeft = entitlement
    ? Math.max(0, entitlement.freeAiLimit - entitlement.freeAiUsed)
    : 0;

  return (
    <>
      {streak >= 2 && (
        <button className="streak" onClick={() => setModal("streak")} title="Logging streak">
          <StreakIcon size={14} />
          {streak}
        </button>
      )}
      {entitlement &&
        (entitlement.pro ? (
          <span className="pro-badge" title="SnapGut Pro">
            <InsightsIcon size={13} />
            PRO
          </span>
        ) : (
          <button
            className="credits-pill"
            onClick={() => setModal("credits")}
            title="AI uses left"
          >
            <InsightsIcon size={13} />
            {freeLeft}
          </button>
        ))}

      {modal && (
        <div className="sheet-backdrop" onClick={() => setModal(null)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
            {modal === "credits" ? (
              <>
                <div className="info-title">
                  <InsightsIcon size={20} />
                  {freeLeft} free AI {freeLeft === 1 ? "use" : "uses"} left
                </div>
                <p className="info-copy">
                  Free AI uses power both photo meal recognition and AI insights —
                  they draw from one shared pool. Logging and your on-device trends
                  stay free forever; unlimited AI unlocks with SnapGut Pro.
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    setModal(null);
                    onUpgrade();
                  }}
                >
                  Unlock Pro
                </button>
                <button className="action-cancel" onClick={() => setModal(null)}>
                  Maybe later
                </button>
              </>
            ) : (
              <>
                <div className="info-title streak-modal">
                  <StreakIcon size={20} />
                  {streak}-day streak
                </div>
                <p className="info-copy">
                  You've logged something {streak} days in a row. The more
                  consistently you log, the more the pattern-finder has to work with —
                  so your insights get sharper over time.
                </p>
                <button className="action-cancel" onClick={() => setModal(null)}>
                  Got it
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
