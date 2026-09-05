// @vitest-environment node
//
// The Origin_Server's routes and per-class headers, driven end to end.
//
// _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 8.6, 8.9, 11.8, 12.9_
//
// Every assertion here comes from a real request: the site routes and the
// per-class header middleware are mounted on a fresh Hono app and driven with
// `app.fetch(new Request(…))`, against the real `dist/` the build emits. Nothing
// is stubbed — the documents are the ones a browser would receive, the static
// files come off disk through the same `serveStatic` the running server uses, and
// the header values are read off the finished responses rather than predicted by
// a second pass over the path.
//
// The design's route resolution table is the matrix; this file walks every row of
// it. `src/serverRouteResolution.test.ts` covers the resolver as a pure function
// and `src/serverRoutes.property.test.ts` covers its totality over generated
// paths; neither of those touches a response, which is what this file is for.
//
// Two things can only be observed on the whole server, so they are driven
// through the real `server/index.js` in the last two describes: the security
// header set of Requirement 11.1 (that middleware lives in `index.js`), and
// `/api/*` behaviour being unchanged. `index.js` calls `serve()` at import time
// and exports nothing, so the listener boundary is stubbed and the handler it
// hands to `serve` is captured — the same technique as `src/authRateLimit.test.ts`.
// No route, guard, or limiter is replaced.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { registerSiteRoutes, APP_SHELL_FILE } from "../server/routes.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { registerSiteHeaders } from "../server/headers.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { CSP } from "../server/csp.js";
import {
  LOGIN_PATH,
  MARKETING_PAGES,
  NOT_FOUND_FILE,
} from "../shared/site.js";

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

const CANONICAL_HOST = "localhost";
/** A non-canonical hostname for testing noindex behavior. */
const RUN_APP_HOST = "snapgut-3f1a2b-uc.a.run.app";

const marketingPages = MARKETING_PAGES as readonly { path: string; file: string }[];

/** Everything the emitted documents and generated files are derived from. */
const SOURCE_DIRS = ["marketing", "app", "vite"];
const SOURCE_FILES = ["vite.config.ts", "shared/site.js"];
/** The Build_Output files these assertions read. */
const OUTPUTS = [
  ...marketingPages.map((page) => page.file),
  NOT_FOUND_FILE as string,
  APP_SHELL_FILE as string,
  "robots.txt",
  "sitemap.xml",
  "manifest.webmanifest",
  "sw.js",
];

const newestMtime = (files: string[]) =>
  Math.max(...files.map((file) => statSync(file).mtimeMs));

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });

/**
 * Build only when an output is missing or older than the sources it is derived
 * from, so these assertions never run against a stale `dist/` and a normal
 * `npm test` after a build pays nothing.
 */
const buildIfStale = () => {
  const outputs = OUTPUTS.map((file) => path.join(distDir, file));
  if (!outputs.every(existsSync)) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    return;
  }
  const sources = [
    ...SOURCE_DIRS.flatMap((dir) => filesUnder(path.join(repoRoot, dir))),
    ...SOURCE_FILES.map((file) => path.join(repoRoot, file)),
  ];
  if (newestMtime(outputs) <= newestMtime(sources)) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
  }
};

const distText = (file: string) => readFileSync(path.join(distDir, file), "utf8");

let app: Hono;
let appShell = "";
let notFoundDocument = "";
let hashedAssetPath = "";

type Fetch = (req: Request) => Response | Promise<Response>;

/** One request through the mounted app. `host` decides the noindex branch. */
const request = (
  fetchApp: Fetch,
  pathname: string,
  { host = CANONICAL_HOST, ...init }: RequestInit & { host?: string } = {},
) =>
  Promise.resolve(
    fetchApp(
      new Request(`https://${host}${pathname}`, {
        ...init,
        headers: { host, ...(init.headers ?? {}) },
      }),
    ),
  );

/** A request through the fresh mount. Redirects are returned, never followed. */
const get = (pathname: string, host?: string) => request(app.fetch, pathname, { host });

