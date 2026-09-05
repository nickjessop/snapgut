/**
 * Noticing that iOS keeps asking for the camera, without being able to ask it.
 *
 * There is no API for this. `navigator.permissions.query({ name: "camera" })` is not
 * implemented in Safari, and `getUserMedia` resolves the same way whether the grant was
 * silent or the user just tapped Allow. So the state cannot be read.
 *
 * It can be *timed*, though. A standing grant resolves in a few tens of milliseconds —
 * it is a device handle, nothing more. A prompt cannot resolve until a human has looked
 * at a dialog and tapped it, which does not happen in under a second. So a slow
 * successful acquisition is near-certainly a prompt that was answered.
 *
 * That is a heuristic and it is treated as one. It takes two slow launches before
 * anything is said, and the worst a false positive can do is offer a dismissible tip
 * about a setting that would have been worth knowing anyway. The instructions live in
 * Settings regardless, so nobody depends on this guess to find them.
 *
 * Android is excluded: installed Chromium PWAs hold camera permission across launches
 * like an installed app, so there is nothing to work around.
 */

/** Below this, no human was involved. Generous — slow hardware must not count. */
const PROMPT_MS = 1_200;
/** Slow launches before we say anything. One could be a cold camera. */
const MIN_SIGHTINGS = 2;

const COUNT_KEY = "food-snap-camera-prompt-count";
const DISMISS_KEY = "food-snap-camera-hint-dismissed";

function read(key: string): number {
  try {
    const n = Number(localStorage.getItem(key) ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function isIOS(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * Called once per launch with how long the first successful acquisition took.
 *
 * Once per launch on purpose: within a session the stream is shared, so a second
 * acquisition is a cache hit and would only ever look fast — counting those would drag
 * the evidence toward "no prompt" every time the user moved between tabs.
 */
let recordedThisLaunch = false;

export function recordCameraAcquisition(ms: number): void {
  if (recordedThisLaunch) return;
  recordedThisLaunch = true;
  if (!isIOS() || !isStandalone()) return;
  if (ms < PROMPT_MS) return;
  try {
    localStorage.setItem(COUNT_KEY, String(read(COUNT_KEY) + 1));
  } catch {
    /* nothing to remember it with; the tip simply never fires */
  }
}

/** Whether the camera screen should offer the tip. */
export function shouldOfferCameraHint(): boolean {
  if (!isIOS() || !isStandalone()) return false;
  try {
    if (localStorage.getItem(DISMISS_KEY) === "1") return false;
  } catch {
    return false;
  }
  return read(COUNT_KEY) >= MIN_SIGHTINGS;
}

export function dismissCameraHint(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* the caller's own state still hides it for this session */
  }
}

/**
 * Whether to show the instructions in Settings. Not gated on the heuristic or on the
 * dismissal — on iOS this is worth being able to find on purpose, and someone who
 * dismissed the tip is exactly the person who later goes looking for it.
 */
export function cameraHintApplies(): boolean {
  return isIOS();
}
