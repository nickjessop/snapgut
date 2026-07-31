// @vitest-environment node
//
// Feature: marketing-site-and-routing, Property 4: Every marketing path is
// excluded from navigation fallback.
//
// Node environment on purpose: this asserts against the build-time
// configuration in vite/pwa.js, which touches no DOM.
//
// The values under test are the ones vite.config.ts passes to Workbox, imported
// from the same module rather than restated here — that is why vite/pwa.js
// exports them (Requirement 5.8). Restating the denylist in the test would let
// the config and the assertion drift apart, which is the exact failure this
// property exists to catch.
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
//     reaches for a feature it does not cover, so the reimplementation cannot
//     quietly disagree with the build.
//
// Three clauses over the generated Marketing_Page set, plus the two non-vacuity
// guards that keep them from being satisfied trivially:
//
// 1. Every Marketing_Page path in the Route_Table — and the trailing-slash form
//    of it, which the Origin_Server answers with a 301 the worker must not
//    intercept — is matched by at least one denylist entry (Requirement 5.2).
//    Adding a page to the Route_Table without the denylist deriving from it
//    fails here rather than silently shipping a homepage the Service_Worker
//    hijacks (Requirement 5.8).
// 2. Every Marketing_Site document is matched by at least one `globIgnores`
//    pattern, so no Marketing_Page can enter the Precache_Manifest
//    (Requirement 5.3).
// 3. The App_Shell document is matched by no `globIgnores` pattern, so it stays
//    in the Precache_Manifest. Clauses 2 and 3 are one pairing, not two facts:
//    the fallback is only resolvable because the document it names is precached
//    while the marketing documents are not.
//
// Three further clauses take Requirement 5.8's generality seriously: the real
// denylist entries are checked against the build's derivation formula rather than
// against four literals, that formula is then applied to generated hypothetical
// Route_Table paths to show it denies whatever a fifth entry could hold, and
// today's patterns are shown not to match a path outside the Route_Table — so
// "the page is denied" says something about the table having been read.
//
// Note on a case this property does not reach: because Workbox matches
// pathname + search, a request form carrying a query string (`/?utm_source=x`)
// is a different string from the path itself. The property is stated over the
// paths in `marketingPaths()`, so that form is out of its scope.
//
// Validates: Requirements 5.2, 5.8

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  APP_SHELL_DOCUMENT,
  NAVIGATE_FALLBACK,
  marketingDocumentGlobs,
  marketingPathPatterns,
  navigateFallbackDenylist,
  precacheIgnores,
  // @ts-expect-error -- untyped ESM JavaScript (vite/ is plain JS, like server/ and shared/)
} from "../vite/pwa.js";
import { isMarketingPath, marketingPaths } from "../shared/site.js";

/** The configuration as the build hands it to Workbox. */
const DENYLIST: readonly RegExp[] = navigateFallbackDenylist();
const PATH_PATTERNS: readonly RegExp[] = marketingPathPatterns();
const IGNORES: readonly string[] = precacheIgnores();
const MARKETING_DOCUMENTS: readonly string[] = marketingDocumentGlobs();

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
 * `foods/apple.webp`. Cross-checked against minimatch 10 for the patterns in
 * `precacheIgnores()` and for the App_Shell and marketing document paths.
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

/** Exactly the Marketing_Page paths, in Route_Table order. */
const arbMarketingPath: fc.Arbitrary<string> = fc.constantFrom(...marketingPaths());

/**
 * The request forms of one Route_Table path that resolve to that same page. The
 * trailing-slash form is included because a Navigation_Request for `/pricing/`
 * inside a controlled client has to reach the Origin_Server's 301; answering it
 * from precache would strand the user on the App_Shell.
 */
const requestForms = (path: string): string[] =>
  path === "/" ? [path] : [path, `${path}/`];

/** A Marketing_Page path in any of the request forms that resolve to it. */
const arbMarketingRequestForm: fc.Arbitrary<string> = arbMarketingPath.chain((path) =>
  fc.constantFrom(...requestForms(path))
);

