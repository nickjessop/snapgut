/**
 * The Service_Worker's path sets, derived from the Route_Table.
 *
 * `vite.config.ts` reads these into the `workbox` block of `vite-plugin-pwa`, so
 * adding a Marketing_Page stays a single Route_Table entry: the new document is
 * kept out of the Precache_Manifest and out of Navigation_Fallback handling
 * without a second edit here (Requirements 5.2, 5.3, 16.2).
 *
 * Exported rather than inlined in the Vite config so the service-worker
 * configuration test can assert against the same values the build uses
 * (Requirement 5.8).
 *
 * Plain ESM JavaScript, matching `server/`, `shared/`, and the rest of `vite/`.
 */

import { MARKETING_PAGES, NOT_FOUND_FILE, marketingPaths } from "../shared/site.js";
import { GENERATED_FILES } from "./marketing.js";

/** The App_Shell document inside the Build_Output. */
export const APP_SHELL_DOCUMENT = "app/index.html";

/**
 * The Navigation_Fallback document (Requirement 5.1). Root-absolute so it
 * resolves the same way from any depth; Workbox looks it up in the
 * Precache_Manifest, where the App_Shell stays because none of the ignores
 * below match `app/index.html`.
 */
export const NAVIGATE_FALLBACK = `/${APP_SHELL_DOCUMENT}`;

/**
 * Every document the Marketing_Site emits, as a `globIgnores` pattern. These are
 * root-level names, so they cannot match the App_Shell at `app/index.html`.
 *
 * The not-found document is in the set for the same reason the pages are: it is
 * a Marketing_Site document served by the Origin_Server with a 404 status, and a
 * precached copy would be a stale body the worker could answer with.
 */
export const marketingDocumentGlobs = () => [
  ...MARKETING_PAGES.map((page) => page.file),
  NOT_FOUND_FILE,
];

/**
 * `workbox.globIgnores`: what never enters the Precache_Manifest.
 *
 *   - `**\/foods\/**` — thousands of illustrations; runtime-cached on demand
 *     instead, which is what keeps the install small (Requirement 5.6).
 *   - the Marketing_Site documents — so the worker never answers `/` from cache
 *     and a copy edit is visible on the next load (Requirements 5.3, 5.4).
 *   - `csp-hashes.json` and `size-report.json` — build metadata for the server
 *     and the budget test, never fetched by a client. The default
 *     `globPatterns` do not match `.json` today, so naming them keeps them out
 *     if those patterns ever widen.
 */
export const precacheIgnores = () => [
  "**/foods/**",
  ...marketingDocumentGlobs(),
  GENERATED_FILES.cspHashes,
  GENERATED_FILES.sizeReport,
];

/** Escape a Route_Table path for literal use inside a regular expression. */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One anchored pattern per Marketing_Page path. The optional trailing slash
 * matters: without it a Navigation_Request for `/pricing/` inside a controlled
 * client would be answered with the App_Shell from precache instead of reaching
 * the Origin_Server's trailing-slash redirect.
 */
export const marketingPathPatterns = () =>
  marketingPaths().map((path) => new RegExp(`^${escapeRe(path)}${path === "/" ? "" : "/?"}$`));

/**
 * `workbox.navigateFallbackDenylist`: the paths a Navigation_Request must be
 * allowed to reach the Origin_Server or the Edge for (Requirement 5.2).
 *
 * `/api/*` because an API response is never the App_Shell; the Marketing_Pages
 * because they are the acquisition surface and must stay fresh; `/foods/*` and
 * the generated crawler files because they are assets, not navigations, and the
 * fallback would hand a crawler an HTML document where it asked for text or XML.
 */
export const navigateFallbackDenylist = () => [
  /^\/api\//,
  ...marketingPathPatterns(),
  /^\/foods\//,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
];
