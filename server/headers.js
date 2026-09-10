/**
 * Per-class response headers for the Origin_Server: `Cache-Control`,
 * `X-Robots-Tag`, `Content-Type`, and `Content-Security-Policy`.
 *
 * Classification is deliberately driven by the *actual* response status for the
 * redirect and not-found rows, so the headers describe what the server really
 * answered rather than what a second, independent path-matching pass predicts.
 */

import {
  LOGIN_PATH,
  ROOT_PATH,
  isAppPath,
} from "../shared/site.js";
import { CSP, cspFor } from "./csp.js";

// Re-export for consumers that import from headers.js
export { cspFor };

/** The header classes of the design's route resolution table. */
export const CLASS = Object.freeze({
  /** `/api/*`: never cached, never indexed. */
  API: "api",
  /** `/foods/*`: the existing immutable proxy — its headers are left alone. */
  FOODS: "foods",
  /**
   * The origin root, the Login_Route, or an App_Route — all three answered with
   * the App_Shell.
   */
  APP_SHELL: "app-shell",
  /** A content-hashed build asset under `/assets/`. */
  HASHED_ASSET: "hashed-asset",
  /** `/sw.js` and the manifest: revalidated so a deploy is picked up. */
  REVALIDATE_ASSET: "revalidate-asset",
  /** `robots.txt`. */
  CRAWLER_FILE: "crawler-file",
  /** Any other real file in the Build_Output (icons, favicons). */
  OTHER_STATIC: "other-static",
  /** The trailing-slash 301. */
  REDIRECT: "redirect",
  /** The not-found response. */
  NOT_FOUND: "not-found",
});

const HTML_TYPE = "text/html; charset=utf-8";

/** `Cache-Control` per class. `null` means "leave whatever the handler set". */
const CACHE_CONTROL = Object.freeze({
  [CLASS.API]: "no-store",
  [CLASS.FOODS]: null,
  [CLASS.APP_SHELL]: "no-cache",
  [CLASS.HASHED_ASSET]: "public, max-age=31536000, immutable",
  [CLASS.REVALIDATE_ASSET]: "no-cache",
  [CLASS.CRAWLER_FILE]: "public, max-age=3600",
  [CLASS.OTHER_STATIC]: "public, max-age=3600",
  [CLASS.REDIRECT]: null,
  [CLASS.NOT_FOUND]: "no-store",
});

/**
 * The class a response belongs to.
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
  if (p === ROOT_PATH || p === LOGIN_PATH || isAppPath(p)) return CLASS.APP_SHELL;
  if (p.startsWith("/assets/")) return CLASS.HASHED_ASSET;
  if (p === "/sw.js" || p === "/manifest.webmanifest") return CLASS.REVALIDATE_ASSET;
  if (p === "/robots.txt") return CLASS.CRAWLER_FILE;
  return CLASS.OTHER_STATIC;
}

/** `Cache-Control` for a class, or `null` to leave the response's own value. */
export function cacheControlFor(cls) {
  return CACHE_CONTROL[cls] ?? null;
}

/**
 * Whether the response carries `X-Robots-Tag: noindex`. Always.
 *
 * With the marketing site gone there is no indexable surface left: every
 * document this server answers is the App_Shell or the not-found page, and a
 * self-hosted health diary is not something that should ever appear in a search
 * index — the URL alone tells a crawler who is running one. `robots.txt` says
 * the same thing (`Disallow: /`); this is the header that says it to a crawler
 * that fetched the path anyway.
 *
 * The parameters are kept so the signature stays stable for callers and so
 * re-introducing a per-class exception is a change here rather than a
 * re-plumbing. `publicOrigin` no longer affects indexing.
 *
 * @param {string} [_cls] a CLASS value, unused
 * @param {string|null|undefined} [_publicOrigin] the configured PUBLIC_ORIGIN, unused
 */
export function shouldNoIndex(_cls, _publicOrigin) {
  return true;
}

/**
 * The `Content-Type` this module asserts, or `null` where the response's own
 * type stands.
 */
export function contentTypeFor(cls, pathname) {
  switch (cls) {
    case CLASS.APP_SHELL:
    case CLASS.NOT_FOUND:
      return HTML_TYPE;
    case CLASS.CRAWLER_FILE:
      return "text/plain; charset=utf-8";
    case CLASS.REVALIDATE_ASSET:
      return pathname === "/manifest.webmanifest" ? "application/manifest+json" : null;
    default:
      return null;
  }
}

/**
 * Every header this module owns, for one response.
 *
 * @param {{ pathname: string, status?: number, publicOrigin?: string|null }} options
 */
export function headersFor({ pathname, status = 200, publicOrigin = null }) {
  const cls = classifyPath(pathname, status);
  return {
    class: cls,
    cacheControl: cacheControlFor(cls),
    robots: shouldNoIndex(cls, publicOrigin) ? "noindex" : null,
    contentType: contentTypeFor(cls, pathname),
    csp: cspFor(cls, pathname),
  };
}

/**
 * Apply the per-class headers to a finalized response.
 *
 * Requires `c._publicOrigin` to be set on the context (injected by the security
 * middleware from config). Falls back to null (noindex for all).
 */
export function applySiteHeaders(c) {
  const { pathname } = new URL(c.req.url);
  const { cacheControl, robots, contentType, csp } = headersFor({
    pathname,
    status: c.res.status,
    publicOrigin: c._publicOrigin ?? null,
  });
  if (cacheControl) c.header("Cache-Control", cacheControl);
  if (robots) c.header("X-Robots-Tag", robots);
  if (contentType) c.header("Content-Type", contentType);
  c.header("Content-Security-Policy", csp);
}

/**
 * Register the per-class headers as standalone middleware.
 */
export function registerSiteHeaders(app, { publicOrigin = null } = {}) {
  app.use("*", async (c, next) => {
    c._publicOrigin = publicOrigin;
    await next();
    applySiteHeaders(c);
  });
}