/** Every document the Marketing_Site emits, as a Build_Output-relative path. */
const arbMarketingDocument: fc.Arbitrary<string> = fc.constantFrom(...MARKETING_DOCUMENTS);

/**
 * The build's own derivation, restated once so it can be applied to a path the
 * Route_Table does not contain: a Route_Table path escaped for literal use, then
 * anchored, with the optional trailing slash every path but the home page gets
 * (`marketingPathPatterns` in `vite/pwa.js`). The clause that checks the real
 * patterns against this formula is what keeps the restatement honest — if the
 * build's derivation changes, that clause fails rather than this one drifting.
 *
 * Named apart from the glob `escapeRe` above: `*` and `?` are wildcards in a
 * glob and literals in a path, so the two escape sets are deliberately not the
 * same.
 */
const escapeRouteRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const derivedPattern = (path: string): RegExp =>
  new RegExp(`^${escapeRouteRe(path)}${path === "/" ? "" : "/?"}$`);

/**
 * Paths a fifth Route_Table entry could plausibly hold, including segments made
 * of the characters that are metacharacters in a regular expression — an
 * unescaped `.` or `+` in the derivation would show up here as a pattern that
 * matches more than its own page.
 */
const arbHypotheticalSegment: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      "blog",
      "faq",
      "about",
      "how-it-works",
      "for-clinicians",
      "changelog"
    ),
  },
  { weight: 2, arbitrary: fc.constantFrom("v1.2", "c++", "a(b)", "$plans", "q?", "*all", "a|b") },
  {
    weight: 1,
    arbitrary: fc
      .stringMatching(/^[a-z0-9._+-]{1,10}$/)
      .filter((segment) => segment.length > 0),
  }
);

/** A hypothetical Marketing_Page path: rooted, no trailing slash, no empty segment. */
const arbHypotheticalPath: fc.Arbitrary<string> = fc
  .array(arbHypotheticalSegment, { minLength: 1, maxLength: 3 })
  .map((segments) => `/${segments.join("/")}`);

/**
 * Candidate paths weighted toward the near misses a hand-written denylist gets
 * wrong: the Route_Table's own paths, casing and prefix variants, extra
 * segments, and doubled slashes. Free-form strings keep the space open. The
 * clause asserts only over the members that really are Marketing_Page paths —
 * the rest are there so a generator that stopped producing them would be
 * visible as a coverage failure, not as a silent pass.
 */
const arbCandidatePath: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: arbMarketingRequestForm },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      "/pricingx",
      "/PRICING",
      "/pricing/plans",
      "//pricing",
      "/privacy-policy",
      "/termsofservice",
      "/app",
      "/app/logs",
      "/login",
      "/api/foods",
      "/foods/apple.webp",
      "/robots.txt",
      "/sitemap.xml",
      "",
      "//"
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.constantFrom("pricing", "privacy", "terms", "app", "", "blog"), {
        maxLength: 3,
      })
      .map((segments) => `/${segments.join("/")}`),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 16 }) }
);

/**
 * True for the request forms clause 1 covers: a Marketing_Page path, bare or
 * with the trailing slash the Origin_Server redirects. `//` is deliberately not
 * one of them — its pathname is not the home page's, and the Origin_Server does
 * not serve the home document for it.
 */
const resolvesToMarketingPage = (path: string): boolean =>
  isMarketingPath(path) ||
  marketingPaths().some((page: string) => page !== "/" && path === `${page}/`);

// --- Property 4 -------------------------------------------------------------

