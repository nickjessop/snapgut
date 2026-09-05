// @vitest-environment node
//
// Feature: marketing-site-and-routing, Property 3: Route resolution is total and
// single-valued.
//
// **Validates: Requirements 2.5, 2.9**
//
// Node environment on purpose: `resolveRoute` is a pure function over a path and
// an injected Build_Output predicate, so nothing here touches a DOM or the
// filesystem.
//
// Two halves, and the second is the load-bearing one:
//
//   - **Total and single-valued.** Every string resolves to a well-formed
//     outcome whose `kind` is exactly one of the five `OUTCOME` values, with the
//     status and the fields that kind implies, and the same input resolves the
//     same way twice (Requirement 2.9).
//   - **App_Shell if and only if.** The shell is returned for exactly the
//     Login_Route and the App_Routes and for nothing else, which is what stops
//     Requirement 2.5's 404 from silently becoming today's soft-404 app shell.
//
// The oracle is derived from the requirement text and the Route_Table
// (`shared/site.js`), not from `server/routes.js`: `redirectTargetFor` is
// deliberately *not* imported for the expectation, and the redirect-eligible set
// is restated from Requirement 2.6 instead, so a change of mind in the resolver
// cannot drag the expectation along with it.
//
// One precedence note, because it is the single place the resolution order is
// observable rather than incidental: a Build_Output file that also sits under
// `/app` (`/app/index.html` is a real one) resolves to the App_Shell, not to the
// static outcome. The design's registration order says so, and the iff clause
// above demands it. Every other pair of outcome classes is disjoint, which the
// exclusivity clause asserts — that disjointness is what makes "exactly one
// outcome" a fact about the Route_Table rather than an artifact of handler order.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  APP_SHELL_FILE,
  OUTCOME,
  resolveRoute,
  // @ts-expect-error -- untyped ESM JavaScript (server/ is plain JS, like shared/ and vite/)
} from "../server/routes.js";
import {
  APP_VIEWS,
  LOGIN_PATH,
  NOT_FOUND_FILE,
  isAppPath,
  isMarketingPath,
  marketingPaths,
} from "../shared/site.js";

const ITERATIONS = 300;

type Outcome = {
  kind: string;
  status: number;
  file?: string;
  location?: string;
};

/** The five outcomes of the design's resolution table, and nothing else. */
const OUTCOME_KINDS: readonly string[] = Object.values(OUTCOME);

/** The status each outcome class carries, from the design's resolution table. */
const STATUS_FOR: Record<string, number> = {
  [OUTCOME.MARKETING]: 200,
  [OUTCOME.APP_SHELL]: 200,
  [OUTCOME.STATIC]: 200,
  [OUTCOME.REDIRECT]: 301,
  [OUTCOME.NOT_FOUND]: 404,
};

// --- The oracle, from the requirements and the Route_Table -------------------

/**
 * The App_Shell set: exactly the Login_Route and the App_Routes (Requirements
 * 2.3, 2.5). `isAppPath` comes from the Route_Table, so this is the same
 * definition the client router and the service-worker denylist use.
 */
const isShellPath = (p: string): boolean => p === LOGIN_PATH || isAppPath(p);

/**
 * Requirement 2.6, restated: a Marketing_Page path or the Login_Route carrying a
 * trailing slash, `/` excepted. An App_Route keeps its 200, and an unknown path
 * with a trailing slash takes the single 404 of Requirement 2.5 rather than a
 * 301 to another 404.
 */
function redirectEligible(p: string): boolean {
  if (p === "/" || !p.endsWith("/")) return false;
  const stripped = p.replace(/\/+$/, "");
  if (stripped === "") return false; // `//` names no page, so it takes the 404
  return isMarketingPath(stripped) || stripped === LOGIN_PATH;
}

const strippedTarget = (p: string): string => p.replace(/\/+$/, "");

/** The expected outcome kind for a path against a given Build_Output. */
function expectedKind(p: string, fileExists: (path: string) => boolean): string {
  if (redirectEligible(p)) return OUTCOME.REDIRECT;
  if (isMarketingPath(p)) return OUTCOME.MARKETING;
  if (isShellPath(p)) return OUTCOME.APP_SHELL;
  if (fileExists(p)) return OUTCOME.STATIC;
  return OUTCOME.NOT_FOUND;
}

// --- Build_Output generation -------------------------------------------------

/**
 * Files a real Build_Output holds, including two that overlap another outcome
 * class on purpose: `/index.html` (the home page's document, whose *path* is
 * `/`) and `/app/index.html` (a file that is also an App_Route).
 */
const DIST_FILES = [
  "/assets/index-a1b2c3.js",
  "/assets/marketing-9f8e7d.css",
  "/sw.js",
  "/manifest.webmanifest",
  "/robots.txt",
  "/sitemap.xml",
  "/index.html",
  "/404.html",
  "/app/index.html",
  "/foods/apple.webp",
  "/icons/icon-192.png",
];

