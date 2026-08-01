/**
 * Stands in for `virtual:pwa-register` under `vitest`.
 *
 * That module is supplied by the VitePWA plugin, so it exists in a build and not in
 * a test run — and Vite resolves both static and dynamic imports at transform time,
 * so no import style avoids the problem. `vitest.config.ts` aliases the specifier
 * here instead, which keeps `src/swUpdate.ts` honest (a plain static import, no
 * `@vite-ignore`, no indirection to defeat analysis) and makes the update path
 * testable rather than merely importable.
 *
 * Records its calls so a test can assert what registration asked for.
 */

export interface RegisterSWOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisteredSW?: (url: string, registration?: unknown) => void;
  onRegisterError?: (error: unknown) => void;
}

/** Every `registerSW` call made during a test, newest last. */
export const registerCalls: RegisterSWOptions[] = [];

/** Every `updateSW(reload)` call the app made, newest last. */
export const updateCalls: boolean[] = [];

/** Clear the record between tests. */
export function resetPwaRegisterStub(): void {
  registerCalls.length = 0;
  updateCalls.length = 0;
}

/** Hands back the update function the real module returns. */
export function registerSW(options: RegisterSWOptions = {}) {
  registerCalls.push(options);
  return async (reloadPage = false) => {
    updateCalls.push(reloadPage);
  };
}
