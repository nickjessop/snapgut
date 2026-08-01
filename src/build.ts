/**
 * The running build's id.
 *
 * `__APP_BUILD__` is substituted at build time by the `define` in
 * `vite.config.ts`. The `typeof` guard is what makes this safe everywhere else:
 * an undeclared identifier would be a ReferenceError if read directly, but
 * `typeof` on one is not, so a context without the define (a bare `vitest` run, a
 * consumer that imports this module outside a Vite build) degrades to `"dev"`
 * rather than throwing at import time.
 */
export const APP_BUILD: string =
  typeof __APP_BUILD__ === "string" && __APP_BUILD__ ? __APP_BUILD__ : "dev";

/** Just the semver part, for places that want the short form. */
export const APP_VERSION: string = APP_BUILD.split("+")[0];
