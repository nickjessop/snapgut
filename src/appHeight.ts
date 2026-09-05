/**
 * The app frame's height, measured rather than expressed in CSS units.
 *
 * Every CSS unit for "the whole screen" has been tried here and each one came back
 * short on an installed iOS app, leaving a band below the tab bar. `100%` inherited
 * through `html`, `100vh`, `100dvh`, and `position: fixed; inset: 0` all resolve
 * against the CSS viewport, and in standalone mode with `viewport-fit=cover` that
 * viewport is the one *inside* the safe areas even though the web view itself covers
 * the screen. So the box was correct by the box model and still wrong on the glass.
 *
 * `window.innerHeight` is the exception: in standalone mode it reports the web view's
 * own height, safe areas included. Writing it to a custom property and sizing the
 * frame in pixels sidesteps the disagreement entirely, and behaves identically
 * everywhere the units were already right.
 *
 * Deliberately not `visualViewport.height`: that shrinks when the keyboard opens, and
 * collapsing the app frame around a keyboard is a different bug. `innerHeight` holds
 * still on iOS while the keyboard overlays, and tracks the real resize on Android,
 * which is what each platform does natively.
 */

let frame = 0;

function measure() {
  frame = 0;
  const h = window.innerHeight;
  // A zero would blank the app, and some browsers report one mid-navigation.
  if (h > 0) {
    document.documentElement.style.setProperty("--app-height", `${h}px`);
  }
}

/** Coalesced so a rotation or a bar animation cannot run this once per frame. */
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(measure);
}

export function startAppHeightSync(): () => void {
  measure();

  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  // iOS finishes an orientation change after the event fires, so the value read at
  // that moment is the pre-rotation one. A second read settles it.
  window.addEventListener("orientationchange", () => {
    setTimeout(measure, 250);
  });
  // Covers the iOS bar collapse, which changes innerHeight without a resize event.
  window.visualViewport?.addEventListener("resize", schedule);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
  };
}
