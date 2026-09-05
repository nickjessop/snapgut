import { describe, it, expect, afterEach } from "vitest";
import { startAppHeightSync } from "./appHeight";

/**
 * The frame's height has been wrong on an installed iOS app three separate times, each
 * time because a CSS unit resolved against a viewport that was not the web view. These
 * cover the parts of the replacement that are checkable off-device: that a value is
 * written at all, that it tracks resizes, that it never writes a zero, and that
 * teardown stops it. Whether `window.innerHeight` is the *right* number in iOS
 * standalone cannot be asserted here — jsdom has no safe areas.
 */

let stop: (() => void) | undefined;

function setHeight(h: number) {
  (window as unknown as { innerHeight: number }).innerHeight = h;
  window.dispatchEvent(new Event("resize"));
}

function read() {
  return document.documentElement.style.getPropertyValue("--app-height");
}

/** The sync coalesces into a frame, so reads have to wait for one. */
function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r(null)));
}

afterEach(() => {
  stop?.();
  stop = undefined;
  document.documentElement.style.removeProperty("--app-height");
});

describe("app height sync", () => {
  it("writes the measured height before anything renders", () => {
    setHeight(844);
    // Not via the event — the point is that the first value is set synchronously by
    // the call itself, so the frame is never laid out short and then corrected.
    document.documentElement.style.removeProperty("--app-height");
    stop = startAppHeightSync();
    expect(read()).toBe("844px");
  });

  it("follows a resize", async () => {
    setHeight(844);
    stop = startAppHeightSync();
    setHeight(700);
    await nextFrame();
    expect(read()).toBe("700px");
  });

  it("ignores a zero rather than blanking the app", async () => {
    setHeight(844);
    stop = startAppHeightSync();
    setHeight(0);
    await nextFrame();
    expect(read()).toBe("844px");
  });

  it("stops writing once torn down", async () => {
    setHeight(844);
    const teardown = startAppHeightSync();
    teardown();
    setHeight(500);
    await nextFrame();
    expect(read()).toBe("844px");
  });
});
