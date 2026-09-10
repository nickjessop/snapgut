/**
 * The Origin_Server's route resolution, derived from the Route_Table.
 *
 * This module owns the answer to "what does this path resolve to", and it owns
 * it in one place: `resolveRoute` states the outcome for any path, and
 * `registerSiteRoutes` registers the handlers that produce those outcomes. Both
 * read the same Route_Table constants from `shared/site.js`, so a path cannot
 * resolve one way in the resolver and another way in the running server
 * (Requirements 2.1, 2.9).
 *
 * It lives outside `server/index.js` because that module calls `serve()` at
 * import time, which makes it awkward to drive in-process; `index.js` mounts
 * this with one line and the route tests call `resolveRoute` directly.
 *
 * Registration order matters and is the caller's responsibility: this must be
 * mounted *after* every `/api/*` guard and handler, so the route changes here
 * affect zero `/api/*` paths (Requirement 2.8).
 */

import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import {
  APP_PREFIX,
  LOGIN_PATH,
  NOT_FOUND_FILE,
  ROOT_PATH,
  isAppPath,
} from "../shared/site.js";

/** The Build_Output root, as both a relative path (for serveStatic) and resolved. */
export const DIST_ROOT = "./dist";

/**
 * The one App_Shell document. The origin root, the Login_Route, and every
 * App_Route are answered with this same file, so the shell exists at exactly one
 * path in the Build_Output (Requirement 3.8).
 */
export const APP_SHELL_FILE = "app/index.html";

/** The four outcomes a path can resolve to (design Property 3). */
export const OUTCOME = Object.freeze({
  APP_SHELL: "app-shell",
  STATIC: "static",
  REDIRECT: "redirect",
  NOT_FOUND: "not-found",
});

/** True for the paths answered with the App_Shell: `/`, `/login`, `/app`, `/app/*`. */
const isShellPath = (p) => p === ROOT_PATH || p === LOGIN_PATH || isAppPath(p);

/** Served when the Build_Output has no `404.html` (an unbuilt or partial dist). */
const FALLBACK_NOT_FOUND =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  "<title>Page not found — SnapGut</title></head>" +
  "<body><h1>Page not found</h1></body></html>";

const distFile = (file) => `${DIST_ROOT}/${file}`;

/**
 * The target of the trailing-slash redirect, or `null` when a path needs none.
 *
 * With the marketing site gone, `/login/` is the only path left that redirects
 * (Requirement 2.6): it is the one non-prefixed document path a link or a typo
 * can reach with a trailing slash. Redirecting every trailing slash would turn
 * `/nonsense/` into a 301 followed by a 404, where Requirement 2.5 asks for a
 * single 404. An App_Route keeps its 200, so the shell is served for exactly the
 * paths `isAppPath` recognises. `/` is the origin root and already canonical —
 * it is not a trailing slash to strip, and stripping it would leave the empty
 * string.
 */
export function redirectTargetFor(pathname) {
  if (typeof pathname !== "string" || pathname === ROOT_PATH || !pathname.endsWith("/")) {
    return null;
  }
  const stripped = pathname.replace(/\/+$/, "");
  if (stripped === "" || isAppPath(stripped)) return null;
  if (stripped === LOGIN_PATH) return stripped;
  return null;
}

/**
 * Whether a request path names a file that exists in the Build_Output.
 *
 * Only used by `resolveRoute` to separate the "static file" outcome from the
 * 404 one; the running server leaves the serving itself to `serveStatic`.
 * Traversal, encoded traversal, and NUL bytes resolve to `false` rather than
 * escaping the Build_Output.
 */
export function distFileExists(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false; // malformed percent-encoding names no file
  }
  if (decoded.includes("\0")) return false;
  const root = path.resolve(DIST_ROOT);
  const full = path.resolve(root, `.${decoded}`);
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a request path to exactly one outcome (Requirement 2.9).
 *
 * The order is the resolution order of the registered handlers: the
 * trailing-slash redirect, then the origin root, the Login_Route, and the
 * App_Routes, then a real file in the Build_Output, then the not-found document.
 * `/api/*` paths are handled before this resolver is ever consulted, so an
 * unmatched one falls through to the same 404 as any other unknown path.
 *
 * @param {string} pathname the request path, e.g. `/app/logs`
 * @param {{ fileExists?: (pathname: string) => boolean }} [options]
 *   `fileExists` substitutes a Build_Output for testing.
 */
export function resolveRoute(pathname, options = {}) {
  const fileExists = options.fileExists ?? distFileExists;

  const location = redirectTargetFor(pathname);
  if (location !== null) return { kind: OUTCOME.REDIRECT, status: 301, location };

  if (isShellPath(pathname)) {
    return { kind: OUTCOME.APP_SHELL, status: 200, file: APP_SHELL_FILE };
  }

  if (fileExists(pathname)) return { kind: OUTCOME.STATIC, status: 200 };

  return { kind: OUTCOME.NOT_FOUND, status: 404, file: NOT_FOUND_FILE };
}

let notFoundDocument = null;

/**
 * The not-found document, read once from the Build_Output. A failed read is not
 * cached, so a dist that appears later is picked up.
 */
async function readNotFound() {
  if (notFoundDocument !== null) return notFoundDocument;
  try {
    notFoundDocument = await readFile(path.resolve(DIST_ROOT, NOT_FOUND_FILE), "utf8");
    return notFoundDocument;
  } catch {
    return FALLBACK_NOT_FOUND;
  }
}

/**
 * Register the document, static-file, redirect, and not-found handlers on a Hono
 * app, in the order `resolveRoute` describes.
 *
 * Mount last: every `/api/*` guard and handler, the `/foods/*` proxy, and the
 * security-header middleware must already be registered, since Hono runs
 * matching handlers in registration order.
 */
export function registerSiteRoutes(app) {
  // Trailing slash → 301 to the canonical path (Requirement 2.6). Registered
  // ahead of the document handlers; Hono's router is strict about the trailing
  // slash, so `/login/` would otherwise reach no handler at all.
  app.use("*", async (c, next) => {
    const location = redirectTargetFor(new URL(c.req.url).pathname);
    if (location === null) return next();
    // The search string comes back from the WHATWG URL parser already encoded,
    // so nothing a client sends can inject a header.
    return c.redirect(`${location}${new URL(c.req.url).search}`, 301);
  });

  // The origin root, the Login_Route, and every App_Route share the one
  // App_Shell document (Requirements 2.3, 3.8). `/` is registered here rather
  // than redirected to `/app`: visiting the host is opening the app, and a
  // redirect is not something the Service_Worker can answer offline. It is also
  // registered ahead of `serveStatic` below so no `dist/index.html` left behind
  // by an older build can shadow it.
  const appShell = serveStatic({ path: distFile(APP_SHELL_FILE) });
  app.get(ROOT_PATH, appShell);
  app.get(LOGIN_PATH, appShell);
  app.get(APP_PREFIX, appShell);
  app.get(`${APP_PREFIX}/*`, appShell);

  // Real files in the Build_Output: hashed assets, the manifest, the service
  // worker, robots.txt (Requirement 2.4).
  app.use("/*", serveStatic({ root: DIST_ROOT }));

  // Terminal handler: an unknown path gets the standalone not-found document
  // with status 404, never the App_Shell (Requirement 2.5). This replaces the
  // SPA catch-all that made every typo a soft 404 with status 200.
  app.get("*", async (c) => c.html(await readNotFound(), 404));
}
