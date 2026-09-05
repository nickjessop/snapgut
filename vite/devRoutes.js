/**
 * Dev-server route middleware (Requirement 7.5).
 *
 * In production the Origin_Server resolves `/login` and every App_Route to
 * `dist/app/index.html` and each Marketing_Page path to its flattened document.
 * The dev server knows none of that: the App_Shell now lives at
 * `app/index.html` rather than at the project root, and the Marketing_Pages are
 * still sitting in `marketing/`, so without a rewrite `/`, `/pricing`, and
 * `/app/logs` all miss and fall through to Vite's own 404.
 *
 * This middleware maps a Navigation_Request onto the source document its path
 * resolves to, deriving both halves of the map from the Route_Table in
 * `shared/site.js` — the same table the server, the sitemap, and the build
 * inputs read. A path therefore resolves to the same *document class* in
 * development as in production, which is all Requirement 7.5 asks for; the
 * status codes, headers, and trailing-slash redirects stay the Origin_Server's
 * business.
 *
 * The rewrite is internal: `req.url` changes, the browser's URL does not, so the
 * client router still sees the path the user asked for.
 *
 * Two things are deliberately left alone. Unknown paths are not mapped to the
 * not-found document — in dev, Vite's own 404 is more informative than a
 * styled page, and nothing in the app depends on the difference. And `/api/*`
 * is never touched, so it still reaches the dev proxy.
 *
 * Plain ESM JavaScript, matching `server/`, `shared/`, and the rest of `vite/`.
 */

import { isAppPath, LOGIN_PATH, MARKETING_PAGES } from "../shared/site.js";

/** The App_Shell source, as a root-relative dev URL. */
const APP_SHELL = "/app/index.html";

/** Where the Marketing_Page sources live, relative to the project root. */
const SOURCE_DIR = "marketing";

/** Methods that can produce a Navigation_Request. */
const NAVIGABLE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The path → source-document map, in resolution order.
 *
 * Marketing_Pages are exact paths; the Login_Route is exact; App_Routes are a
 * prefix match, so they are handled by {@link devRouteFor} rather than by a
 * table entry.
 *
 * @param {{ appShell?: string, dir?: string }} [options]
 * @returns {Map<string, string>}
 */
export function devRouteMap({ appShell = APP_SHELL, dir = SOURCE_DIR } = {}) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const page of MARKETING_PAGES) map.set(page.path, `/${dir}/${page.file}`);
  map.set(LOGIN_PATH, appShell);
  return map;
}

/** The path part of a request URL, without its query or fragment. */
const pathnameOf = (url) => String(url ?? "").split("#")[0].split("?")[0];

/**
 * The source document a dev request URL resolves to, or `null` where the path is
 * not one the Route_Table owns and Vite should handle it as it normally would.
 *
 * @param {string | undefined} url the raw request URL, query and all
 * @param {{ appShell?: string, dir?: string }} [options]
 * @returns {string | null}
 */
export function devRouteFor(url, { appShell = APP_SHELL, dir = SOURCE_DIR } = {}) {
  const pathname = pathnameOf(url);
  if (!pathname.startsWith("/")) return null;

  // The App_Route prefix first: it is the one wildcard in the table, and
  // `/app/index.html` resolving to itself is harmless.
  if (isAppPath(pathname)) return appShell;

  return devRouteMap({ appShell, dir }).get(pathname) ?? null;
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
 * @param {{ appShell?: string, dir?: string }} [options]
 * @returns {import("vite").Plugin}
 */
export function marketingDevRoutes(options = {}) {
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

export default marketingDevRoutes;
