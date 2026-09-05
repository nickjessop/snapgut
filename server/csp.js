/**
 * The Content-Security-Policy the Origin_Server sends.
 *
 * One policy for all response classes. The per-page JSON-LD hash merge has been
 * removed along with the JSON-LD blocks themselves, so `cspFor` now returns the
 * base CSP constant for every path.
 *
 * Plain ESM JavaScript, matching the rest of `server/`.
 */

/**
 * The base policy: what every response gets. `style-src` keeps `'unsafe-inline'`
 * for React's inline style attributes. `script-src` has neither `'unsafe-inline'`
 * nor `'unsafe-eval'`.
 */
export const CSP_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'", // React inline style attributes
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
]);

/** The policy as the header value. */
export const CSP = CSP_DIRECTIVES.join("; ");

/**
 * The `Content-Security-Policy` for any response class.
 *
 * Returns the same base policy for all classes — no per-page hash logic.
 *
 * @param {string} _cls a CLASS value (unused, kept for signature compatibility)
 * @param {string} _pathname the request path (unused)
 * @returns {string}
 */
export function cspFor(_cls, _pathname) {
  return CSP;
}