/** The `script-src` directive of a policy, for the strictness assertions. */
const scriptSrc = (csp: string | null) =>
  (csp ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";

beforeAll(() => {
  buildIfStale();

  appShell = distText(APP_SHELL_FILE as string);
  notFoundDocument = distText(NOT_FOUND_FILE as string);

  const asset = readdirSync(path.join(distDir, "assets")).find((f) => f.endsWith(".js"));
  if (!asset) throw new Error("no hashed asset in dist/assets");
  hashedAssetPath = `/assets/${asset}`;

  // The fresh mount, in the order `server/index.js` uses: the per-class headers
  // wrap everything, then the Route_Table's handlers.
  app = new Hono();
  registerSiteHeaders(app);
  registerSiteRoutes(app);
}, 120_000);

describe("a Marketing_Page path (R2.2)", () => {
  it.each(marketingPages.map((page) => [page.path, page.file]))(
    "%s serves its own document with status 200",
    async (pathname, file) => {
      const res = await get(pathname as string);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(distText(file as string));
    },
  );

  it.each(marketingPages.map((page) => page.path))(
    "%s is cacheable at the edge, revalidated by the browser",
    async (pathname) => {
      const res = await get(pathname);
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=3600, must-revalidate",
      );
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      // With no publicOrigin configured, all responses get noindex
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    },
  );
});

