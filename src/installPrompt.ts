/**
 * Everything about "add this to your Home Screen", in one place and platform-agnostic.
 *
 * Installing is not cosmetic: on iOS it is what exempts the app from the seven-day
 * storage eviction that would otherwise clear a browser-tab user's whole log, and on
 * both platforms it is what makes a launch open to the camera instead of a tab.
 *
 * The two platforms differ only in the last step. Chromium hands us a real install
 * event we can fire; iOS has no such API and the user has to go through the Share
 * sheet. Everything before that — when to ask, how it appears, what dismissing means —
 * is identical, so the UI treats them the same and only the final action branches.
 *
 * The `beforeinstallprompt` listener is registered at module load rather than inside a
 * component. Chromium fires it once, early, and often before React has mounted; an
 * effect-registered listener misses it and the install button then never appears.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Dismissed for good. One key, because there is now one dismissal and it is final. */
const DISMISSED_KEY = "food-snap-install-dismissed";

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Held back so our own control chooses the moment, instead of the browser's
    // mini-infobar appearing whenever it likes.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

/** Subscribe to install-availability changes. Returns an unsubscribe. */
export function subscribeInstall(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isStandalone(): boolean {
  if (installed) return true;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports as a Mac; the touch point count is what still separates them.
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

/** Whether the browser has given us something to fire. */
export function canPromptNatively(): boolean {
  return deferred !== null;
}

export function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Without storage a refusal cannot be remembered, and a nudge that reappears after
    // every dismissal is worse than none. Treat it as already dismissed.
    return true;
  }
}

export function setDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* nothing to remember it with; the caller's own state still hides it */
  }
  emit();
}

/** Undo a dismissal, for the control in Settings. */
export function clearDismissed() {
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* as above */
  }
  emit();
}

/**
 * Whether there is any point offering an install: not already installed, and either a
 * real prompt to fire or iOS, where the steps are manual but at least describable.
 * Says nothing about dismissal — callers decide that, because Settings offers it
 * whether or not the toast was dismissed.
 */
export function canInstall(): boolean {
  return !isStandalone() && (canPromptNatively() || isIOS());
}

/**
 * Fire the browser's install prompt. Resolves to whether it was actually shown, so a
 * caller can fall back to instructions rather than appearing to do nothing.
 */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  try {
    await deferred.prompt();
    // One shot only: the event cannot be reused once prompted.
    deferred = null;
    emit();
    return true;
  } catch {
    return false;
  }
}
