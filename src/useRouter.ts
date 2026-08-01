/**
 * The effectful half of the client router: the two-way binding between the
 * browser URL and the `Tab`/`Flow` state machine in `src/App.tsx`.
 *
 * `src/routes.ts` owns every pure decision — what a path means, how a view is
 * spelled, what a `next` value is allowed to be. This module owns the three
 * effects that touch `window.history`:
 *
 *  1. **URL → state.** On mount, when routing becomes enabled, and on every
 *     `popstate`, the current URL is parsed and applied to the view state
 *     (Requirement 4.3).
 *  2. **State → URL.** A user-initiated view change pushes exactly one history
 *     entry (Requirement 4.2); a guard-driven redirect replaces the current
 *     entry instead, so a boot redirect leaves nothing to go back to.
 *  3. **The Ephemeral_Flow sentinel.** Opening a flow pushes one entry whose
 *     state carries a marker and whose URL is unchanged (Requirement 4.5); a
 *     backward navigation onto an unmarked entry while that flow is open runs
 *     the flow's existing cancel path rather than navigating away from the
 *     App_Shell (Requirement 4.6).
 *
 * No route is ever mapped to an Ephemeral_Flow (Requirement 4.4), so a load can
 * never restore a flow whose in-memory photo `Blob` or unsaved form input is
 * gone (Requirement 4.8).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatRoute, parseRoute, type Route } from "./routes";
import type { Flow, Tab } from "./App";

/**
 * The shape of a history entry's state. The single optional marker distinguishes
 * a sentinel entry pushed for an Ephemeral_Flow from a real view entry; nothing
 * else is stored in history, so no state a reload cannot reconstruct lives there.
 */
export type HistoryState = { flow?: true } | null;

/** An App_Route, narrowed out of the `Route` union for the callback below. */
export type AppRoute = Extract<Route, { kind: "app" }>;

/**
 * The `Flow` values that hold data a reload cannot reconstruct, and therefore
 * have no URL. `settings` is excluded because it is addressable: it is a `Flow`
 * only as an artifact of how it is rendered (Requirement 16.4).
 */
export function isEphemeralFlow(flow: Flow): flow is Exclude<Flow, null | "settings"> {
  return flow !== null && flow !== "settings";
}

export type UseRouterOptions = {
  /** The tab currently displayed. */
  tab: Tab;
  /** The flow currently open, or `null`. */
  flow: Flow;
  /**
   * Whether the URL and the view state should track each other. Pass `false`
   * while the session is being validated or while the app is signed out, so the
   * pre-auth placeholder and the sign-in screen leave the URL alone
   * (Requirements 3.6, 3.7). Flipping it to `true` re-applies the current URL,
   * which is what makes a deep link survive the boot gate.
   */
  enabled?: boolean;
  /** Apply a URL-derived App_Route to the view state. */
  onRoute: (route: AppRoute) => void;
  /** Run the open flow's existing cancel path, unchanged. */
  onCancelFlow: () => void;
};

export type Router = {
  /**
   * What the current URL resolves to, or `null` where it names neither the
   * Login_Route nor an App_Route. Updated on `popstate` and on every navigation
   * this hook performs.
   */
  route: Route | null;
  /** A user-initiated navigation: adds exactly one history entry. */
  navigate: (route: Route) => void;
  /** A guard-driven redirect: replaces the current entry, adding none. */
  redirect: (route: Route) => void;
};

/** The address of the current entry, in the form `formatRoute` produces. */
function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/** True while the current history entry is an Ephemeral_Flow sentinel. */
function onSentinelEntry(): boolean {
  const state = window.history.state as HistoryState;
  return state?.flow === true;
}