describe("Property 4: Every marketing path is excluded from navigation fallback", () => {
  it("matches at least one denylist entry for every Marketing_Page request form", () => {
    fc.assert(
      fc.property(arbMarketingRequestForm, (path) => {
        const matched = denyingPatterns(path);
        expect(
          matched.length,
          `no navigateFallbackDenylist entry matches the Marketing_Page path ${JSON.stringify(
            path
          )}; the Service_Worker would answer it with the App_Shell`
        ).toBeGreaterThan(0);
      }),
      { numRuns: 200 }
    );
  });

  it("denies every generated path that resolves to a Marketing_Page", () => {
    fc.assert(
      fc.property(arbCandidatePath, (path) => {
        if (!resolvesToMarketingPage(path)) return;
        expect(
          denyingPatterns(path).length,
          `${JSON.stringify(path)} resolves to a Marketing_Page but is not denied`
        ).toBeGreaterThan(0);
      }),
      { numRuns: 300 }
    );
  });

  it("keeps every Marketing_Site document out of the Precache_Manifest", () => {
    // The other half of the pairing: denying the fallback only helps if the
    // worker has no precached copy of the page to answer with either
    // (Requirement 5.3).
    fc.assert(
      fc.property(arbMarketingDocument, (document) => {
        expect(
          ignoringPatterns(document).length,
          `no globIgnores pattern matches the Marketing_Site document ${JSON.stringify(
            document
          )}; it would be precached and served stale from cache`
        ).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it("leaves the App_Shell precached, so the Navigation_Fallback resolves", () => {
    // Non-vacuity for the clause above: an ignore pattern broad enough to catch
    // `app/index.html` would drop the fallback document itself, and Workbox
    // would have nothing to answer an offline App_Route with.
    expect(ignoringPatterns(APP_SHELL_DOCUMENT)).toEqual([]);
    expect(NAVIGATE_FALLBACK).toBe(`/${APP_SHELL_DOCUMENT}`);
  });

  it("leaves the Navigation_Fallback document reachable, so the denylist is not a blanket", () => {
    // Not a second property: this is what keeps the denylist clauses from being
    // satisfied by a pattern that denies everything.
    expect(denyingPatterns(NAVIGATE_FALLBACK)).toEqual([]);
    expect(denyingPatterns("/app")).toEqual([]);
  });

  it("derives one anchored denylist pattern per Route_Table entry", () => {
    // The derivation, not today's four values: `marketingPathPatterns()` is a
    // map over `marketingPaths()`, and every pattern it produces is in the
    // denylist. Together with the clause below this is what makes Requirement
    // 5.8 hold for a fifth page as much as for the four that exist — a page can
    // only fail to be denied if this map stops being driven by the Route_Table,
    // and then clause 1 fails.
    expect(PATH_PATTERNS).toHaveLength(marketingPaths().length);
    for (const [i, path] of marketingPaths().entries()) {
      expect(PATH_PATTERNS[i].source).toBe(derivedPattern(path).source);
      expect(DENYLIST.some((entry) => entry.source === PATH_PATTERNS[i].source)).toBe(true);
    }
  });

  it("denies any hypothetical Route_Table path the same derivation would cover", () => {
    // Requirement 5.8 asks for the derivation to hold generally. A hypothetical
    // entry cannot be pushed into `marketingPaths()` from here — the Route_Table
    // is static and the build reads the same module — so the argument runs the
    // other way: apply the build's own formula to a generated path and check the
    // pattern it yields denies that path, both request forms, and nothing
    // adjacent to it. With the clause above, that covers every path a future
    // entry could hold.
    fc.assert(
      fc.property(arbHypotheticalPath, (path) => {
        const pattern = derivedPattern(path);
        for (const form of requestForms(path)) expect(pattern.test(form)).toBe(true);
        for (const near of [`${path}x`, `${path}/deeper`, `/x${path}`, `${path}//`]) {
          expect(pattern.test(near), `${pattern} over-matches ${near}`).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("does not already match a path outside the Route_Table", () => {
    // Non-vacuity for the two clauses above: if a marketing pattern matched an
    // unrelated path, "the page is denied" would carry no information about the
    // Route_Table having been read at all.
    fc.assert(
      fc.property(arbHypotheticalPath, (path) => {
        if (resolvesToMarketingPage(path)) return;
        expect(
          PATH_PATTERNS.filter((pattern) => pattern.test(path)),
          `${JSON.stringify(path)} is not a Marketing_Page but a marketing pattern matches it`
        ).toEqual([]);
      }),
      { numRuns: 200 }
    );
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
