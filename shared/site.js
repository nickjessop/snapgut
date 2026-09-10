/**
 * The Route_Table: the single source of truth for every public path.
 *
 * The client router, the origin server, the service-worker configuration, and
 * the build inputs all derive their path sets from this module rather than from
 * independent literals (Requirement 2.1).
 *
 * There is no marketing site: this is a self-hosted app, so the origin root is
 * the app itself. Every document path here is answered with the one App_Shell,
 * apart from the not-found document.
 *
 * Plain ESM JavaScript so `server/`, `vite/`, and `src/` can all import it;
 * `shared/site.d.ts` carries the types for the TypeScript side.
 */

/** The not-found document, served with status 404 (Requirement 2.5). */
export const NOT_FOUND_FILE = "404.html";

/** The Login_Route. */
export const LOGIN_PATH = "/login";

/** The prefix every App_Route sits under. */
export const APP_PREFIX = "/app";

/**
 * The origin root.
 *
 * Answered with the App_Shell rather than redirected: visiting the host *is*
 * opening the app, and a redirect is not something a Service_Worker can serve
 * offline. The client router treats it as an alias of `DEFAULT_APP_PATH` and
 * canonicalises the URL in place.
 */
export const ROOT_PATH = "/";

/**
 * The Addressable_Views. `flow` is non-null only where a view is represented
 * internally as a `Flow` rather than a `Tab` — settings is the one case, and it
 * keeps that internal representation while gaining a URL (Requirement 16.4).
 */
export const APP_VIEWS = [
  { path: "/app", tab: "camera", flow: null },
  { path: "/app/logs", tab: "logs", flow: null },
  { path: "/app/insights", tab: "insights", flow: null },
  { path: "/app/settings", tab: "logs", flow: "settings" },
];

/** The default Addressable_View: the camera, preserving today's behavior (Decision D8). */
export const DEFAULT_APP_PATH = "/app";

/** True for `/app` and anything beneath it. Does not match the Login_Route or `/`. */
export const isAppPath = (p) => p === APP_PREFIX || p.startsWith(APP_PREFIX + "/");
