/**
 * Per-class response headers for the Origin_Server: `Cache-Control`,
 * `X-Robots-Tag`, `Content-Type`, and `Content-Security-Policy`
 * (Requirements 2.7, 8.6, 8.9, 11.1, 11.4, 11.5, 11.7, 12.1–12.5).
 *
 * The design's route resolution table is the authoritative matrix, and this
 * module is that table expressed once, as data. `classifyPath` names the class a
 * response belongs to and the three lookup functions read the row. Everything
 * here is pure and takes the request path, the request Host, and the status the
 * handlers produced, so the header behaviour can be asserted without a socket.
 *
 * It lives beside `routes.js` rather than inside `index.js` for the same reason
 * that module does: `index.js` calls `serve()` at import time. `index.js` calls
 * `applySiteHeaders` from its existing security middleware, which keeps the rest
 * of that header set (HSTS, nosniff, frame options, referrer, permissions)
 * untouched — this adds to it, and never removes or weakens a header it sets.
 *
 * `Content-Security-Policy` is set here rather than in `index.js` because the
 * policy is a per-class choice too: a Marketing_Page response carries the hash
 * sources of its own structured-data blocks and every other class, the App_Shell
 * included, gets the hash-free base policy (Requirements 11.4, 11.5). The policy
 * itself lives in `./csp.js`; this module only picks which one a class gets.
 *
 * Classification is deliberately driven by the *actual* response status for the
 * redirect and not-found rows, so the headers describe what the server really
 * answered rather than what a second, independent path-matching pass predicts.
 */

import {
  CANONICAL_ORIGIN,
  LOGIN_PATH,
  isAppPath,
  isMarketingPath,
} from "../shared/site.js";
import { CSP, cspForMarketingPath } from "./csp.js";

/** The header classes of the design's route resolution table. */
export const CLASS = Object.freeze({
  /** `/api/*`: never cached, never indexed. */
  API: "api",
  /** `/foods/*`: the existing immutable proxy — its headers are left alone. */
  FOODS: "foods",
  /** A Marketing_Page document. */
  MARKETING: "marketing",
  /** The Login_Route or an App_Route, both answered with the App_Shell. */
  APP_SHELL: "app-shell",
  /** A content-hashed build asset under `/assets/`. */
  HASHED_ASSET: "hashed-asset",
  /** `/sw.js` and the manifest: revalidated so a deploy is picked up. */
  REVALIDATE_ASSET: "revalidate-asset",
  /** `robots.txt` and `sitemap.xml`. */
  CRAWLER_FILE: "crawler-file",
  /** Any other real file in the Build_Output (icons, the OG image). */
  OTHER_STATIC: "other-static",
  /** The trailing-slash 301. */
  REDIRECT: "redirect",
  /** The not-found response. */
  NOT_FOUND: "not-found",
});

/** The hostname of the Canonical_Host, derived rather than repeated. */
const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).hostname;

const HTML_TYPE = "text/html; charset=utf-8";

/** `Cache-Control` per class. `null` means "leave whatever the handler set". */
const CACHE_CONTROL = Object.freeze({
  [CLASS.API]: "no-store",
  // The /foods/* handler already sets the immutable directive; re-stating it
  // here would be a second copy to keep in sync (Requirement 12.2).
  [CLASS.FOODS]: null,
  [CLASS.MARKETING]: "public, max-age=0, s-maxage=3600, must-revalidate",
  [CLASS.APP_SHELL]: "no-cache",
  [CLASS.HASHED_ASSET]: "public, max-age=31536000, immutable",
  [CLASS.REVALIDATE_ASSET]: "no-cache",
  [CLASS.CRAWLER_FILE]: "public, max-age=3600",
  // Unhashed but stable files: bounded so a deploy is picked up within the hour
  // without asking for a revalidation on every icon.
  [CLASS.OTHER_STATIC]: "public, max-age=3600",
  // The table leaves the 301 uncached: the redirect target is a document whose
  // own headers decide its freshness.
  [CLASS.REDIRECT]: null,
  [CLASS.NOT_FOUND]: "no-store",
});

/** The classes that carry `noindex` on the Canonical_Host too. */
const NOINDEX_CLASSES = new Set([CLASS.API, CLASS.APP_SHELL, CLASS.NOT_FOUND]);

/**
 * The class a response belongs to.
 *
 * Order matters. `/api/*` and `/foods/*` come first because they are answered by
 * handlers registered ahead of the Route_Table and keep their own behaviour. The
 * status is consulted next so a real redirect or a real 404 is headed as one,
 * whatever path produced it.
 *
 * @param {string} pathname the request path
 * @param {number} status the status the handlers produced
 */
