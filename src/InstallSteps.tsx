import { isIOS } from "./installPrompt";
import { CheckIcon } from "./icons";

/**
 * The manual route to the Home Screen, for iOS — and for any browser that hands us no
 * install event, where telling someone where the menu is beats a button that does
 * nothing.
 *
 * Its own sheet rather than copy inside the toast: the steps only matter once, to
 * someone who has already said yes, and the toast has to stay small enough to sit above
 * the nav without becoming the screen.
 */
export default function InstallSteps({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** Called by "Done" — treated as an answer, so the nudge stops. */
  onDone: () => void;
}) {
  const ios = isIOS();

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="action-sheet install-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Add SnapGut to your Home Screen"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="action-grip" />

        <div className="sheet-head">
          <div className="sheet-title">Add to Home Screen</div>
          <div className="sheet-sub">
            {ios
              ? "Safari can clear a website's data after a week of not visiting it. Adding SnapGut to your Home Screen stops that, and it opens straight to the camera."
              : "Your browser handles this from its own menu. Installing keeps your log from being cleared, and opens straight to the camera."}
          </div>
        </div>

        {ios ? (
          <ol className="install-steps">
            <li>
              Tap <strong>Share</strong> in Safari — the square with an arrow pointing up.
            </li>
            <li>
              Scroll down and choose <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong>. That's it.
            </li>
          </ol>
        ) : (
          <ol className="install-steps">
            <li>Open your browser's menu — usually ⋮ or ⋯.</li>
            <li>
              Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.
            </li>
            <li>Confirm, and it will appear alongside your other apps.</li>
          </ol>
        )}

        <button className="action-cancel" onClick={onDone}>
          <CheckIcon size={16} />
          Done
        </button>
      </div>
    </div>
  );
}
