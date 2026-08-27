/**
 * The Route_Table: the single source of truth for every public path.
 *
 * The client router, the origin server, the service-worker configuration, the
 * multi-page build inputs, and the generated sitemap all derive their path sets
 * from this module rather than from independent literals (Requirement 2.1).
 * Adding a marketing page is one entry here (Requirement 16.2).
 *
 * Plain ESM JavaScript so `server/`, `vite/`, and `src/` can all import it;
 * `shared/site.d.ts` carries the types for the TypeScript side.
 */

/**
 * The v1 marketing page set (Decision D1). `file` is the path of the emitted
 * document inside the Build_Output, relative to its root.
 */
export const MARKETING_PAGES = [
  {
    path: "/",
    file: "index.html",
    title: "SnapGut — Know what your gut is telling you",
    description:
      "A fast food and symptom diary that does the statistics properly. Snap a photo, log how you feel, and see which foods track with your symptoms.",
  },
  {
    path: "/privacy",
    file: "privacy.html",
    title: "Privacy — SnapGut",
    description:
      "What SnapGut keeps on your device, the little we keep on our servers, what leaves your device to identify a meal, and how to export or delete everything.",
  },
  {
    path: "/terms",
    file: "terms.html",
    title: "Terms — SnapGut",
    description:
      "The terms for using SnapGut: what the app does and does not claim, your responsibilities as the operator of a self-hosted instance, and what we each agree to.",
  },
];

/** The not-found document, served with status 404 (Requirement 2.5). */
export const NOT_FOUND_FILE = "404.html";

/** The Login_Route. */
export const LOGIN_PATH = "/login";

/** The prefix every App_Route sits under. */
export const APP_PREFIX = "/app";

/**
 * Reserved for future content pages (Decision D6). Nothing is served here yet,
 * so paths under it take the not-found outcome of Requirement 2.5.
 */
export const RESERVED_CONTENT_PREFIX = "/blog/";

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

/** Every Marketing_Page path, in Route_Table order. */
export const marketingPaths = () => MARKETING_PAGES.map((p) => p.path);

/** True for exactly the Marketing_Page paths. */
export const isMarketingPath = (p) => marketingPaths().includes(p);

/** True for `/app` and anything beneath it. Does not match the Login_Route. */
export const isAppPath = (p) => p === APP_PREFIX || p.startsWith(APP_PREFIX + "/");

/** The paths that belong in `sitemap.xml`: the Marketing_Pages and nothing else. */
export const indexablePaths = () => marketingPaths();

/**
 * The names of the files the build generates into the Build_Output root.
 *
 * Defined here so both `vite/marketing.js` (the emitter) and the Origin_Server
 * (which serves them) share one definition.
 */
export const GENERATED_FILES = Object.freeze({
  robots: "robots.txt",
  sitemap: "sitemap.xml",
});
