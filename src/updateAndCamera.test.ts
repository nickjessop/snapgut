// Batch A plumbing: the build id, the deferred update reload, and the shared
// camera stream.
//
// The update guard is the one worth the most care. `autoUpdate` reloads the page
// the instant a new worker takes control, and a captured photo is an in-memory
// Blob — so an update landing mid-capture destroys work the user cannot get back
// (Requirement 4.8: a load can never restore an Ephemeral_Flow). These tests pin
// that a reload waits, and — just as important — that it is not simply dropped.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_BUILD, APP_VERSION } from "./build";
import {
  registerCalls,
  resetPwaRegisterStub,
  updateCalls,
} from "./test/pwaRegisterStub";
import {
  registerServiceWorker,
  resetSwUpdateForTests,
  setSafeToReload,
  updatePending,
} from "./swUpdate";
import {
  acquireCamera,
  releaseCamera,
  resetCameraForTests,
  stopCamera,
} from "./cameraStream";

/** Invoke the `onNeedRefresh` the app handed to `registerSW`. */
function newWorkerReady(): void {
  const options = registerCalls[registerCalls.length - 1];
  if (!options?.onNeedRefresh) throw new Error("registerSW was called without onNeedRefresh");
  options.onNeedRefresh();
}

describe("the build id", () => {
  it("is substituted at build time rather than hand-written", () => {
    // `vitest.config.ts` defines a fixed value; a real build substitutes
    // `package.json`'s version plus a timestamp. Either way it is derived — the old
    // hand-typed "0.1.0" literal could not change and so said nothing.
    expect(APP_BUILD).toBe("0.0.0-test");
    expect(APP_BUILD).not.toBe("dev");
  });

  it("exposes the semver part on its own", () => {
    expect(APP_VERSION).toBe("0.0.0-test".split("+")[0]);
  });
});

describe("deferring a service worker update", () => {
  beforeEach(() => {
    // Order matters: clear the module's own state before re-registering, or a case
    // that ended with an update pending hands it to this one.
    resetSwUpdateForTests();
    resetPwaRegisterStub();
    registerServiceWorker();
  });

  it("registers immediately", () => {
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].immediate).toBe(true);
  });

  it("reloads straight away when nothing is unsaved", () => {
    newWorkerReady();

    // The behaviour that was already there and must be kept: an update the user
    // never has to think about. No toast, no approval.
    expect(updateCalls).toEqual([true]);
    expect(updatePending()).toBe(false);
  });

  it("holds the reload while unsaved work is open", () => {
    setSafeToReload(false);
    newWorkerReady();

    // The photo is still in memory, so the page must not go anywhere.
    expect(updateCalls).toEqual([]);
    expect(updatePending()).toBe(true);
  });

  it("applies the held reload as soon as it is safe again", () => {
    setSafeToReload(false);
    newWorkerReady();
    expect(updateCalls).toEqual([]);

    setSafeToReload(true);

    // Deferred, not discarded — the distinction that matters. Dropping it would
    // strand the user on an old build until they happened to relaunch.
    expect(updateCalls).toEqual([true]);
    expect(updatePending()).toBe(false);
  });

  it("reloads once, however many times safety is re-asserted", () => {
    setSafeToReload(false);
    newWorkerReady();
    setSafeToReload(true);
    setSafeToReload(true);
    setSafeToReload(false);
    setSafeToReload(true);

    expect(updateCalls).toEqual([true]);
  });

  it("does nothing when no update is waiting", () => {
    setSafeToReload(false);
    setSafeToReload(true);

    expect(updateCalls).toEqual([]);
  });
});

describe("the shared camera stream", () => {
  /** A stand-in for a live device. */
  function fakeStream(readyState: MediaStreamTrack["readyState"] = "live") {
    const track = { readyState, stop: vi.fn() } as unknown as MediaStreamTrack;
    return {
      getTracks: () => [track],
      getVideoTracks: () => [track],
      __track: track,
    } as unknown as MediaStream & { __track: MediaStreamTrack };
  }

  beforeEach(() => {
    resetCameraForTests();
    vi.useRealTimers();
  });

  it("acquires the device once for two consumers", async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const a = await acquireCamera();
    const b = await acquireCamera();

    // The whole point: a tab switch away and back must not re-request the camera,
    // which is what makes it slow to open and, on some platforms, re-prompt.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    vi.unstubAllGlobals();
  });

  it("keeps the stream alive after the last consumer lets go", async () => {
    const stream = fakeStream();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });

    await acquireCamera();
    releaseCamera();

    // Held for the grace period rather than stopped, so coming right back is
    // instant. `stopCamera` is what actually ends it.
    expect(stream.__track.stop).not.toHaveBeenCalled();
    stopCamera();
    expect(stream.__track.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("re-acquires when the previous tracks have died", async () => {
    const dead = fakeStream("ended");
    const live = fakeStream("live");
    const getUserMedia = vi.fn().mockResolvedValueOnce(dead).mockResolvedValueOnce(live);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await acquireCamera();
    releaseCamera();
    const second = await acquireCamera();

    // Reusing a dead stream shows a frozen frame, which is worse than a short wait.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(second).toBe(live);
    vi.unstubAllGlobals();
  });

  it("rejects rather than throwing where the API is absent", async () => {
    vi.stubGlobal("navigator", {});

    // An insecure origin, an embedded view, or a test environment. The caller
    // handles a rejection; a synchronous throw from inside an async function would
    // land in a different place and at a different time.
    await expect(acquireCamera()).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("leaves the consumer count balanced after a failure", async () => {
    vi.stubGlobal("navigator", {});
    await expect(acquireCamera()).rejects.toThrow();
    vi.unstubAllGlobals();

    // The regression this guards: a failed acquire used to leave the count raised,
    // so the module never again believed the camera was idle and the release timer
    // stopped firing for the life of the page.
    const stream = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await acquireCamera();
    releaseCamera();
    stopCamera();
    expect(stream.__track.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
