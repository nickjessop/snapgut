// Guarantees a working `localStorage` / `sessionStorage` for the test suite,
// whatever the host Node does with Web Storage.
//
// Node's behaviour here has changed twice and is still experimental, and vitest's
// jsdom environment does not install its own storage over the top, so the suite
// inherits whatever Node leaves behind:
//
//   Node 20        no global at all; jsdom's Storage is used and works.
//   Node 22 - 25   a `localStorage` global exists but is a stub — `typeof` is
//                  "object" while every method is undefined — because it is
//                  file-backed and `--localstorage-file` was not passed. It also
//                  shadows jsdom's, so `globalThis.localStorage ===
//                  window.localStorage` and both are unusable.
//   Node 26        the global is omitted entirely and Node warns instead
//                  ("localStorage is not available because --localstorage-file
//                  was not provided"), leaving `undefined`.
//
// Untreated, Node 22 - 25 fails 173 tests across 19 files with
// "localStorage.clear is not a function", and Node 26 fails with "Cannot read
// properties of undefined". Neither shows up on Node 20, which is why this went
// unnoticed: the suite was being run below its own `engines.node` floor of >=24.
//
// So the test is capability, not version, and not a guess at which breakage is in
// play: probe the ambient storage by round-tripping a value, and substitute one
// only when that fails. A host that gives us a working Storage is left untouched.

import { JSDOM } from "jsdom";

const PROBE_KEY = "__snapgut_web_storage_probe__";

/**
 * Whether a value behaves like a usable `Storage`, established by writing and
 * reading a key back rather than by inspecting types. Node 22-25 ship an object
 * that passes a `typeof` check and fails on first use, so only a round trip
 * distinguishes the cases.
 */
function isUsableStorage(candidate: unknown): candidate is Storage {
  if (candidate === null || typeof candidate !== "object") return false;
  const storage = candidate as Storage;
  for (const method of ["setItem", "getItem", "removeItem", "clear", "key"] as const) {
    if (typeof storage[method] !== "function") return false;
  }
  try {
    storage.setItem(PROBE_KEY, "1");
    const readBack = storage.getItem(PROBE_KEY) === "1";
    storage.removeItem(PROBE_KEY);
    return readBack;
  } catch {
    return false;
  }
}

const ambient = (globalThis as { localStorage?: unknown }).localStorage;

if (!isUsableStorage(ambient)) {
  // A fresh window per setup run, and setup runs once per test file, so each file
  // gets its own store — the isolation the suite already assumes. An explicit
  // origin is required: jsdom refuses storage on an opaque origin.
  const { window } = new JSDOM("", { url: "http://localhost/" });

  // Validate the replacement before installing it. An earlier version of this
  // file assigned `window.localStorage` unchecked, and on a host where that was
  // absent it installed `undefined` — turning a diagnosable failure into
  // "Cannot read properties of undefined" a hundred frames away. Fail here, with
  // the reason, instead.
  if (!isUsableStorage(window.localStorage)) {
    throw new Error(
      "webStorageSetup: no usable Web Storage. The host provides none and jsdom " +
        `did not supply one either (jsdom localStorage was ${typeof window.localStorage}). ` +
        "The suite needs a working localStorage; check the jsdom version against this Node."
    );
  }

  // `Storage` has to travel with the instances. The replacements come from a
  // second jsdom realm, so their prototype is that realm's `Storage.prototype`
  // and not the ambient global's. `syncSettings.persistence.test.ts` simulates
  // quota errors and blocked reads with `vi.spyOn(Storage.prototype, "setItem")`,
  // which patches whatever `Storage` resolves to at the call site — leave the
  // global pointing at the old class and the spy patches a prototype these
  // objects do not inherit from, so it silently never fires.
  const replacements: Record<string, unknown> = {
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Storage: window.Storage,
  };

  // Under the jsdom environment `globalThis` is the window, so these are usually
  // the same target. Assigning both is what makes the repair correct when they
  // are not, and harmless when they coincide.
  const targets: object[] = [globalThis];
  const ambientWindow = (globalThis as { window?: unknown }).window;
  if (typeof ambientWindow === "object" && ambientWindow !== null && ambientWindow !== globalThis) {
    targets.push(ambientWindow);
  }

  for (const target of targets) {
    for (const [name, value] of Object.entries(replacements)) {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    }
  }
}
