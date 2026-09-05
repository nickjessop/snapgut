// @vitest-environment node
//
// The dev-server route middleware in `vite/devRoutes.js`.
//
// Validates: Requirements 7.5
//
// The middleware is exercised the way Vite exercises it: the plugin's
// `configureServer` hook is handed a stand-in server, and the connect handler it
// registers is called with a request object.

import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { devRouteFor, devRouteMap, marketingDevRoutes } from "../vite/devRoutes.js";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { marketingPartials } from "../vite/partials.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { APP_VIEWS, LOGIN_PATH, MARKETING_PAGES, marketingPaths } from "../shared/site.js";

const APP_SHELL = "/app/index.html";

type Req = { url?: string; method?: string; headers?: Record<string, string> };

/** Run one request through the middleware and report the URL Vite would see. */
function serve(req: Req): { url: string | undefined; nexted: boolean } {
  const handlers: Array<(req: Req, res: unknown, next: () => void) => void> = [];
  marketingDevRoutes().configureServer({
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

  it("maps each Marketing_Page path to its source file", () => {
    for (const page of MARKETING_PAGES) {
      expect(devRouteFor(page.path)).toBe(`/marketing/${page.file}`);
    }
  });

  it("ignores the query and fragment when resolving", () => {
    expect(devRouteFor("/login?next=%2Fapp%2Flogs")).toBe(APP_SHELL);
    expect(devRouteFor("/privacy?ref=footer#data")).toBe("/marketing/privacy.html");
  });

  it("leaves every other path for Vite to handle", () => {
    for (const url of [
      "/api/auth/request",
      "/src/main.tsx",
      "/@vite/client",
      "/foods/apple.webp",
      "/appearance", // shares a prefix with /app but is not an App_Route
      "/pricing/", // trailing slash: not a known route, dev does not fake that
      "/pricing", // no longer a marketing page
      "/nope",
      "",
    ]) {
      expect(devRouteFor(url)).toBeNull();
    }
  });

  it("derives its table from the Route_Table rather than a literal", () => {
    const map = devRouteMap();
    expect([...map.keys()].sort()).toEqual([...marketingPaths(), LOGIN_PATH].sort());
  });
});

describe("marketingDevRoutes middleware", () => {
  it("rewrites a navigation request and always calls next", () => {
    expect(serve({ url: "/privacy" })).toEqual({ url: "/marketing/privacy.html", nexted: true });
    expect(serve({ url: "/app/logs" })).toEqual({ url: APP_SHELL, nexted: true });
    expect(serve({ url: "/nope" })).toEqual({ url: "/nope", nexted: true });
  });

  it("rewrites a request with no Accept header, and a HEAD request", () => {
    expect(serve({ url: "/", headers: {} }).url).toBe("/marketing/index.html");
    expect(serve({ url: "/", method: "HEAD" }).url).toBe("/marketing/index.html");
  });

  it("leaves a non-document request alone", () => {
    expect(serve({ url: "/", headers: { accept: "application/json" } }).url).toBe("/");
    expect(serve({ url: "/login", method: "POST" }).url).toBe(LOGIN_PATH);
  });
});

describe("the rewritten URL still resolves the right page for the partials plugin", () => {
  const root = process.cwd();
  const transform = marketingPartials({ root }).transformIndexHtml.handler;

  it("substitutes each page's own metadata after the rewrite", () => {
    for (const page of MARKETING_PAGES) {
      const source = devRouteFor(page.path)!;
      const html = transform("<head><!--#include head--></head>", {
        filename: path.join(root, source),
        path: source,
      });
      expect(html).toContain(`<title>${page.title}</title>`);
    }
  });

  it("leaves the App_Shell untouched after the rewrite", () => {
    const html = transform("<title>SnapGut</title>", {
      filename: path.join(root, devRouteFor(LOGIN_PATH)!),
      path: devRouteFor(LOGIN_PATH)!,
    });
    expect(html).toBeUndefined();
  });
});