export function useRouter(options: UseRouterOptions): Router {
  const { tab, flow, enabled = true } = options;

  const [route, setRoute] = useState<Route | null>(() =>
    parseRoute(window.location.pathname, window.location.search)
  );

  // The listener registers once, so it reads the live callbacks and view state
  // through a ref rather than closing over a stale render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /**
   * False while the URL is authoritative and the view state has not caught up
   * yet — the window between a URL-first write and the render that applies it.
   * Every URL-first write opens that window: the boot URL, a `popstate`, and
   * `navigate`/`redirect`, all of which set the URL and then hand `onRoute` the
   * job of moving the state to match. The state → URL effect stays quiet in that
   * window, otherwise booting at `/app/settings` would immediately push `/app`
   * over the top of it, and a view change committed one render behind a
   * navigation would be pushed as if it were a new one.
   */
  const syncedRef = useRef(false);

  /**
   * Set when the next state → URL sync must replace rather than push: after a
   * backward navigation has already consumed the sentinel entry, correcting the
   * URL must not add a new one.
   */
  const replaceNextRef = useRef(false);

  const write = useCallback((mode: "push" | "replace", url: string, state: HistoryState) => {
    if (mode === "push") window.history.pushState(state, "", url);
    else window.history.replaceState(state, "", url);
    // A write made *from* the current view state puts the two in step, so the next
    // mismatch is a real view change rather than the tail of a boot redirect. The
    // URL-first callers — `navigate` and `redirect` — clear this again immediately,
    // because for them the state is the side that still has to catch up.
    syncedRef.current = true;
    setRoute(parseRoute(window.location.pathname, window.location.search));
  }, []);

  const navigate = useCallback(
    (target: Route) => {
      write("push", formatRoute(target), null);
      // The URL leads again: `onRoute` only *schedules* the matching view state,
      // so until a render observes it the two are out of step for the same reason
      // they are at boot. Marking that explicitly is what stops an intermediate
      // render — one that carries an earlier pending update and not this
      // target — from being mistaken for a fresh view change and pushed.
      syncedRef.current = false;
      if (target.kind === "app") optionsRef.current.onRoute(target);
    },
    [write]
  );

  const redirect = useCallback(
    (target: Route) => {
      write("replace", formatRoute(target), null);
      // Same reasoning as `navigate`: the write is URL-first, so the state has
      // not caught up yet.
      syncedRef.current = false;
      if (target.kind === "app") optionsRef.current.onRoute(target);
    },
    [write]
  );

  // ---- Effect 1: URL → state, at boot and whenever routing becomes enabled ----
  useEffect(() => {
    if (!enabled) return;
    const parsed = parseRoute(window.location.pathname, window.location.search);
    setRoute(parsed);
    // The URL leads until the view state matches it.
    syncedRef.current = false;
    if (parsed?.kind === "app") optionsRef.current.onRoute(parsed);
  }, [enabled]);

  // ---- Effect 3: the Ephemeral_Flow sentinel, on backward navigation ----
  useEffect(() => {
    function onPopState() {
      const { enabled: on = true, flow: openFlow, onRoute, onCancelFlow } = optionsRef.current;
      const parsed = parseRoute(window.location.pathname, window.location.search);
      setRoute(parsed);
      if (!on) return;

      const sentinel = onSentinelEntry();

      if (isEphemeralFlow(openFlow) && !sentinel) {
        // Left the sentinel entry with a flow still open: cancel the flow
        // instead of navigating. The entry we landed on is the one the flow was
        // opened from, so its URL is already the right one and the App_Shell is
        // never left (Requirement 4.6). Any view correction the cancel path makes
        // replaces that entry rather than adding one.
        replaceNextRef.current = true;
        onCancelFlow();
        return;
      }

      if (sentinel) {
        // A forward navigation back onto a sentinel entry. Its URL equals the
        // view's own App_Route and the flow's in-memory data is gone, so there is
        // nothing to restore and nothing to change (Requirement 4.8).
        return;
      }

      if (parsed?.kind === "app") {
        syncedRef.current = false;
        onRoute(parsed);
      }
      // A `null` route means the entry belongs to the Marketing_Site rather than
      // the App_Shell. A backward navigation to it is a document load the browser
      // owns, so it is allowed to proceed untouched (Requirement 4.7).
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // ---- Effect 2: state → URL ----
  useEffect(() => {
    if (!enabled) return;
    const replace = replaceNextRef.current;
    replaceNextRef.current = false;

    if (isEphemeralFlow(flow)) {
      // Opening a flow: one marked entry at the unchanged URL, so the back
      // gesture has something to land on that is not the Marketing_Site
      // (Requirement 4.5). Re-runs while the same flow stays open are no-ops.
      if (!onSentinelEntry()) write("push", currentUrl(), { flow: true });
      return;
    }

    const target = formatRoute({ kind: "app", tab, flow });

    if (onSentinelEntry()) {
      // The flow ended through the UI. Consume its sentinel entry rather than
      // stacking a second one on top of it.
      write("replace", target, null);
      syncedRef.current = true;
      return;
    }

    if (target === currentUrl()) {
      syncedRef.current = true;
      return;
    }
    // While the URL still leads, a mismatch means the view state has not caught
    // up yet — not a view change to record.
    if (!syncedRef.current) return;

    write(replace ? "replace" : "push", target, null);
  }, [enabled, tab, flow, write]);

  return { route, navigate, redirect };
}

export default useRouter;
