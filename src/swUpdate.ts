/**
 * Service worker registration, and the one thing `autoUpdate` gets wrong here.
 *
 * `registerType: "autoUpdate"` makes the generated worker call `skipWaiting()` and
 * `clientsClaim()`, and the plugin's virtual module reloads the page the moment the
 * new worker takes control. Invisible updates are the right default for a habit
 * app — nobody should be asked to approve a bug fix.
 *
 * The problem is *when* it reloads. A captured photo is an in-memory `Blob` and
 * every Ephemeral_Flow holds unsaved form input; Requirement 4.8 of the
 * marketing-site-and-routing spec exists precisely because a load cannot restore
 * either. So a reload landing mid-capture throws away the user's photo and drops
 * them back at the camera with no explanation — and it is most likely just after a
 * deploy, which is exactly when traffic is highest.
 *
 * So: keep the automatic reload, but hold it while the app says it is busy. The app
 * reports its own safety through `setSafeToReload`, and a deferred update applies
 * the moment it becomes safe.
 */

import { registerSW } from "virtual:pwa-register";

/** Whether a reload would currently lose unsaved work. */
let safe = true;
/** Set once a new worker is waiting and a reload was deferred. */
let pending = false;
/** Provided by the plugin; reloads once the new worker is controlling. */
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

/** True while an update has been downloaded and is waiting for a safe moment. */
export function updatePending(): boolean {
  return pending;
}

/**
 * Drop all module state. For tests: this module is a singleton, so a case that
 * leaves an update pending would otherwise hand it to the next one, which then
 * observes a reload it never asked for.
 */
export function resetSwUpdateForTests(): void {
  safe = true;
  pending = false;
  applyUpdate = null;
}

/**
 * Apply a deferred update, if one is waiting and it is safe. Idempotent: the flag
 * is cleared before the call so a re-entrant render cannot ask twice.
 */
function flush(): void {
  if (!pending || !safe || !applyUpdate) return;
  pending = false;
  void applyUpdate(true);
}

/**
 * Tell the updater whether a reload is currently acceptable.
 *
 * Called by `src/App.tsx` from a single derived condition, so "is the app busy" has
 * one definition rather than one per flow.
 */
export function setSafeToReload(value: boolean): void {
  safe = value;
  if (value) flush();
}

/** Register the worker. Call once, from the app entry. */
export function registerServiceWorker(): void {
  applyUpdate = registerSW({
    immediate: true,
    /**
     * Reached when a new worker has installed and is waiting. Returning without
     * calling `applyUpdate` is what defers the reload — the worker stays waiting,
     * so nothing is lost by waiting with it.
     */
    onNeedRefresh() {
      pending = true;
      flush();
    },
  });
}
