// @vitest-environment node
//
// Property: the Service_Worker's path sets keep the Navigation_Fallback resolvable
// and confine the denylist to the non-navigation surface.
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.6, 5.8
//
// Node environment on purpose: this asserts against the build-time configuration
// in `vite/pwa.js`, which touches no DOM.
//
// **What this file used to be.** It was "Property 4: every marketing path is
// excluded from navigation fallback" — a property over the Marketing_Page set,
// checking that each page's path was denied so the worker never answered the
// landing page from the precached App_Shell. With the marketing site gone that set
// is empty and every clause over it is vacuously true, so those clauses are gone
// rather than left to pass without saying anything.
//
// **Why the file survives.** Three things it established are not about marketing
// and are load-bearing for the offline story, which now includes `/`:
//
//   1. The pairing that makes the Navigation_Fallback work at all — the App_Shell
//      is matched by no `globIgnores` pattern (so it *is* precached) and by no
//      denylist entry (so the fallback is reachable). An over-broad ignore would
//      silently leave the worker with nothing to answer an offline navigation
//      with, which is not a failure any single assertion elsewhere catches.
//   2. The denylist is not a blanket: every entry is anchored, and none of them
//      match a navigable path. A `/^\/api/` that had lost its trailing slash, or
//      an unanchored pattern, would deny `/app/logs` too and take the whole app
//      offline story with it.
//   3. `globIgnores` uses only the glob syntax this file can match, so the
//      matcher below cannot quietly disagree with workbox-build.
//
// Matching follows Workbox's own rules so a pass here means a pass in the build
// and in the worker:
//
//   - `navigateFallbackDenylist` is tested by `NavigationRoute._match` against
//     `url.pathname + url.search` (workbox-routing/NavigationRoute.js); a first
//     match means the Navigation_Request is left to the network instead of being
//     answered with the precached App_Shell.
//   - `globIgnores` is passed to `glob` by workbox-build, which matches each
//     pattern against the Build_Output-relative path with minimatch semantics.
//     `globMatch` below reimplements the subset of those semantics the patterns
//     actually use, and `SUPPORTED_GLOB_SYNTAX` fails the run if a pattern ever
//     reaches for a feature it does not cover.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  APP_SHELL_DOCUMENT,
  NAVIGATE_FALLBACK,
  navigateFallbackDenylist,
  precacheIgnores,
  // @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
} from "../vite/pwa.js";
import { APP_VIEWS, LOGIN_PATH, NOT_FOUND_FILE, ROOT_PATH } from "../shared/site.js";

/** The configuration as the build hands it to Workbox. */
const DENYLIST: readonly RegExp[] = navigateFallbackDenylist();
const IGNORES: readonly string[] = precacheIgnores();

/**
 * Workbox's matcher, narrowed to what it does with a denylist: the first pattern
 * that matches `pathname + search` wins and the request skips the fallback.
 */
const denyingPatterns = (pathnameAndSearch: string): RegExp[] =>
  DENYLIST.filter((pattern) => pattern.test(pathnameAndSearch));

// --- Glob matching ----------------------------------------------------------

/**
 * The glob features `globMatch` implements: literal characters, `*` and `?`
 * within a segment, and a whole-segment `**`. Braces, extglobs, character
 * classes, and negation are not covered, so a pattern using one is rejected by
 * the guard below rather than silently mismatched.
 */
const SUPPORTED_GLOB_SYNTAX = /^[A-Za-z0-9._*?/-]+$/;

const escapeRe = (value: string) => value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** One path segment of a pattern as an anchored regular expression. */
const segmentRe = (segment: string) =>
  new RegExp(
    `^${segment
      .split("")
      .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : escapeRe(c)))
      .join("")}$`
  );

/**
 * minimatch semantics for the supported subset, against a Build_Output-relative
 * path. A `**` segment spans zero or more path segments, except as the final
 * segment where it requires at least one — which is why `foods/**` does not
 * match a file literally named `foods`, and why `**\/foods\/**` still matches
 * `foods/apple.webp`.
 */
function globMatch(path: string, pattern: string): boolean {
  const parts = path.split("/");
  const globs = pattern.split("/");

  const walk = (i: number, j: number): boolean => {
    if (j === globs.length) return i === parts.length;
    if (globs[j] === "**") {
      const least = j === globs.length - 1 ? 1 : 0;
      for (let k = i + least; k <= parts.length; k++) if (walk(k, j + 1)) return true;
      return false;
    }
    if (i >= parts.length) return false;
    return segmentRe(globs[j]).test(parts[i]) && walk(i + 1, j + 1);
  };

  return walk(0, 0);
}

/** The `globIgnores` entries that keep a Build_Output file out of the precache. */
const ignoringPatterns = (outputPath: string): string[] =>
  IGNORES.filter((pattern) => globMatch(outputPath, pattern));

