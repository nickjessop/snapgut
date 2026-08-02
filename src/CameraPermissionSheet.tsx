import { CheckIcon } from "./icons";

/**
 * How to stop iOS asking for the camera every launch.
 *
 * The setting is not reachable from inside an installed app — it belongs to the origin
 * as Safari sees it, so it has to be changed in Safari with the site open, and it then
 * applies to the installed app too. That indirection is the whole reason this needs
 * explaining rather than a button.
 *
 * Two routes, because Apple has moved the second one: the per-site menu is stable across
 * versions, and the global toggle sits under Apps on iOS 18 and directly in Settings
 * before that.
 */
export default function CameraPermissionSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Stop iOS asking for the camera"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="action-grip" />

        <div className="paywall-head">
          <div className="paywall-title">Stop the camera prompt</div>
          <div className="paywall-sub">
            iOS asks again each launch while the camera is set to “Ask”. Switching it to
            “Allow” is remembered, and on most recent versions the installed app picks it
            up too.
          </div>
        </div>

        <ol className="install-steps">
          <li>
            Open <strong>Safari</strong> and go to <strong>snapgut.com</strong>.
          </li>
          <li>
            Tap the page settings button at the left of the address bar — the{" "}
            <strong>aA</strong> icon, or <strong>⋯</strong> on newer versions.
          </li>
          <li>
            Choose <strong>Website Settings</strong>.
          </li>
          <li>
            Set <strong>Camera</strong> to <strong>Allow</strong>.
          </li>
        </ol>

        <p className="hint">
          There is also a device-wide version: <strong>Settings → Safari → Camera →
          Allow</strong>. On iOS 18 and later Safari sits under <strong>Settings →
          Apps</strong>.
        </p>

        <button className="action-cancel" onClick={onClose}>
          <CheckIcon size={16} />
          Got it
        </button>
      </div>
    </div>
  );
}
