/**
 * The Content-Security-Policy the Origin_Server sends, and the per-page JSON-LD
 * hash merge that keeps `script-src` strict (Requirements 11.1, 11.2, 11.4,
 * 11.5, Decision D3).
 *
 * There is one base policy — the values the app has always sent — and exactly
 * one thing that ever differs between response classes: a Marketing_Page
 * response adds the hash sources of *its own* structured-data blocks to
 * `script-src`. Every other class, the App_Shell included, gets the base policy
 * with no hashes at all (Requirement 11.5), so an app-shell response can never
 * carry a hash that would let an injected inline script with a matching body
 * execute.
 *
 * The hashes come from `dist/csp-hashes.json`, written by the build
 * (`vite/marketing.js`) and keyed by Marketing_Page path. It is read once, at
 * boot. If it is absent or unreadable the server keeps sending the base policy:
 * a structured-data block then fails to execute and the browser console reports
 * a violation, but every page still renders and no policy is weakened. Failing
 * closed is the right direction here.
 *
 * Two things this module refuses to do with the manifest, because its values go
 * verbatim into a response header:
 *
 *   - it accepts only well-formed `sha256`/`sha384`/`sha512` hash sources, so a
 *     hand-edited or corrupted manifest cannot smuggle `'unsafe-inline'`, a
 *     third-party origin, or a stray `;` into the policy (Requirement 11.2);
 *   - it touches no directive other than `script-src`.
 *
 * Plain ESM JavaScript, matching the rest of `server/`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { GENERATED_FILES } from "../shared/site.js";
import { DIST_ROOT } from "./routes.js";

/**
 * The base policy: what every response gets, and the only policy any
 * non-marketing response gets. Values unchanged from the ones the app shipped
 * before the marketing split (Requirement 11.1).
 *
 * `style-src` keeps `'unsafe-inline'` for React's inline style attributes.
 * `script-src` has neither `'unsafe-inline'` nor `'unsafe-eval'` and nothing in
 * this module may add them (Requirement 11.2).
 */
export const CSP_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob: https://www.themealdb.com",
  "style-src 'self' 'unsafe-inline'", // React inline style attributes
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
]);

/** The base policy as the header value. */
export const CSP = CSP_DIRECTIVES.join("; ");

/**
 * A hash source, with or without the quotes CSP's grammar requires. The build
 * writes the bare `sha256-<base64>` form; both are accepted and the output is
 * always quoted, since an unquoted hash source is ignored by the browser.
 */
const HASH_SOURCE = /^'?(sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}'?$/;

/** `'sha256-…'`, quoted exactly once, or `null` for anything else. */
export function normalizeHashSource(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!HASH_SOURCE.test(trimmed)) return null;
  return `'${trimmed.replace(/^'|'$/g, "")}'`;
}

/**
 * The base policy with `hashes` added to its `script-src` directive.
 *
 * Returns the policy unchanged when there is nothing valid to add, so a page
 * with no structured data gets a byte-identical header to the App_Shell. Order
 * is preserved and duplicates are dropped, which keeps the header stable across
 * builds of identical content.
 *
 * @param {string} csp the base policy
 * @param {readonly string[]} hashes hash sources, quoted or bare
 * @returns {string}
 */
export function withScriptHashes(csp, hashes) {
  /** @type {string[]} */
  const sources = [];
  for (const hash of hashes ?? []) {
    const source = normalizeHashSource(hash);
    if (source && !sources.includes(source)) sources.push(source);
  }
  if (sources.length === 0) return csp;

  let merged = false;
  const directives = csp.split(";").map((directive) => {
    const trimmed = directive.trim();
    if (!/^script-src\b/i.test(trimmed)) return trimmed;
    merged = true;
    const added = sources.filter((source) => !trimmed.split(/\s+/).includes(source));
    return added.length === 0 ? trimmed : `${trimmed} ${added.join(" ")}`;
  });

  // A policy with no script-src at all would silently drop the hashes and, worse,
  // fall back to default-src. Nothing in this repo produces one, so treat it as a
  // programming error rather than shipping a policy that does not do what the
  // caller asked.
  if (!merged) throw new Error("withScriptHashes: the policy has no script-src directive");

  return directives.join("; ");
}

/**
 * Read the hash manifest from the Build_Output.
 *
 * Never throws: a missing file, malformed JSON, or a non-object body all yield
 * an empty manifest, which is the documented fallback to the base policy.
 *
 * @param {{ root?: string }} [options]
 * @returns {Record<string, string[]>} Marketing_Page path → hash sources
 */
export function loadCspHashes({ root = DIST_ROOT } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(root, GENERATED_FILES.cspHashes), "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  /** @type {Record<string, string[]>} */
  const manifest = {};
  for (const [pagePath, hashes] of Object.entries(parsed)) {
    if (!Array.isArray(hashes)) continue;
    const sources = hashes.map(normalizeHashSource).filter((s) => s !== null);
    manifest[pagePath] = /** @type {string[]} */ (sources);
  }
  return manifest;
}

/**
 * The manifest as read at boot. `index.js` imports this module while starting
 * up, so the read happens once, off the request path.
 */
let bootManifest = loadCspHashes();

/** The boot manifest. */
export function cspHashes() {
  return bootManifest;
}

/** Re-read the manifest. Only used by tests, which point `root` at a fixture. */
export function reloadCspHashes(options) {
  bootManifest = loadCspHashes(options);
  return bootManifest;
}

/**
 * The policy for a Marketing_Page response: the base policy plus that page's
 * own JSON-LD hash sources (Requirement 11.4).
 *
 * An unknown path — one the manifest has no entry for, because the build predates
 * it — gets the base policy rather than the union of every page's hashes.
 *
 * @param {string} pathname the Marketing_Page path
 * @param {Record<string, string[]>} [manifest]
 */
export function cspForMarketingPath(pathname, manifest = bootManifest) {
  return withScriptHashes(CSP, manifest[pathname] ?? []);
}
