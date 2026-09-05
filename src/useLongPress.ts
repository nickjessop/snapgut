/**
 * Tap versus press-and-hold on the same control.
 *
 * A symptom chip has two jobs: tapping selects it, holding opens its detail. Getting
 * that right is mostly about the cases that are *neither* — a drag that begins on a
 * chip while scrolling a row, a second finger arriving, a hold that wanders off the
 * control. Each of those has to cancel rather than fire something.
 *
 * Pointer events rather than touch events, so the same code serves a mouse (press and
 * hold works there too) and a stylus. The tap is delivered through `click` rather than
 * `pointerup` so the keyboard path — Enter and Space on a button — still works without
 * a second code path; a hold sets a flag that swallows the click that follows it.
 */

import { useCallback, useEffect, useRef } from "react";

/** How long a press has to be held. Long enough not to fire while scrolling. */
const HOLD_MS = 450;

/** Movement past this cancels the hold: the finger is scrolling, not pressing. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function useLongPress(
  onLongPress: () => void,
  onTap: () => void,
  holdMs = HOLD_MS
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** Set when a hold fired, so the click it produces is swallowed once. */
  const fired = useRef(false);

  // Read through refs so the returned handlers stay stable across renders.
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;
  const tapRef = useRef(onTap);
  tapRef.current = onTap;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  // A hold that is interrupted by unmount must not fire into a gone component.
  useEffect(() => clear, [clear]);

  return {
    onPointerDown: (e) => {
      // Ignore a secondary pointer (the second finger of a pinch) and a non-left
      // mouse button. Tested against `false` rather than for truthiness on purpose:
      // `isPrimary` is absent in some environments, and treating "not reported" as
      // "not primary" would disable the gesture entirely rather than degrade it.
      if (e.isPrimary === false) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      fired.current = false;
      start.current = {
        x: Number.isFinite(e.clientX) ? e.clientX : Number.NaN,
        y: Number.isFinite(e.clientY) ? e.clientY : Number.NaN,
      };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        longPressRef.current();
      }, holdMs);
    },

    onPointerMove: (e) => {
      if (start.current === null) return;
      // The chip rows scroll horizontally, so a drag beginning on a chip is far more
      // often a scroll than a press. Cancelling on movement is what keeps the two
      // gestures from fighting.
      //
      // Where coordinates are not reported, any movement cancels. Comparing against
      // an absent coordinate yields NaN, and every NaN comparison is false — so the
      // tolerance would silently stop working rather than fail loudly. A real browser
      // always reports them, so this branch only affects environments that do not.
      if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) {
        clear();
        return;
      }
      const dx = Math.abs(e.clientX - start.current.x);
      const dy = Math.abs(e.clientY - start.current.y);
      if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
    },

    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,

    onClick: (e) => {
      clear();
      if (fired.current) {
        // The hold already did something; this is the click the browser sends
        // afterwards, and acting on it would also toggle the selection.
        fired.current = false;
        e.preventDefault();
        return;
      }
      tapRef.current();
    },

    // A hold on a touch screen otherwise raises the platform's own menu on top of
    // ours; on desktop it would open the right-click menu on a normal press-and-hold.
    onContextMenu: (e) => e.preventDefault(),
  };
}

export default useLongPress;
