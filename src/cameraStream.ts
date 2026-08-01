/**
 * One camera stream, shared across mounts of `CameraView`.
 *
 * `CameraView` used to call `getUserMedia` on every mount and stop every track on
 * unmount, so camera → logs → camera re-acquired the device each time. That is what
 * makes the camera feel slow to open, flickers the hardware indicator, and — on the
 * platforms that scope permission to a grant rather than to an origin — re-prompts.
 *
 * **What this cannot fix.** A first-use prompt per app launch is the platform's
 * decision, not ours; an installed iOS PWA in particular may ask once per launch
 * however the stream is managed. What is removable is every *subsequent*
 * acquisition within a session, which is what this module does.
 *
 * The stream is held after the last consumer detaches, so a quick tab switch reuses
 * it, and released after a grace period or as soon as the page is hidden — so
 * wandering off does not leave the camera live. Keeping it open indefinitely would
 * be faster still and is deliberately not done: an app that holds the camera while
 * the user reads their log has earned the indicator light, and that is not a trade
 * worth making silently.
 */

/** How long the stream is kept after the last consumer lets go. */
const GRACE_MS = 60_000;

let stream: MediaStream | null = null;
/** In-flight acquisition, so two mounts in one tick share one request. */
let pending: Promise<MediaStream> | null = null;
let consumers = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

const CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: "environment" } },
  audio: false,
};

/** True while every track is still usable; a device change can kill them. */
function isLive(s: MediaStream | null): s is MediaStream {
  return !!s && s.getVideoTracks().some((t) => t.readyState === "live");
}

function cancelRelease(): void {
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
}

/** Stop the device now, whoever is holding it. */
export function stopCamera(): void {
  cancelRelease();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  pending = null;
}

/**
 * Borrow the shared stream, acquiring it only if there is not already a live one.
 * Every caller must eventually call `releaseCamera`.
 *
 * On failure the consumer count is put back before the error propagates. Leaving it
 * raised would be a slow leak with a confusing symptom: the count never returns to
 * zero, so `releaseCamera` stops believing the camera is idle and the release timer
 * never fires again for the life of the page.
 */
export async function acquireCamera(): Promise<MediaStream> {
  cancelRelease();
  consumers += 1;

  try {
    if (isLive(stream)) return stream;
    // A dead stream is worse than none: reusing it shows a frozen frame.
    if (stream) stopCamera();

    // Absent wherever the API is unavailable — an insecure origin, an embedded
    // view, a test environment. Checked rather than assumed, so the failure is a
    // rejected promise the caller already handles instead of a synchronous throw
    // from the middle of this function.
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) throw new Error("camera_unavailable");

    if (!pending) {
      pending = media.getUserMedia(CONSTRAINTS).then(
        (s) => {
          stream = s;
          pending = null;
          return s;
        },
        (err) => {
          pending = null;
          throw err;
        }
      );
    }
    return await pending;
  } catch (err) {
    consumers = Math.max(0, consumers - 1);
    throw err;
  }
}

/**
 * Let go. The device is kept for `GRACE_MS` in case the view is coming straight
 * back, then stopped — so a tab switch is instant and leaving is not indefinite.
 */
export function releaseCamera(): void {
  consumers = Math.max(0, consumers - 1);
  if (consumers > 0) return;
  cancelRelease();
  // Nothing acquired, nothing to schedule. Arming a minute-long timer to stop a
  // camera that was never running leaves a pending task behind for no reason —
  // which in a test environment outlives the test that created it.
  if (!stream && !pending) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (consumers === 0) stopCamera();
  }, GRACE_MS);
}

/**
 * Drop all shared state. For tests, which would otherwise carry one case's camera
 * state into the next — the module is a singleton by design, and a singleton needs
 * a way to be reset or every test after the first inherits the last one's device.
 */
export function resetCameraForTests(): void {
  cancelRelease();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  pending = null;
  consumers = 0;
}

/**
 * Release immediately when the page is hidden. Backgrounding is an unambiguous
 * signal that the camera is not in use, and some platforms suspend the track
 * anyway — reacquiring on return is both more correct and less surprising than
 * restoring a stream the OS already tore down.
 */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && consumers === 0) stopCamera();
  });
  // `pagehide` fires where `visibilitychange` does not, notably on iOS.
  window.addEventListener("pagehide", () => {
    if (consumers === 0) stopCamera();
  });
}
