// @vitest-environment node
//
// Feature: marketing-site-and-routing, Property 1: Route parsing round-trips.
//
// Node environment on purpose: `src/routes.ts` must resolve a URL with no
// `window` and no `location`, so nothing here supplies one.
//
// Two clauses, one `it` each:
//
// 1. Every Route the Route_Table can express survives `formatRoute` →
//    `parseRoute` field-for-field. "Can express" is the constraint that makes
//    the clause meaningful: an `app` Route's `tab`/`flow` pair comes from
//    `APP_VIEWS`, and a `login` Route's `next` is either `null` or an App_Route
//    path — a `next` of `https://evil.com` is not a Route the table can express,
//    it is an input `sanitizeNext` collapses, and Property 2 owns that.
// 2. For any pathname and search string at all, `parseRoute` returns either a
//    Route the Route_Table contains or `null`. The interesting failure this
//    rules out is a half-populated Route — an `app` Route whose `tab`/`flow`
//    pair matches no view, or a `login` Route whose `next` names no App_Route.
//
// Validates: Requirements 2.1, 4.1

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { APP_VIEWS, LOGIN_PATH } from "../shared/site.js";
import { formatRoute, parseRoute, type Route } from "./routes";

/** Every path the Route_Table addresses an Addressable_View by. */
const APP_PATHS: ReadonlySet<string> = new Set(APP_VIEWS.map((v) => v.path));

/** Split what `formatRoute` returns back into the pair `parseRoute` takes. */
function splitFormatted(url: string): [pathname: string, search: string] {
  const q = url.indexOf("?");
  return q === -1 ? [url, ""] : [url.slice(0, q), url.slice(q)];
}

// --- Generators -------------------------------------------------------------

/** The `app` Routes the Route_Table can express: exactly its view set. */
const arbAppRoute: fc.Arbitrary<Route> = fc
  .constantFrom(...APP_VIEWS)
  .map((v) => ({ kind: "app" as const, tab: v.tab, flow: v.flow }));

/** The `login` Routes it can express: `next` absent, or naming an App_Route. */
const arbLoginRoute: fc.Arbitrary<Route> = fc
  .constantFrom<(string | null)[]>(null, ...APP_VIEWS.map((v) => v.path))
  .map((next) => ({ kind: "login" as const, next }));

const arbRoute: fc.Arbitrary<Route> = fc.oneof(arbAppRoute, arbLoginRoute);

/**
 * Path segments weighted toward the near misses that a naive parser gets wrong:
 * the Route_Table's own words, casing and whitespace variants, traversal, and
 * encoded traversal. Free-form strings keep the space open.
 */
const arbSegment: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.constantFrom(
      "app",
      "logs",
      "insights",
      "settings",
      "login",
      "pricing",
      "privacy",
      "terms",
      "blog",
      "apple",
      "APP",
      "Logs",
      "app ",
      " app",
      "",
      "..",
      ".",
      "%2e%2e",
      "%2Fapp"
    ),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
  { weight: 1, arbitrary: fc.fullUnicodeString({ maxLength: 6 }) }
);

const arbPathname: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .tuple(fc.array(arbSegment, { maxLength: 4 }), fc.boolean(), fc.boolean())
      .map(([segs, leading, trailing]) => {
        const body = segs.join("/");
        return `${leading ? "/" : ""}${body}${trailing ? "/" : ""}`;
      }),
  },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      ...APP_VIEWS.map((v) => v.path),
      LOGIN_PATH,
      "/",
      "",
      "/app/",
      "/app//logs",
      "/app/logs/extra",
      "/login/",
      "//evil.com"
    ),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 20 }) }
);

/** `next` values, weighted toward the ones that try to leave the origin. */
const arbNextValue: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.constantFrom(
      "/app",
      "/app/logs",
      "/app/insights",
      "/app/settings",
      "/app/logs/",
      "/app/unknown",
      "/pricing",
      "//evil.com",
      "https://evil.com",
      "/app/../..",
      "/app\\evil.com",
      "%2f%2fevil.com",
      "javascript:alert(1)",
      " /app",
      ""
    ),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 16 }) }
);

const arbSearch: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .array(
        fc.tuple(fc.constantFrom("next", "NEXT", "nextx", "other"), arbNextValue),
        { maxLength: 3 }
      )
      .map((pairs) =>
        pairs.length === 0
          ? ""
          : `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`
      ),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("", "?", "?next", "?next=", "next=/app/logs", "?&&", "?next=%"),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 24 }) }
);

// --- Assertions -------------------------------------------------------------

/**
 * A Route the Route_Table contains: the exact field set for its kind, and a
 * payload the table can name. Anything else is the partially populated Route
 * the property forbids.
 */
function expectContainedInRouteTable(route: Route): void {
  if (route.kind === "login") {
    expect(Object.keys(route).sort()).toEqual(["kind", "next"]);
    if (route.next !== null) {
      // A sanitized `next` is always the table's own spelling of a view.
      expect(APP_PATHS.has(route.next)).toBe(true);
      expect(parseRoute(route.next, "")).toMatchObject({ kind: "app" });
    }
    return;
  }

  expect(Object.keys(route).sort()).toEqual(["flow", "kind", "tab"]);
  const view = APP_VIEWS.find((v) => v.tab === route.tab && v.flow === route.flow);
  expect(view, `no Route_Table view for tab=${route.tab} flow=${route.flow}`).toBeDefined();
}

// --- Property 1 -------------------------------------------------------------

describe("Property 1: Route parsing round-trips", () => {
  it("parseRoute(formatRoute(r)) equals r for every Route the Route_Table can express", () => {
    fc.assert(
      fc.property(arbRoute, (route) => {
        const [pathname, search] = splitFormatted(formatRoute(route));
        const parsed = parseRoute(pathname, search);

        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(route);
        expect(Object.keys(parsed as object).sort()).toEqual(Object.keys(route).sort());
      }),
      { numRuns: 300 }
    );
  });

  it("returns a Route the Route_Table contains, or null, for any pathname and search", () => {
    fc.assert(
      fc.property(arbPathname, arbSearch, (pathname, search) => {
        const route = parseRoute(pathname, search);
        if (route === null) return;
        expectContainedInRouteTable(route);
      }),
      { numRuns: 500 }
    );
  });
});