/**
 * A Build_Output as a subset of those files, so the static/404 boundary is
 * generated rather than fixed — an empty dist exercises the 404 clause hard.
 */
const arbDist: fc.Arbitrary<ReadonlySet<string>> = fc
  .subarray(DIST_FILES)
  .map((files) => new Set(files));

// --- Path generation ---------------------------------------------------------

const APP_PATHS = APP_VIEWS.map((v) => v.path);

/** The paths the Route_Table itself names. */
const arbTablePath = fc.constantFrom(...marketingPaths(), LOGIN_PATH, ...APP_PATHS);

/**
 * Near misses: the shapes a prefix test, a case-insensitive compare, or a
 * loose trailing-slash rule gets wrong. Each one must resolve to something other
 * than the App_Shell unless it really is the Login_Route or an App_Route.
 */
const arbNearMiss = fc.constantFrom(
  "/application",
  "/app-store",
  "/applogs",
  "/apps",
  "/app.html",
  "/appliance/logs",
  "/APP",
  "/App",
  "/aPp/logs",
  "/Login",
  "/LOGIN",
  "/logins",
  "/login/x",
  "/login/logs",
  "/app",
  "/app/",
  "/app//",
  "/app///logs",
  "//app",
  "//app/logs",
  "/login/",
  "//login",
  "/%61pp",
  "/%61pp/logs",
  "/app%2Flogs",
  "/%2Fapp",
  "/%2f%2fapp",
  "/login%2F",
  "/login%20",
  "/app\\logs",
  "/\\app",
  "/pricing/",
  "/pricing//",
  "/pricing/plans",
  "/PRICING",
  "/privacy/",
  "/terms/",
  "//",
  "///",
  "/",
  "",
  "/api/auth/request",
  "/api/",
  "/blog/first-post",
  "/foods/apple.webp",
  "/.well-known/security.txt",
  "/index.html",
  "/app/index.html"
);

/** Paths assembled from segments that flirt with the Route_Table's own names. */
const arbAssembled = fc
  .array(
    fc.constantFrom(
      "app",
      "App",
      "APP",
      "apps",
      "application",
      "login",
      "Login",
      "pricing",
      "privacy",
      "terms",
      "api",
      "blog",
      "logs",
      "insights",
      "settings",
      "assets",
      "..",
      ".",
      "",
      "%2e%2e",
      "app%2flogs"
    ),
    { maxLength: 4 }
  )
  .map((segments) => `/${segments.join("/")}`);

/** Deep App_Routes, which must all resolve to the one shell document. */
const arbDeepAppPath = fc
  .array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 3 })
  .map((segments) => `/app/${segments.join("/")}`);

/** A file that may or may not be in the generated Build_Output. */
const arbDistFile = fc.constantFrom(...DIST_FILES);

/** Anything at all, so the totality claim is not limited to shapes we thought of. */
const arbAnyString = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 24 }).map((s) => `/${s}`) },
  { weight: 1, arbitrary: fc.string({ maxLength: 24 }) },
  {
    weight: 1,
    arbitrary: fc.string({
      unit: fc.constantFrom("/", "\\", ".", "%", "a", "p", "l", "o", "g", "i", "n"),
      maxLength: 16,
    }),
  },
  { weight: 1, arbitrary: fc.fullUnicodeString({ maxLength: 12 }).map((s) => `/${s}`) }
);

const arbPath: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: arbNearMiss },
  { weight: 3, arbitrary: arbTablePath },
  { weight: 3, arbitrary: arbAssembled },
  { weight: 2, arbitrary: arbDeepAppPath },
  { weight: 2, arbitrary: arbDistFile },
  { weight: 3, arbitrary: arbAnyString }
);

const resolveWith = (p: string, dist: ReadonlySet<string>): Outcome =>
  resolveRoute(p, { fileExists: (path: string) => dist.has(path) }) as Outcome;

// --- Property 3 --------------------------------------------------------------

