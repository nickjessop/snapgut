/**
 * The Service_Worker's path sets.
 *
 * `vite.config.ts` reads these into the `workbox` block of `vite-plugin-pwa`.
 * Exported rather than inlined in the Vite config so the service-worker
 * configuration test can assert against the same values the build uses
 * (Requirement 5.8).
 *
 * With the marketing site gone, every Navigation_Request the origin answers with
 * a document is answered with the App_Shell — including `/`, which the worker can
 * now serve from the Navigation_Fallback. That is the point of the change: the
 * host itself works offline. What stays on the denylist is the surface that is
 * not a navigation at all, or where a substituted HTML body would be wrong.
 *
 * Plain ESM JavaScript, matching `server/`, `shared/`, and the rest of `vite/`.
 */

import { NOT_FOUND_FILE } from "../shared/site.js";

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
 * `workbox.globIgnores`: what never enters the Precache_Manifest.
 *
 *   - `**\/foods\/**` — thousands of illustrations; runtime-cached on demand
 *     instead, which is what keeps the install small (Requirement 5.6).
 *   - the not-found document — the Origin_Server serves it with status 404, and
 *     that status is the whole content of the response. A precached copy would
 *     be answered with 200, turning every typo back into the soft 404 that
 *     Requirement 2.5 exists to remove.
 */
export const precacheIgnores = () => ["**/foods/**", NOT_FOUND_FILE];

/**
 * `workbox.navigateFallbackDenylist`: the paths a Navigation_Request must be
 * allowed to reach the Origin_Server or the Edge for (Requirement 5.2).
 *
 * `/api/*` because an API response is never the App_Shell. `/foods/*` and
 * `/robots.txt` because they are assets, not navigations, and the fallback would
 * hand a crawler or an image element an HTML document where it asked for text or
 * an image.
 *
 * `/` is deliberately *not* here any more: it is the app, so answering it from
 * the precached shell is what makes a bare-host launch work offline.
 */
export const navigateFallbackDenylist = () => [
  /^\/api\//,
  /^\/foods\//,
  /^\/robots\.txt$/,
];
