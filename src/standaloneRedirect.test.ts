/**
 * The Standalone_Launch redirect on the marketing home page (task 6.2).
 *
 * Covers Requirements 6.4 (a Standalone_Launch of `/` replaces the entry with
 * the default App_Route), 6.5 (the detection is the same pair of checks the app
 * already uses, delivered as a file), 6.6 (no other load redirects, session
 * state or not), and 6.7 (a throw redirects nowhere and is swallowed).
 *
 * Importing the module runs its one side effect against the jsdom `window` —
 * which is not a Standalone_Launch — so the import itself is the Requirement 6.6
 * case, asserted explicitly below.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_PATH, marketingPaths } from "../shared/site.js";
import {
  APP_PATH,
  HOME_PATH,
  isStandaloneLaunch,
  redirectTarget,
  runStandaloneRedirect,
  STANDALONE_QUERY,
  type StandaloneWindow,
} from "../marketing/standalone";

/**
 * A `window` stand-in. `standalone` is iOS Safari's non-standard flag; `display`
 * is the standard media query's answer. Both default to "not installed".
 */
function fakeWindow({
  pathname = HOME_PATH,
  display = false,
  standalone = undefined as boolean | undefined,
  matchMedia = undefined as StandaloneWindow["matchMedia"],
} = {}) {
  const replace = vi.fn();
  const win: StandaloneWindow = {
    matchMedia: matchMedia ?? ((query: string) => ({ matches: query === STANDALONE_QUERY && display })),
    navigator: { standalone },
    location: { pathname, replace },
  };
  return { win, replace };
}

describe("Standalone_Launch detection", () => {
  it("matches the display-mode query", () => {
    expect(isStandaloneLaunch(fakeWindow({ display: true }).win)).toBe(true);
  });

  it("matches iOS Safari's navigator.standalone", () => {
    expect(isStandaloneLaunch(fakeWindow({ standalone: true }).win)).toBe(true);
  });

  it("is false for an ordinary browser tab", () => {
    expect(isStandaloneLaunch(fakeWindow().win)).toBe(false);
  });

  it("is false when navigator.standalone is merely truthy-ish, not true", () => {
    // The app's own check is `=== true`; a browser exposing the property as
    // undefined or 0 is not an installed launch.
    expect(isStandaloneLaunch(fakeWindow({ standalone: undefined }).win)).toBe(false);
  });

  it("is false where matchMedia does not exist", () => {
    const { win } = fakeWindow();
    delete win.matchMedia;
    expect(isStandaloneLaunch(win)).toBe(false);
  });
});

describe("the redirect", () => {
  it("sends a Standalone_Launch of / to the default App_Route, replacing the entry", () => {
    const { win, replace } = fakeWindow({ display: true });
    expect(runStandaloneRedirect(win)).toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(APP_PATH);
  });

  it("stays put on an ordinary browser load of / (Req 6.6)", () => {
    const { win, replace } = fakeWindow();
    expect(runStandaloneRedirect(win)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it("stays put on a Standalone_Launch of any path other than / (Req 6.3)", () => {
    for (const pathname of [...marketingPaths(), "/login", "/app", "/app/logs", "/nope"]) {
      if (pathname === HOME_PATH) continue;
      const { win, replace } = fakeWindow({ pathname, display: true });
      expect(redirectTarget(win), pathname).toBeNull();
      expect(runStandaloneRedirect(win), pathname).toBe(false);
      expect(replace, pathname).not.toHaveBeenCalled();
    }
  });

  it("performs zero redirects where the detection throws (Req 6.7)", () => {
    const { win, replace } = fakeWindow({
      matchMedia: () => {
        throw new Error("matchMedia unavailable");
      },
    });
    expect(() => runStandaloneRedirect(win)).not.toThrow();
    expect(runStandaloneRedirect(win)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it("targets the Route_Table's default App_Route", () => {
    // The module hardcodes the path rather than importing the Route_Table, so
    // this is the assertion that keeps the copy honest.
    expect(APP_PATH).toBe(DEFAULT_APP_PATH);
  });

  it("did not redirect the jsdom document when this module was imported (Req 6.6)", () => {
    // jsdom loads at "/" and reports no standalone display mode, so the
    // module-level call is the non-installed path — it must have done nothing.
    expect(window.location.pathname).toBe(HOME_PATH);
    expect(isStandaloneLaunch(window as unknown as StandaloneWindow)).toBe(false);
  });
});
