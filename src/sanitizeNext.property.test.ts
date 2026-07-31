// Feature: marketing-site-and-routing, Property 2 (`sanitizeNext` never escapes the app).
//
// **Validates: Requirements 3.4**
//
// The claim is stated as a closed set rather than a prefix check alone: whatever
// `sanitizeNext` returns must be one of the App_Route paths the Route_Table
// itself enumerates. That is strictly stronger than "starts with /app" — it
// rules out `/app@evil.com` or `/app//evil.com` slipping through a prefix test —
// and it is what makes an open redirect unreachable.
//
// The generators below are hostile by construction: every known shape of
// same-origin escape (scheme, authority, protocol-relative, backslash-folded,
// traversal, embedded credentials) crossed with the percent-encoded, doubly
// encoded, and mixed-case-hex spellings of each. Unconstrained Unicode strings
// ride along so the property is not only asserted over shapes we thought of.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { APP_VIEWS, DEFAULT_APP_PATH } from "../shared/site.js";
import { parseRoute, sanitizeNext } from "./routes";

const ITERATIONS = 500;

/** Exactly the App_Route paths the Route_Table contains. */
const APP_PATHS = APP_VIEWS.map((v) => v.path);

/**
 * The property, asserted on one value: the result is an App_Route the
 * Route_Table contains, and it parses back to that same app view.
 */
function assertNeverEscapes(raw: string | null): void {
  const out = sanitizeNext(raw);

  expect(out.startsWith(DEFAULT_APP_PATH)).toBe(true);
  expect(APP_PATHS).toContain(out);

  const route = parseRoute(out);
  expect(route).not.toBeNull();
  expect(route?.kind).toBe("app");
  expect(APP_VIEWS.some((v) => v.path === out)).toBe(true);
}

/** Hosts a redirect would be worth stealing to. */
const arbHost = fc.constantFrom(
  "evil.com",
  "evil.example",
  "user@evil.com",
  "snapgut.com.evil.com",
  "127.0.0.1",
  "localhost:8080",
  "[::1]"
);

/** Scheme and authority prefixes, including the case-varied and folded forms. */
const arbPrefix = fc.constantFrom(
  "https://",
  "http://",
  "HTTPS://",
  "hTtPs://",
  "javascript:",
  "data:text/html,",
  "//",
  "///",
  "////",
  "\\\\",
  "/\\",
  "\\/",
  "https:/\\",
  "https:\\\\",
  "/app/../../",
  "/app/..//"
);

/** Escapes assembled from a prefix and a host, e.g. `/\evil.com`. */
const arbAssembledEscape = fc
  .tuple(arbPrefix, arbHost)
  .map(([prefix, host]) => `${prefix}${host}`);

/** Escapes that need no host: traversal, credentials, fragments, whitespace. */
const arbBareEscape = fc.constantFrom(
  "/app/../..",
  "/app/..",
  "/app/./../..",
  "/app/logs/../../..",
  "/app@evil.com",
  "/app:8080",
  "/app#//evil.com",
  "/app?next=//evil.com",
  "/app\\evil.com",
  "/app\\\\evil.com",
  " /app",
  "\t/app",
  "\n//evil.com",
  "/\tapp",
  "/app\u0000/evil",
  "app",
  "/application",
  "/appliance/logs",
  "",
  "/",
  "//",
  "\\",
  "/APP",
  "/App/Logs",
  "/login",
  "/pricing",
  "/api/auth/request"
);

/** Percent-encode every character, the blunt form of an encoded escape. */
const encodeAll = (s: string) =>
  [...s].map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");

/** Encode only the structural characters, leaving the payload readable. */
const encodeStructural = (s: string) =>
  s.replace(/[/\\:@?#]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** Upper-case hex digits, since a case-sensitive decoder is a classic gap. */
const upperHex = (s: string) => s.replace(/%([0-9a-f]{2})/g, (_, h) => `%${h.toUpperCase()}`);

/** Encode the `%` itself, so one decoding pass reveals the escape. */
const encodeTwice = (s: string) => encodeStructural(s).replace(/%/g, "%25");

/** Every spelling of one escape: literal, encoded, double-encoded, mixed case. */
const arbEncodedVariant = fc
  .tuple(
    fc.oneof(arbAssembledEscape, arbBareEscape),
    fc.constantFrom<(s: string) => string>(
      (s) => s,
      encodeAll,
      encodeStructural,
      (s) => upperHex(encodeStructural(s)),
      (s) => upperHex(encodeAll(s)),
      encodeTwice,
      (s) => `/app/${encodeStructural(s)}`,
      (s) => `/app${encodeStructural(s)}`
    )
  )
  .map(([raw, spell]) => spell(raw));

/** The values that should survive: the Route_Table's own paths and near misses. */
const arbNearMiss = fc
  .tuple(
    fc.constantFrom(...APP_PATHS),
    fc.constantFrom<(s: string) => string>(
      (s) => s,
      (s) => `${s}/`,
      (s) => `${s}//`,
      (s) => `${s}/../..`,
      (s) => s.toUpperCase(),
      (s) => `${s}?x=1`,
      (s) => ` ${s}`
    )
  )
  .map(([path, mutate]) => mutate(path));

/** Anything at all, including lone surrogates and control characters. */
const arbAnyString = fc.oneof(
  { weight: 3, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.fullUnicodeString() },
  { weight: 1, arbitrary: fc.string({ unit: fc.constantFrom("/", "\\", ".", "%", ":", "a") }) }
);

const arbNext = fc.oneof(
  { weight: 4, arbitrary: arbEncodedVariant },
  { weight: 2, arbitrary: arbAssembledEscape },
  { weight: 2, arbitrary: arbBareEscape },
  { weight: 2, arbitrary: arbNearMiss },
  { weight: 3, arbitrary: arbAnyString }
);

describe("Property 2: sanitizeNext never escapes the app", () => {
  it("returns an App_Route from the Route_Table for any input", () => {
    fc.assert(
      fc.property(arbNext, (raw) => {
        assertNeverEscapes(raw);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("returns an App_Route for absolute URLs, protocol-relative paths, traversal, backslash, and encoded forms", () => {
    fc.assert(
      fc.property(fc.oneof(arbAssembledEscape, arbEncodedVariant), (raw) => {
        expect(sanitizeNext(raw)).toBe(DEFAULT_APP_PATH);
      }),
      { numRuns: ITERATIONS }
    );
  });

  it("holds for the absent parameter", () => {
    assertNeverEscapes(null);
  });

  it("preserves a Route_Table App_Route unchanged", () => {
    fc.assert(
      fc.property(fc.constantFrom(...APP_PATHS), (path) => {
        expect(sanitizeNext(path)).toBe(path);
      }),
      { numRuns: ITERATIONS }
    );
  });
});
