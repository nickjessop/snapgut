// @vitest-environment node
//
// The dev-server route middleware in `vite/devRoutes.js`.
//
// Validates: Requirements 7.5
//
// The middleware is exercised the way Vite exercises it: the plugin's
// `configureServer` hook is handed a stand-in server, and the connect handler it
// registers is called with a request object.
//
// The map is now one document wide. With the marketing site gone, the only source
// document a Navigation_Request can resolve to is the App_Shell, and the load-
// bearing entry is `/` — without it `npm run dev` 404s on the bare host, which is
// the one path a developer types most.

import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { appDevRoutes, devRouteFor, devRouteMap } from "../vite/devRoutes.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { APP_VIEWS, LOGIN_PATH, ROOT_PATH } from "../shared/site.js";

const APP_SHELL = "/app/index.html";

type Req = { url?: string; method?: string; headers?: Record<string, string> };

/** Run one request through the middleware and report the URL Vite would see. */
function serve(req: Req): { url: string | undefined; nexted: boolean } {
  const handlers: Array<(req: Req, res: unknown, next: () => void) => void> = [];
  appDevRoutes().configureServer({
    middlewares: { use: (fn: (typeof handlers)[number]) => handlers.push(fn) },
  });
  expect(handlers).toHaveLength(1);

  const request: Req = { method: "GET", headers: { accept: "text/html" }, ...req };
  let nexted = false;
  handlers[0](request, {}, () => {
    nexted = true;
  });
  return { url: request.url, nexted };
}

describe("devRouteFor", () => {
  it("maps the origin root to the App_Shell source", () => {
    // The regression this pins: dev must serve the app at `/` now that there is
    // no marketing/index.html for it to fall back to.
    expect(devRouteFor(ROOT_PATH)).toBe(APP_SHELL);
  });

  it("maps the Login_Route and every App_Route to the App_Shell source", () => {
    expect(devRouteFor(LOGIN_PATH)).toBe(APP_SHELL);
    for (const view of APP_VIEWS) {
      expect(devRouteFor(view.path)).toBe(APP_SHELL);
    }
    // Paths the Route_Table does not name are still App_Routes: the server
    // serves the shell for the whole prefix and the client router decides.
    expect(devRouteFor("/app/")).toBe(APP_SHELL);
    expect(devRouteFor("/app/logs/2026-01-01")).toBe(APP_SHELL);
  });

  it("ignores the query and fragment when resolving", () => {
    expect(devRouteFor("/login?next=%2Fapp%2Flogs")).toBe(APP_SHELL);
    expect(devRouteFor("/?utm_source=x#top")).toBe(APP_SHELL);
  });

  it("leaves every other path for Vite to handle", () => {
    for (const url of [
      "/api/auth/request",
      "/src/main.tsx",
      "/@vite/client",
      "/foods/apple.webp",
      "/appearance", // shares a prefix with /app but is not an App_Route
      "/privacy", // no longer served at all
      "/terms",
      "/login/", // trailing slash: the Origin_Server's 301, not dev's business
      "/nope",
      "",
    ]) {
      expect(devRouteFor(url)).toBeNull();
    }
  });

  it("derives its table from the Route_Table rather than a literal", () => {
    const map = devRouteMap();
    expect([...map.keys()].sort()).toEqual([LOGIN_PATH, ROOT_PATH].sort());
    expect(new Set(map.values())).toEqual(new Set([APP_SHELL]));
  });
});

describe("appDevRoutes middleware", () => {
  it("rewrites a navigation request and always calls next", () => {
    expect(serve({ url: ROOT_PATH })).toEqual({ url: APP_SHELL, nexted: true });
    expect(serve({ url: "/app/logs" })).toEqual({ url: APP_SHELL, nexted: true });
    expect(serve({ url: "/nope" })).toEqual({ url: "/nope", nexted: true });
  });

  it("rewrites a request with no Accept header, and a HEAD request", () => {
    expect(serve({ url: ROOT_PATH, headers: {} }).url).toBe(APP_SHELL);
    expect(serve({ url: ROOT_PATH, method: "HEAD" }).url).toBe(APP_SHELL);
  });

  it("leaves a non-document request alone", () => {
    expect(serve({ url: ROOT_PATH, headers: { accept: "application/json" } }).url).toBe(ROOT_PATH);
    expect(serve({ url: "/login", method: "POST" }).url).toBe(LOGIN_PATH);
  });
});
