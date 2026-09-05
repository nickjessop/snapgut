/**
 * The Standalone_Launch redirect for the marketing home page (task 6.2).
 *
 * A Legacy_Install captured `start_url: "/"` in its manifest, and iOS does not
 * re-read the manifest of an already-installed app. So the launch of such an
 * install lands on `/` — the marketing home page — rather than on the app. This
 * module is the one thing standing between that user and a landing page where
 * their app used to be: on a Standalone_Launch of `/` it replaces the current
 * history entry with the default App_Route (Requirement 6.4).
 *
 * Four constraints shape it:
 *
 *   - **A file, never inline** (Requirements 6.5, 11.3). The marketing CSP is
 *     `script-src 'self'` plus the hashes of the pages' `application/ld+json`
 *     blocks, with no `'unsafe-inline'`. Vite builds this module to a hashed
 *     same-origin asset under `/assets/`, and `marketing/index.html` references
 *     it from `<head>` so it runs before the landing page paints anything a
 *     Legacy_Install would see.
 *
 *   - **Referenced from `/` only** (Requirement 6.5). No other Marketing_Page
 *     loads it, and the `pathname` guard below means that even if one did, it
 *     would still redirect nowhere.
 *
 *   - **Zero redirects otherwise** (Requirement 6.6, Decision D5). A browser
 *     visit to `/` stays on the marketing page whether or not a Session_Token is
 *     held — this module never looks at one. It reads no storage of any kind,
 *     which is also what Requirement 1.7 asks of the Marketing_Site.
 *
 *   - **A throw cannot break the page** (Requirement 6.7). Every access is
 *     inside `runStandaloneRedirect`'s `try`, so a browser without
 *     `matchMedia`, or one that throws on the query, leaves the page readable
 *     and performs no redirect.
 *
 * The detection duplicates `isStandalone` in `src/InstallHint.tsx` rather than
 * importing it, because the marketing bundle must not pull anything out of
 * `src/` (Requirement 7.7). `APP_PATH` likewise duplicates `DEFAULT_APP_PATH`
 * from the Route_Table rather than importing `shared/site.js`, which would drag
 * the whole page catalog into a browser bundle whose entire job is one string;
 * `src/standaloneRedirect.test.ts` asserts the two stay equal.
 */

/** The only path this redirect fires from: the marketing home page. */
export const HOME_PATH = "/";

/** Where a Standalone_Launch is sent — kept equal to `DEFAULT_APP_PATH`. */
export const APP_PATH = "/app";

/** The display mode an installed launch reports. */
export const STANDALONE_QUERY = "(display-mode: standalone)";

/**
 * The slice of `window` this module touches. Narrow on purpose: it documents
 * that nothing here reads storage or a cookie, and it lets the tests hand in a
 * plain object instead of standing up a whole environment.
 */
export interface StandaloneWindow {
  matchMedia?: (query: string) => { matches: boolean } | null | undefined;
  navigator?: { standalone?: boolean } | null;
  location: { pathname: string; replace: (url: string) => void };
}

/**
 * True for a Standalone_Launch: the standard display-mode query, or the
 * non-standard `navigator.standalone` that iOS Safari sets for a home-screen
 * launch. Same two checks, in the same order, as `src/InstallHint.tsx`.
 */
export function isStandaloneLaunch(win: StandaloneWindow): boolean {
  if (win.matchMedia?.(STANDALONE_QUERY)?.matches === true) return true;
  return win.navigator?.standalone === true;
}

/**
 * The path to redirect to, or `null` to stay put. `null` for every ordinary
 * browser load, and `null` for a Standalone_Launch of anything other than `/` —
 * the app's own routing owns those (Requirement 6.3).
 */
export function redirectTarget(win: StandaloneWindow): string | null {
  if (win.location.pathname !== HOME_PATH) return null;
  if (!isStandaloneLaunch(win)) return null;
  return APP_PATH;
}

/**
 * Perform the redirect if this load calls for one. Returns whether it did, which
 * is what the tests assert on.
 *
 * `replace`, not `assign`: the landing page must not become a back-button
 * destination inside the installed app (Requirement 6.4).
 *
 * The `catch` is deliberately silent. There is nowhere useful to report to on a
 * static page, and the fallback behavior — render the marketing page, which has
 * its own control into the app — is correct rather than merely tolerable.
 */
export function runStandaloneRedirect(win: StandaloneWindow): boolean {
  try {
    const target = redirectTarget(win);
    if (target === null) return false;
    win.location.replace(target);
    return true;
  } catch {
    return false;
  }
}

runStandaloneRedirect(window as unknown as StandaloneWindow);