export function classifyPath(pathname, status = 200) {
  const p = typeof pathname === "string" ? pathname : "";
  if (p === "/api" || p.startsWith("/api/")) return CLASS.API;
  if (p === "/foods" || p.startsWith("/foods/")) return CLASS.FOODS;
  if (status >= 300 && status < 400) return CLASS.REDIRECT;
  if (status === 404) return CLASS.NOT_FOUND;
  if (isMarketingPath(p)) return CLASS.MARKETING;
  if (p === LOGIN_PATH || isAppPath(p)) return CLASS.APP_SHELL;
  if (p.startsWith("/assets/")) return CLASS.HASHED_ASSET;
  if (p === "/sw.js" || p === "/manifest.webmanifest") return CLASS.REVALIDATE_ASSET;
  if (p === "/robots.txt" || p === "/sitemap.xml") return CLASS.CRAWLER_FILE;
  return CLASS.OTHER_STATIC;
}

/** `Cache-Control` for a class, or `null` to leave the response's own value. */
export function cacheControlFor(cls) {
  return CACHE_CONTROL[cls] ?? null;
}

/**
 * Whether the request Host is the Canonical_Host. A port is ignored so a local
 * `snapgut.com:8080` behaves like production; an absent or unparseable Host is
 * treated as non-canonical, which only ever adds `noindex`.
 */
export function isCanonicalHost(host) {
  if (typeof host !== "string" || host === "") return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  return name === CANONICAL_HOST;
}

/**
 * Whether the response carries `X-Robots-Tag: noindex`.
 *
 * True for the Login_Route, the App_Routes, `/api/*`, and the not-found response
 * on any host (Requirements 8.6, 12.x), and true for *every* response on a
 * Non_Canonical_Host, so the `*.run.app` hostname and `www.snapgut.com` cannot
 * be indexed as duplicate content (Requirements 2.7, 8.9).
 */
export function shouldNoIndex(cls, host) {
  return NOINDEX_CLASSES.has(cls) || !isCanonicalHost(host);
}

/**
 * The `Content-Type` this module asserts, or `null` where the response's own
 * type stands (a `/foods/*` image, an `/api/*` JSON body, a hashed asset).
 *
 * Stated explicitly for the document and crawler classes so Requirement 11.7
 * holds regardless of the static file server's mime table, and so the not-found
 * document does not answer with a differently-cased charset than the pages.
 */
export function contentTypeFor(cls, pathname) {
  switch (cls) {
    case CLASS.MARKETING:
    case CLASS.APP_SHELL:
    case CLASS.NOT_FOUND:
      return HTML_TYPE;
    case CLASS.CRAWLER_FILE:
      return pathname === "/robots.txt"
        ? "text/plain; charset=utf-8"
        : "application/xml; charset=utf-8";
    case CLASS.REVALIDATE_ASSET:
      return pathname === "/manifest.webmanifest" ? "application/manifest+json" : null;
    default:
      return null;
  }
}

/**
 * The `Content-Security-Policy` for a class.
 *
 * Only the Marketing class differs from the base policy, and it differs by
 * exactly the hash sources of that page's own `application/ld+json` blocks
 * (Requirement 11.4). Every other class — the App_Shell, `/api/*`, the not-found
 * document, a static file — gets the base policy, whose `script-src` carries no
 * hashes at all (Requirement 11.5).
 *
 * @param {string} cls a `CLASS` value
 * @param {string} pathname the request path
 * @param {Record<string, string[]>} [hashes] substitutes a manifest for testing
 */
export function cspFor(cls, pathname, hashes) {
  if (cls !== CLASS.MARKETING) return CSP;
  return cspForMarketingPath(pathname, hashes);
}

/**
 * Every header this module owns, for one response. Returned as data so a test
 * can assert the whole row at once; a `null` value means "do not set".
 *
 * `hashes` substitutes a JSON-LD hash manifest; the default is the one read from
 * the Build_Output at boot.
 */
export function headersFor({ pathname, host, status = 200, hashes }) {
  const cls = classifyPath(pathname, status);
  return {
    class: cls,
    cacheControl: cacheControlFor(cls),
    robots: shouldNoIndex(cls, host) ? "noindex" : null,
    contentType: contentTypeFor(cls, pathname),
    csp: cspFor(cls, pathname, hashes),
  };
}

/**
 * Apply the per-class headers to a finalized response.
 *
 * Call after `await next()`, from the security-header middleware, so the class
 * is decided against the status the handlers actually produced. Only sets the
 * four headers above; every other header on the response is left as it is.
 */
export function applySiteHeaders(c) {
  const { pathname } = new URL(c.req.url);
  const { cacheControl, robots, contentType, csp } = headersFor({
    pathname,
    host: c.req.header("host"),
    status: c.res.status,
  });
  if (cacheControl) c.header("Cache-Control", cacheControl);
  if (robots) c.header("X-Robots-Tag", robots);
  if (contentType) c.header("Content-Type", contentType);
  // Unconditional: Requirement 11.1 asks for a policy on every response, and
  // this is the only place that sets one.
  c.header("Content-Security-Policy", csp);
}

/**
 * Register the per-class headers as standalone middleware.
 *
 * `index.js` does not use this — it calls `applySiteHeaders` from the middleware
 * that already sets the security headers — but a test that mounts the site
 * routes on a fresh Hono app needs the same behaviour, and both paths run the
 * one function so they cannot drift.
 */
export function registerSiteHeaders(app) {
  app.use("*", async (c, next) => {
    await next();
    applySiteHeaders(c);
  });
}
