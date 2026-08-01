/**
 * Sideways swipe between the Addressable_Views.
 *
 * It deliberately does *not* move the view itself. It reports a direction and lets
 * `src/App.tsx` call the same `goToView` a tab tap calls, so the URL and the history
 * entry come out identical either way — Requirement 4.2 says a view change adds
 * exactly one entry, and a gesture that wrote history by itself would be a second
 * way to get that wrong.
 *
 * Most of the work here is deciding what is *not* a swipe. The app is full of things
 * a horizontal drag already means something to — the `.hscroll` chip rows in the When
 * picker and the Foods list, text selection in a note, a scrollable table — and
 * stealing the gesture from any of them would trade one nicety for a broken control.
 */

import { useEffect, useRef } from "react";

/** Minimum horizontal travel, in CSS pixels, before a drag counts. */
const MIN_DISTANCE = 60;

/**
 * How much more horizontal than vertical the movement must be. A diagonal drag is
 * almost always an imprecise vertical scroll, and treating it as a page change is
 * the single most irritating way to get this wrong.
 */
const DIRECTION_RATIO = 1.5;

/** Longer than this is a considered drag, not a flick — most likely a selection. */
const MAX_DURATION_MS = 600;

/** Opt out of swipe handling for a subtree. */
const OPT_OUT_ATTR = "data-no-swipe";

/**
 * True where the gesture belongs to something else: a horizontal scroller, a form
 * control, or an explicit opt-out. Walks up from the touch target, because the
 * ancestor is what owns the scroll, not the element under the finger.
 */
function ownedByAnotherControl(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el.hasAttribute(OPT_OUT_ATTR)) return true;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    // Anything that can actually scroll sideways keeps the gesture. `.hscroll` is
    // checked by class as well because a row that does not currently overflow — few
    // enough chips to fit — should still not flip the page when swiped.
    if (el.classList.contains("hscroll")) return true;
    const overflowX = getComputedStyle(el).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

export interface SwipeNavOptions {
  /** Called with the direction the content should move. */
  onSwipe: (direction: "next" | "prev") => void;
  /** Off while a flow, sheet, or sign-in screen owns the screen. */
  enabled?: boolean;
}

/**
 * Attaches passive touch listeners to the document for the life of the component.
 *
 * Passive, because this never calls `preventDefault`: suppressing the default would
 * mean fighting the browser for vertical scrolling, and the ratio check already
 * ensures a vertical drag is ignored rather than intercepted.
 */
export function useSwipeNav({ onSwipe, enabled = true }: SwipeNavOptions): void {
  // Read through a ref so the listeners register once and never go stale.
  const handler = useRef(onSwipe);
  handler.current = onSwipe;

  useEffect(() => {
    if (!enabled) return;

    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let tracking = false;

    function onTouchStart(e: TouchEvent) {
      // Multi-touch is a pinch or a zoom, never a page change.
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      if (ownedByAnotherControl(e.target)) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startedAt = Date.now();
      tracking = true;
    }

    function onTouchMove(e: TouchEvent) {
      // A second finger arriving mid-drag cancels it.
      if (e.touches.length !== 1) tracking = false;
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return;
      tracking = false;

      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (Date.now() - startedAt > MAX_DURATION_MS) return;
      if (Math.abs(dx) < MIN_DISTANCE) return;
      if (Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) return;

      // Dragging left reveals what is to the right, like a carousel.
      handler.current(dx < 0 ? "next" : "prev");
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled]);
}

export default useSwipeNav;
