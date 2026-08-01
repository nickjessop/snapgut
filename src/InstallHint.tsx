import { useEffect, useState } from "react";

/**
 * The nudge to add SnapGut to the Home Screen.
 *
 * Installing is not cosmetic here: on iOS it is what exempts the app from the
 * seven-day storage eviction that would otherwise delete a browser-tab user's log,
 * and it is what makes the launch feel like an app rather than a tab.
 *
 * This used to be an inline banner in the Logs list, shown on the first visit. Two
 * things were wrong with that. It only existed on one tab, so most people never met
 * it; and it asked before there was anything to protect — a visitor who has logged
 * nothing has no reason to install, and being asked immediately is how a prompt
 * teaches people to dismiss prompts.
 *
 * So it now waits until the user has saved a couple of logs, appears as a sheet
 * wherever they are, and snoozes rather than vanishing forever.
 */

/** Permanently dismissed ("Don't ask again"). */
const NEVER_KEY = "food-snap-install-hint-dismissed";
/** Epoch ms of the last snooze. */
const SNOOZE_KEY = "food-snap-install-snoozed-at";
/** How long "Not now" lasts. Long enough not to nag, short enough to catch a keeper. */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
/** Logs saved before we ask. Two means the habit has started, not just curiosity. */
const MIN_LOGS = 2;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** True while the nudge is snoozed or permanently declined. */
function suppressed(): boolean {
  try {
    if (localStorage.getItem(NEVER_KEY) === "1") return true;
    const at = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Number.isFinite(at) && at > 0 && Date.now() - at < SNOOZE_MS;
  } catch {
    // No storage means we cannot remember a refusal, and a prompt that cannot be
    // dismissed is worse than no prompt.
    return true;
  }
}

interface Props {
  /** How many logs this device has saved. The prompt waits for a couple. */
  logCount: number;
}

export default function InstallHint({ logCount }: Props) {
  const [hidden, setHidden] = useState(() => isStandalone() || suppressed());
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Stashed so our own control can trigger it at a sensible moment, rather than
      // the browser's mini-infobar firing whenever it likes.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    // Fired by Chromium once the install completes, so the sheet goes away without
    // waiting for a relaunch to notice standalone mode.
    const onInstalled = () => setHidden(true);

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const ios = isIOS();
  // Only ask where we can actually help: a real install prompt to offer, or iOS,
  // where the steps are manual but at least describable.
  if (hidden || logCount < MIN_LOGS || (!ios && !deferred)) return null;

  function snooze() {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      /* nothing to remember it with; the session-level state below still applies */
    }
    setHidden(true);
  }

  function never() {
    try {
      localStorage.setItem(NEVER_KEY, "1");
    } catch {
      /* as above */
    }
    setHidden(true);
  }

  async function install() {
    if (!deferred) return;
    try {
      await deferred.prompt();
    } catch {
      /* the browser declined to show it; treat as a snooze rather than an error */
    }
    // Either outcome ends this sheet: accepting installs, declining is an answer.
    // `appinstalled` handles the success case if it arrives later.
    snooze();
  }

  return (
    <div className="sheet-backdrop" onClick={snooze}>
      <div
        className="action-sheet install-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Add SnapGut to your Home Screen"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="action-grip" />

        <div className="paywall-head">
          <div className="paywall-title">Keep your log safe</div>
          <div className="paywall-sub">
            {ios ? (
              <>
                Your log lives on this device, and Safari can clear a website's data
                after a week of not visiting. Adding SnapGut to your Home Screen stops
                that, and opens it straight to the camera.
              </>
            ) : (
              <>
                Install SnapGut for an app-like launch straight to the camera, and to
                keep the browser from clearing your log.
              </>
            )}
          </div>
        </div>

        {ios ? (
          <ol className="install-steps">
            <li>
              Tap <strong>Share</strong> in Safari — the square with an arrow pointing
              up.
            </li>
            <li>
              Scroll down and choose <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong>. That's it.
            </li>
          </ol>
        ) : (
          <button className="primary" onClick={install}>
            Add to Home Screen
          </button>
        )}

        <button className="action-cancel" onClick={snooze}>
          Not now
        </button>
        <button className="link-btn install-never" onClick={never}>
          Don't ask again
        </button>
      </div>
    </div>
  );
}
