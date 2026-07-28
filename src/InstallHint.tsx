import { useEffect, useState } from "react";

// Installing to the Home Screen is what exempts an iOS PWA from the 7-day storage
// eviction (and gives an app-like launch), so we nudge users who haven't installed.

const DISMISS_KEY = "food-snap-install-hint-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function InstallHint() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone] = useState(isStandalone);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault(); // stash it so we can trigger our own button
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (standalone || dismissed) return null;

  const ios = isIOS();
  // Show only when we can actually help: a native install prompt, or iOS manual steps.
  if (!ios && !deferred) return null;

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    dismiss();
  }

  return (
    <div className="install-hint">
      <div className="install-text">
        <strong>Add SnapGut to your Home Screen</strong>
        <div className="install-sub">
          {ios ? (
            <>Tap the Share button (the box with an ↑) in Safari, then “Add to Home Screen.” It opens like a real app and keeps your data from being cleared.</>
          ) : (
            <>Install it for an app-like launch and to protect your data from being cleared.</>
          )}
        </div>
      </div>
      <div className="install-actions">
        {deferred && (
          <button className="chip selected" onClick={install}>
            Install
          </button>
        )}
        <button className="link-btn" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
