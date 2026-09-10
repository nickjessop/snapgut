/**
 * The pure half of the client router: URL ↔ view mapping, `next` sanitization,
 * and the single route guard.
 *
 * This module touches no browser API. It reads no `window`, no `location`, no
 * storage, and performs no navigation — `src/useRouter.ts` owns every effect.
 * That keeps the security-relevant part (Requirement 3.4) testable as a plain
 * function over strings.
 *
 * Every path comes from the Route_Table in `shared/site.js`; there are no path
 * literals here (Requirement 2.1).
 */

import {
  APP_PREFIX,
  APP_VIEWS,
  DEFAULT_APP_PATH,
  LOGIN_PATH,
  ROOT_PATH,
} from "../shared/site.js";
import type { Flow, Tab } from "./App";

/** The only `Flow` value that is addressable by URL (Requirement 16.4). */
export type AddressableFlow = Extract<Flow, "settings">;

/**
 * A resolved location. `next` on a login route is either `null` (no parameter)
 * or an already-sanitized App_Route path — an open redirect is not expressible
 * in the type, because the field never holds an absolute URL.
 */
export type Route =
  | { kind: "login"; next: string | null }
  | { kind: "app"; tab: Tab; flow: AddressableFlow | null };

/** The query parameter carrying the App_Route to return to after sign-in. */
const NEXT_PARAM = "next";

/**
 * Characters that cannot appear in an App_Route and that are the building
 * blocks of an escape from it: `%` (so no encoded variant of anything below can
 * survive), `\` (which several parsers fold to `/`), `:` and `@` (scheme and
 * authority), `?` and `#` (a `next` value is a bare path), and any whitespace or
 * control character.
 */
const FORBIDDEN_IN_NEXT = /[%\\:@?#\s]|[\u0000-\u001f\u007f]/;

/** Drop a single trailing slash, so `/app/logs/` resolves like `/app/logs`. */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/** The Route_Table entry for a path, or `undefined` if it names no view. */
function viewForPath(path: string) {
  return APP_VIEWS.find((v) => v.path === path);
}

/**
 * Resolve a pathname and search string to a Route.
 *
 * The origin root resolves to the default Addressable_View: there is no landing
 * page, so visiting the host opens the app. `formatRoute` spells that view
 * `DEFAULT_APP_PATH`, never `/`, so `useRouter` can canonicalise the URL in
 * place on boot.
 *
 * Returns `null` for anything that is neither the origin root, the Login_Route,
 * nor an App_Route — that is, a typo. The result is always a Route the
 * Route_Table contains, never a partially populated one.
 */
export function parseRoute(pathname: string, search = ""): Route | null {
  if (typeof pathname !== "string" || pathname === "") return null;
  const path = normalizePath(pathname);

  if (path === LOGIN_PATH) {
    return { kind: "login", next: readNext(search) };
  }

  const view = viewForPath(path === ROOT_PATH ? DEFAULT_APP_PATH : path);
  if (view) return { kind: "app", tab: view.tab, flow: view.flow };

  return null;
}

/** The sanitized `next` value carried by a search string, or `null` if absent. */
function readNext(search: string): string | null {
  if (typeof search !== "string" || search === "") return null;
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(
    NEXT_PARAM
  );
  if (raw === null) return null;
  return sanitizeNext(raw);
}

/** The path (plus search, where there is one) that a Route is addressed by. */
export function formatRoute(route: Route): string {
  if (route.kind === "login") {
    if (route.next === null) return LOGIN_PATH;
    const query = new URLSearchParams({ [NEXT_PARAM]: sanitizeNext(route.next) });
    return `${LOGIN_PATH}?${query.toString()}`;
  }
  const view = APP_VIEWS.find((v) => v.tab === route.tab && v.flow === route.flow);
  return view ? view.path : DEFAULT_APP_PATH;
}

/**
 * Reduce an untrusted `next` value to a path that is safe to navigate to.
 *
 * Accepted only when the value starts with the App_Route prefix, carries no
 * scheme, no authority, no `//`, no `..`, no backslash, and no percent-encoded
 * variant of any of those, and resolves to an App_Route the Route_Table
 * contains. Everything else — including `null`, `//evil.com`,
 * `https://evil.com`, `/app/../..`, `/app\\evil.com`, and `%2f%2fevil.com` —
 * collapses to `DEFAULT_APP_PATH` (Requirement 3.4).
 *
 * The return value is a path, never a URL, so no result can reach another
 * origin.
 */
export function sanitizeNext(raw: string | null): string {
  if (typeof raw !== "string" || raw === "") return DEFAULT_APP_PATH;
  if (FORBIDDEN_IN_NEXT.test(raw)) return DEFAULT_APP_PATH;
  if (raw.includes("//") || raw.includes("..")) return DEFAULT_APP_PATH;
  if (!raw.startsWith(APP_PREFIX)) return DEFAULT_APP_PATH;

  const route = parseRoute(raw);
  if (route === null || route.kind !== "app") return DEFAULT_APP_PATH;

  // Format rather than echo, so the result is the Route_Table's own spelling of
  // the view (e.g. a trailing slash is normalized away).
  return formatRoute(route);
}

/**
 * The one and only route guard (Requirement 16.1).
 *
 * Deferred sign-in has landed, so this is now unconditional: an App_Route no
 * longer requires a session, and the gate has moved to the AI call sites, which
 * ask for an email only when a request is about to be made that needs one. A
 * visitor can open the app, read the intro, and log meals, symptoms, bowel
 * movements, and check-ins without an account, because none of that touches the
 * Origin_Server.
 *
 * The parameter is kept, and `src/App.tsx` still calls this before its
 * redirect-to-login branch, so restoring the gate is a one-line change here
 * rather than a re-plumbing of the routing layer.
 */
export function mayEnterApp(_hasSession: boolean): boolean {
  return true;
}
