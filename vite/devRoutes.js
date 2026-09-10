/**
 * Dev-server route middleware (Requirement 7.5).
 *
 * In production the Origin_Server resolves the origin root, the Login_Route, and
 * every App_Route to `dist/app/index.html`. The dev server knows none of that:
 * the App_Shell lives at `app/index.html` rather than at the project root, so
 * without a rewrite `/`, `/login`, and `/app/logs` all miss and fall through to
 * Vite's own 404.
 *
 * This middleware maps a Navigation_Request onto the source document its path
 * resolves to, deriving both halves of the map from the Route_Table in
 * `shared/site.js` — the same table the server and the build inputs read. A path
 * therefore resolves to the same *document class* in development as in
 * production, which is all Requirement 7.5 asks for; the status codes, headers,
 * and trailing-slash redirects stay the Origin_Server's business.
 *
 * The rewrite is internal: `req.url` changes, the browser's URL does not, so the
 * client router still sees the path the user asked for.
 *
 * Two things are deliberately left alone. Unknown paths are not mapped to the
 * not-found document — in dev, Vite's own 404 is more informative than a styled
 * page, and nothing in the app depends on the difference. And `/api/*` is never
 * touched, so it still reaches the dev proxy.
 *
 * Plain ESM JavaScript, matching `server/`, `shared/`, and the rest of `vite/`.
 */

import { isAppPath, LOGIN_PATH, ROOT_PATH } from "../shared/site.js";

/** The App_Shell source, as a root-relative dev URL. */
const APP_SHELL = "/app/index.html";

/** Methods that can produce a Navigation_Request. */
const NAVIGABLE_METHODS = new Set(["GET", "HEAD"]);

/** The path part of a request URL, without its query or fragment. */
const pathnameOf = (url) => String(url ?? "").split("#")[0].split("?")[0];

/**
 * The exact path → source-document map. App_Routes are a prefix match rather
 * than a table entry, so they are handled by {@link devRouteFor}.
 *
 * @param {{ appShell?: string }} [options]
 * @returns {Map<string, string>}
 */
export function devRouteMap({ appShell = APP_SHELL } = {}) {
  return new Map([
    [ROOT_PATH, appShell],
    [LOGIN_PATH, appShell],
  ]);
}

/**
 * The source document a dev request URL resolves to, or `null` where the path is
 * not one the Route_Table owns and Vite should handle it as it normally would.
 *
 * @param {string | undefined} url the raw request URL, query and all
 * @param {{ appShell?: string }} [options]
 * @returns {string | null}
 */
export function devRouteFor(url, { appShell = APP_SHELL } = {}) {
  const pathname = pathnameOf(url);
  if (!pathname.startsWith("/")) return null;

  // The App_Route prefix first: it is the one wildcard in the table, and
  // `/app/index.html` resolving to itself is harmless.
  if (isAppPath(pathname)) return appShell;

  return devRouteMap({ appShell }).get(pathname) ?? null;
}

/**
 * True for a request that wants a document. Vite's own HTML middlewares gate on
 * the same header; a missing `Accept` (curl, a health probe) is treated as
 * acceptable because every path in the map names a document and nothing else.
 *
 * @param {string | undefined} accept
 */
const acceptsHtml = (accept) =>
  !accept || accept.includes("text/html") || accept.includes("*/*");

/**
 * @param {{ appShell?: string }} [options]
 * @returns {import("vite").Plugin}
 */
export function appDevRoutes(options = {}) {
  return {
    name: "snapgut-dev-routes",
    apply: "serve",
    configureServer(server) {
      // Registered from `configureServer` directly rather than from a returned
      // post hook, so it runs *before* Vite's HTML transform and fallback
      // middlewares and they see the rewritten URL.
      server.middlewares.use((req, _res, next) => {
        if (NAVIGABLE_METHODS.has(String(req.method).toUpperCase()) && acceptsHtml(req.headers?.accept)) {
          const source = devRouteFor(req.url, options);
          if (source) req.url = source;
        }
        next();
      });
    },
  };
}

export default appDevRoutes;