describe("the Login_Route and every App_Route (R2.3, R3.8, R8.6)", () => {
  const shellPaths = [LOGIN_PATH, "/app", "/app/logs", "/app/insights", "/app/settings"];

  it.each([...shellPaths, "/app/logs?filter=today", "/app/unknown/deep/link"])(
    "%s serves the one App_Shell document with status 200",
    async (pathname) => {
      const res = await get(pathname);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(appShell);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    },
  );

  it.each(shellPaths)("%s is never cached without revalidation and never indexed", async (p) => {
    const res = await get(p);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});

describe("a file in the Build_Output (R2.4)", () => {
  it("serves a content-hashed asset immutably for a year", async () => {
    const res = await get(hashedAssetPath);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(distText(hashedAssetPath.slice(1)));
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // With no publicOrigin configured, all responses get noindex
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it.each(["/sw.js", "/manifest.webmanifest"])(
    "%s revalidates so a deploy is picked up",
    async (pathname) => {
      const res = await get(pathname);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    },
  );

  it("types the manifest as a web app manifest", async () => {
    const res = await get("/manifest.webmanifest");
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
  });

  it.each([
    ["/robots.txt", "text/plain; charset=utf-8"],
    ["/sitemap.xml", "application/xml; charset=utf-8"],
  ])("%s is served with a bounded cache and the right type", async (pathname, type) => {
    const res = await get(pathname);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(distText(pathname.slice(1)));
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("content-type")).toBe(type);
  });
});

describe("an unknown path (R2.5)", () => {
  const unknown = [
    "/nope",
    "/blog/first-post",
    "/pricing/extra",
    "/nonsense/",
    "/index.html.bak",
    "/assets/does-not-exist.js",
  ];

  it.each(unknown)("%s answers 404 with the not-found document", async (pathname) => {
    const res = await get(pathname);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(notFoundDocument);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it.each(unknown)("%s is never answered with the App_Shell", async (pathname) => {
    expect(await (await get(pathname)).text()).not.toBe(appShell);
  });

  it("is neither stored nor indexed", async () => {
    const res = await get("/nope");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});

describe("a trailing slash (R2.6)", () => {
  it.each([...marketingPages.map((p) => p.path).filter((p) => p !== "/"), LOGIN_PATH])(
    "%s/ redirects permanently to the path without it",
    async (pathname) => {
      const res = await get(`${pathname}/`);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(pathname);
    },
  );

  it("keeps the query string on the redirect", async () => {
    const res = await get("/privacy/?ref=footer");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/privacy?ref=footer");
  });

  it("leaves `/` alone", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(distText("index.html"));
  });

  it("answers an unknown trailing-slash path with a single 404, not a 301", async () => {
    const res = await get("/nonsense/");
    expect(res.status).toBe(404);
  });
});

describe("noindex behavior with no PUBLIC_ORIGIN (R8.9)", () => {
  const paths = ["/", "/privacy", LOGIN_PATH, "/app", "/nope"];

  it("every path carries noindex when no publicOrigin is configured", async () => {
    for (const pathname of paths) {
      const res = await get(pathname);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    }
    const redirect = await get("/privacy/");
    expect(redirect.headers.get("x-robots-tag")).toBe("noindex");
  });

  it.each(paths)("serves the same body for %s regardless of hostname", async (pathname) => {
    const [local, other] = await Promise.all([
      get(pathname).then((r) => r.text()),
      get(pathname, RUN_APP_HOST).then((r) => r.text()),
    ]);
    expect(other).toBe(local);
  });

  it("keeps the same status for each class", async () => {
    for (const [pathname, status] of [
      ["/", 200],
      [LOGIN_PATH, 200],
      ["/nope", 404],
      ["/privacy/", 301],
    ] as const) {
      expect((await get(pathname, RUN_APP_HOST)).status).toBe(status);
    }
  });
});

describe("the JSON-LD hash merge (now simplified: single CSP for all)", () => {
  it("sends the base CSP on every Marketing_Page (no hashes)", async () => {
    for (const pathname of marketingPages.map((p) => p.path)) {
      const csp = (await get(pathname)).headers.get("content-security-policy");
      expect(csp).toBe(CSP);
    }
  });

  it("sends the App_Shell a policy with no hash at all", async () => {
    for (const pathname of [LOGIN_PATH, "/app", "/app/logs"]) {
      const csp = (await get(pathname)).headers.get("content-security-policy");
      expect(csp).toBe(CSP);
      expect(csp).not.toContain("sha256-");
    }
  });

  it("keeps script-src strict on every class", async () => {
    for (const pathname of ["/", "/privacy", LOGIN_PATH, "/app", hashedAssetPath, "/nope"]) {
      const directive = scriptSrc((await get(pathname)).headers.get("content-security-policy"));
      expect(directive).toContain("'self'");
      expect(directive).not.toContain("unsafe-inline");
      expect(directive).not.toContain("unsafe-eval");
      expect(directive).not.toMatch(/https?:\/\//);
    }
  });
});

// ---- the whole server: security headers and /api/* ----
// Uses buildApp from server/app.js with a minimal deps object.

// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { buildApp } from "../server/app.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { getStore } from "../server/store.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { getEventStore } from "../server/eventStore.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { loadConfig } from "../server/config.js";

function createTestApp(overrides: Record<string, string> = {}) {
  const { config } = loadConfig({
    DATASTORE_BACKEND: "memory",
    AI_PROVIDER: "mock",
    AUTH_PASSWORD: "test-password-12345",
    ...overrides,
  });
  const store = getStore();
  const eventStore = getEventStore();
  const ready = { value: true };
  const ai = {
    name: "mock",
    model: "mock",
    generate: async () => '{"dish":"Test","ingredients":[]}',
  };
  return buildApp({ config: config!, store, eventStore, secret: "a".repeat(64), ai, ready });
}

describe("the security header set per route class (R11.8)", () => {
  let serverApp: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    serverApp = createTestApp();
  });

  const serverRequest = (pathname: string) =>
    request(serverApp.fetch, pathname, { host: CANONICAL_HOST });

  it.each([
    ["Marketing_Page", "/", 200],
    ["Login_Route", LOGIN_PATH, 200],
    ["App_Route", "/app/logs", 200],
    ["/api/*", "/api/health", 200],
    ["hashed asset", "", 200],
    ["not-found document", "/nope", 404],
  ])("%s carries every hardening header", async (_class, pathname, status) => {
    const res = await serverRequest((pathname as string) || hashedAssetPath);
    expect(res.status).toBe(status);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(self), microphone=(), geolocation=()",
    );
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    // HSTS requires requireHttps config + https request
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("`/api/*` behaviour is unchanged (R2.8, R12.5, R12.9)", () => {
  let serverApp: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    serverApp = createTestApp();
  });

  const api = (pathname: string, init?: RequestInit) =>
    request(serverApp.fetch, pathname, init);

  it("answers the health check", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("ready", true);
    expect(json).toHaveProperty("schema", 1);
  });

  it("still rejects an unauthenticated session-scoped call", async () => {
    const res = await api("/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("still applies the request-size guard", async () => {
    const res = await api("/api/recognize", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) },
      body: JSON.stringify({ image: "" }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("forbids storage of every `/api/*` response and keeps them out of the index", async () => {
    for (const pathname of ["/api/health", "/api/me", "/api/nope"]) {
      const res = await api(pathname);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    }
  });

  it("never answers an unknown `/api/*` path with the App_Shell", async () => {
    const res = await api("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toBe(appShell);
  });

  it("leaves the `/foods/*` proxy's own headers alone (R12.2)", async () => {
    const res = await api("/foods/not a slug.webp");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("Strict-Transport-Security with requireHttps (R11.1)", () => {
  it("is sent when requireHttps is on and request has x-forwarded-proto: https", async () => {
    const httpsApp = createTestApp({ REQUIRE_HTTPS: "1" });

    for (const pathname of ["/", LOGIN_PATH, "/app"]) {
      const res = await Promise.resolve(
        httpsApp.fetch(
          new Request(`https://${CANONICAL_HOST}${pathname}`, {
            headers: { host: CANONICAL_HOST, "x-forwarded-proto": "https" },
          }),
        ),
      );
      expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000");
    }
  });
});