describe("Property 3: Route resolution is total and single-valued", () => {
  it("returns exactly one well-formed outcome for any path", () => {
    fc.assert(
      fc.property(arbPath, arbDist, (path, dist) => {
        const outcome = resolveWith(path, dist);

        expect(outcome, `no outcome for ${JSON.stringify(path)}`).toBeTruthy();
        // Exactly one of the five, not a union of two and not a sixth.
        expect(
          OUTCOME_KINDS.filter((kind) => kind === outcome.kind),
          `${JSON.stringify(path)} resolved to kind ${JSON.stringify(outcome.kind)}`
        ).toHaveLength(1);
        expect(outcome.status).toBe(STATUS_FOR[outcome.kind]);

        // Each kind carries the fields that make it answerable, and no others.
        if (outcome.kind === OUTCOME.REDIRECT) {
          expect(typeof outcome.location).toBe("string");
          expect(outcome.file).toBeUndefined();
        } else if (outcome.kind === OUTCOME.STATIC) {
          expect(outcome.location).toBeUndefined();
        } else {
          expect(typeof outcome.file).toBe("string");
          expect(outcome.location).toBeUndefined();
        }

        // Single-valued means single-valued over time too: no hidden state.
        expect(resolveWith(path, dist)).toEqual(outcome);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("agrees with the Route_Table oracle on which outcome that is", () => {
    fc.assert(
      fc.property(arbPath, arbDist, (path, dist) => {
        const expected = expectedKind(path, (p) => dist.has(p));
        expect(
          resolveWith(path, dist).kind,
          `${JSON.stringify(path)} should resolve to ${expected}`
        ).toBe(expected);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("returns the App_Shell if and only if the path is the Login_Route or an App_Route", () => {
    fc.assert(
      fc.property(arbPath, arbDist, (path, dist) => {
        const outcome = resolveWith(path, dist);
        const shell = outcome.kind === OUTCOME.APP_SHELL;

        expect(
          shell,
          shell
            ? `${JSON.stringify(path)} got the App_Shell but is neither the Login_Route nor an App_Route`
            : `${JSON.stringify(path)} is the Login_Route or an App_Route but resolved to ${outcome.kind}`
        ).toBe(isShellPath(path));

        // One shell document, at one path in the Build_Output (Requirement 3.8).
        if (shell) expect(outcome.file).toBe(APP_SHELL_FILE);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("404s every path Requirement 2.5 names, and never answers one with the App_Shell", () => {
    fc.assert(
      fc.property(arbPath, arbDist, (path, dist) => {
        // Requirement 2.5's antecedent: not a Marketing_Page path, not the
        // Login_Route, not an App_Route, no file in the Build_Output — and not
        // the trailing-slash redirect Requirement 2.6 claims first.
        const unknown =
          !isMarketingPath(path) &&
          !isShellPath(path) &&
          !dist.has(path) &&
          !redirectEligible(path);
        if (!unknown) return;

        const outcome = resolveWith(path, dist);
        expect(outcome.kind, `${JSON.stringify(path)} is unknown and must 404`).toBe(
          OUTCOME.NOT_FOUND
        );
        expect(outcome.status).toBe(404);
        expect(outcome.file).toBe(NOT_FOUND_FILE);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("keeps the document classes disjoint, so one outcome is not an artifact of handler order", () => {
    // Marketing_Page, App_Shell, and redirect-eligible never overlap, so their
    // relative registration order cannot change an answer. The static class is
    // the one exception, resolved by precedence and checked below.
    fc.assert(
      fc.property(arbPath, (path) => {
        const claims = [isMarketingPath(path), isShellPath(path), redirectEligible(path)].filter(
          Boolean
        );
        expect(
          claims.length,
          `${JSON.stringify(path)} is claimed by more than one document class`
        ).toBeLessThanOrEqual(1);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("prefers the App_Shell over a Build_Output file that shares an App_Route path", () => {
    // The one observable precedence: `/app/index.html` exists in dist, and the
    // shell handler is registered ahead of serveStatic, so the iff clause holds.
    const dist = new Set(DIST_FILES);
    expect(resolveWith("/app/index.html", dist).kind).toBe(OUTCOME.APP_SHELL);
    // And a file that merely looks like a page path stays static: the home
    // page's own path is `/`, not `/index.html`.
    expect(resolveWith("/index.html", dist).kind).toBe(OUTCOME.STATIC);
  });

  it("resolves every redirect target to a document, so a 301 never lands on another 301", () => {
    fc.assert(
      fc.property(arbPath, arbDist, (path, dist) => {
        const outcome = resolveWith(path, dist);
        if (outcome.kind !== OUTCOME.REDIRECT) return;

        const location = outcome.location as string;
        expect(location).toBe(strippedTarget(path));
        expect(location.startsWith("/")).toBe(true);
        expect(location.startsWith("//")).toBe(false);
        expect(location.endsWith("/")).toBe(false);

        const followed = resolveWith(location, dist);
        expect(followed.kind, `${JSON.stringify(path)} redirects to another redirect`).not.toBe(
          OUTCOME.REDIRECT
        );
        expect([OUTCOME.MARKETING, OUTCOME.APP_SHELL]).toContain(followed.kind);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("generates every outcome class, so the clauses above are not vacuous", () => {
    const dist = new Set(DIST_FILES);
    const seen = new Set(
      fc
        .sample(arbPath, { numRuns: 1000, seed: 3 })
        .map((path) => resolveWith(path, dist).kind)
    );
    for (const kind of OUTCOME_KINDS) {
      expect(seen, `the generators never produced a ${kind} outcome`).toContain(kind);
    }
  });
});
