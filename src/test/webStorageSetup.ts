// Repairs `globalThis.localStorage` under Node >= 22, which is otherwise broken
// for the whole suite.
//
// Node 22.4 added the Web Storage API and exposes `localStorage` as a global.
// Unlike `sessionStorage`, which is in-memory, `localStorage` is file-backed and
// needs `--localstorage-file=<path>`. Without it Node still installs the global,
// but as a stub: `typeof localStorage === "object"` while every method is
// `undefined`, plus a "`--localstorage-file` was provided without a valid path"
// warning on first touch.
//
// That stub wins over the one vitest's jsdom environment would install — the
// probe below shows `globalThis.localStorage === window.localStorage` and both
// broken — so 173 tests across 19 files fail with `localStorage.clear is not a
// function` on any Node the project actually supports. The suite passed only
// because it was being run on Node 20, below the `engines.node: ">=24"` floor,
// where no such global exists.
//
// Why a real jsdom `Storage` rather than a Map-backed shim: `SettingsView.tsx`
// sweeps keys with `Object.keys(localStorage)` and `syncSettings.persistence`
// walks them with `localStorage.key(i)`. Both rely on `Storage`'s exotic
// behaviour, where stored keys are also own enumerable properties. A plain
// object or Map does not reproduce that, so the shim would quietly diverge from
// the browser in exactly the code paths these tests exist to cover.
//
// Why not `--no-experimental-webstorage`: it works, but it is a flag name that
// has already moved once (Node 25 lists the option as `--webstorage`, keeping
// `--no-experimental-webstorage` only as a negation alias). Node exits on an
// unknown flag, so pinning CI to that spelling makes the whole suite fail closed
// on some future major. This repair is version-agnostic and self-limiting: it
// only acts on a global that is already broken.

import { JSDOM } from "jsdom";

/** True when a Web Storage global is present but unusable, as on Node >= 22 without a store file. */
function isBrokenStorage(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== "object") return false;
  return typeof (candidate as Storage).clear !== "function";
}

const existing = (globalThis as { localStorage?: unknown }).localStorage;

if (isBrokenStorage(existing)) {
  // A fresh window per setup run, and setup runs once per test file, so each
  // file gets its own store — the isolation the suite already assumes. An
  // explicit origin is required: jsdom refuses localStorage on an opaque origin.
  const { window } = new JSDOM("", { url: "http://localhost/" });

  // `Storage` has to travel with the instances. The replacement stores come from
  // a second jsdom realm, so their prototype is that realm's `Storage.prototype`
  // and not the ambient global's. `syncSettings.persistence.test.ts` simulates
  // quota errors and blocked reads with `vi.spyOn(Storage.prototype, "setItem")`,
  // which patches whatever `Storage` resolves to at the call site — leave the
  // global pointing at the old class and the spy patches a prototype these
  // objects do not inherit from, so it silently never fires. Publishing the
  // matching constructor keeps prototype-level stubbing working.
  const replacements = {
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Storage: window.Storage,
  } as const;

  // Under the jsdom environment `globalThis` is the window, so these are usually
  // the same target; assigning both is what makes the repair correct in either
  // case, and harmless when they coincide.
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