// --- Generators -------------------------------------------------------------

/**
 * Every path a Navigation_Request can carry that the Origin_Server answers with
 * the App_Shell: the origin root, the Login_Route, the Route_Table's views, and
 * the deep links under the app prefix that the client router owns. All of them
 * must reach the fallback, offline included.
 */
const arbNavigablePath: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      ROOT_PATH,
      LOGIN_PATH,
      ...(APP_VIEWS as readonly { path: string }[]).map((v) => v.path)
    ),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "/app/",
      "/app/logs?filter=today",
      "/app/unknown/deep/link",
      "/login?next=%2Fapp%2Flogs",
      "/?utm_source=x"
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.constantFrom("logs", "insights", "settings", "x", "2026-01-01"), {
        minLength: 1,
        maxLength: 3,
      })
      .map((segments) => `/app/${segments.join("/")}`),
  }
);

/**
 * The surface the denylist exists for: paths that are not navigations, or where
 * a substituted HTML body would be the wrong kind of answer.
 */
const arbDeniedPath: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      "/api/health",
      "/api/me",
      "/api/auth/request",
      "/foods/apple.webp",
      "/foods/nested/pear.webp",
      "/robots.txt"
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.stringMatching(/^[a-z0-9-]{1,8}$/), { minLength: 1, maxLength: 3 })
      .map((segments) => `/api/${segments.join("/")}`),
  }
);

// --- The property -----------------------------------------------------------

describe("the Service_Worker path sets keep the app answerable offline", () => {
  it("leaves the App_Shell precached, so the Navigation_Fallback resolves", () => {
    // An ignore pattern broad enough to catch `app/index.html` would drop the
    // fallback document itself, and Workbox would have nothing to answer an
    // offline navigation with.
    expect(ignoringPatterns(APP_SHELL_DOCUMENT)).toEqual([]);
    expect(NAVIGATE_FALLBACK).toBe(`/${APP_SHELL_DOCUMENT}`);
  });

  it("leaves the Navigation_Fallback document reachable, so the denylist is not a blanket", () => {
    expect(denyingPatterns(NAVIGATE_FALLBACK)).toEqual([]);
  });

  it("denies no path the Origin_Server answers with the App_Shell", () => {
    // The clause that replaces the old marketing one, and the reason `/` works
    // offline now: a Navigation_Request for the app must reach the fallback.
    fc.assert(
      fc.property(arbNavigablePath, (path) => {
        expect(
          denyingPatterns(path),
          `${JSON.stringify(path)} is answered with the App_Shell but the worker denies the fallback for it`
        ).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });

  it("denies every path that is not a navigation the App_Shell can answer", () => {
    fc.assert(
      fc.property(arbDeniedPath, (path) => {
        expect(
          denyingPatterns(path).length,
          `${JSON.stringify(path)} would be answered with the App_Shell`
        ).toBeGreaterThan(0);
      }),
      { numRuns: 300 }
    );
  });

  it("anchors every denylist entry at the start of the path", () => {
    // An unanchored `/api\//` would match `/app/api/x`, and worse, a pattern like
    // `/robots\.txt/` without the `^` would match `/app/robots.txt`.
    for (const pattern of DENYLIST) {
      expect(pattern.source.startsWith("^\\/"), `${pattern} is not anchored`).toBe(true);
      expect(pattern.flags, `${pattern} carries flags`).toBe("");
    }
  });

  it("keeps the not-found document out of the Precache_Manifest", () => {
    // Its status is the whole response. Precached, the worker would answer a typo
    // with the 404 body and status 200 — the soft 404 Requirement 2.5 removes.
    expect(ignoringPatterns(NOT_FOUND_FILE as string).length).toBeGreaterThan(0);
  });

  it("keeps the food pack out of the Precache_Manifest (R5.6)", () => {
    for (const file of ["foods/apple.webp", "foods/nested/pear.webp"]) {
      expect(ignoringPatterns(file).length, `${file} would be precached`).toBeGreaterThan(0);
    }
    // Non-vacuity: the pattern is about the directory, not about `.webp`.
    expect(ignoringPatterns("app-icon-384.webp")).toEqual([]);
  });

  it("uses only the glob syntax this test can match, so globIgnores cannot drift", () => {
    // Guard on the matcher, not on the configuration: if a future ignore pattern
    // uses braces or an extglob, `globMatch` would quietly disagree with
    // workbox-build. Failing here forces the matcher to be extended instead.
    for (const pattern of IGNORES) {
      expect(pattern, `unsupported glob syntax in globIgnores: ${pattern}`).toMatch(
        SUPPORTED_GLOB_SYNTAX
      );
    }
  });
});
