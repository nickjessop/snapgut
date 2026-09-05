import { useState } from "react";
import { CheckIcon, StreakIcon } from "./icons";

interface Props {
  streak?: number; // 0 / omitted hides the streak chip
}

type Modal = null | "streak";

/**
 * The header chip (logging streak). The chip is just an icon + number; tapping
 * opens a small sheet explaining it.
 */
export default function HeaderStats({ streak = 0 }: Props) {
  const [modal, setModal] = useState<Modal>(null);

  return (
    <>
      {streak >= 2 && (
        <button className="streak" onClick={() => setModal("streak")} title="Logging streak">
          <StreakIcon size={14} />
          {streak}
        </button>
      )}

      {modal && (
        <div className="sheet-backdrop" onClick={() => setModal(null)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-grip" />
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
              <CheckIcon size={17} />
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
