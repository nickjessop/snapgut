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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { registerSiteRoutes, APP_SHELL_FILE } from "../server/routes.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { registerSiteHeaders } from "../server/headers.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { CSP, reloadCspHashes } from "../server/csp.js";
import {
  CANONICAL_ORIGIN,
  LOGIN_PATH,
  MARKETING_PAGES,
  NOT_FOUND_FILE,
} from "../shared/site.js";

type Fetch = (req: Request) => Response | Promise<Response>;

const listener = vi.hoisted(() => ({ fetch: null as Fetch | null }));

vi.mock("@hono/node-server", () => ({
  serve: (options: { fetch: Fetch }) => {
    listener.fetch = options.fetch;
    return { close() {} };
  },
}));

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).hostname;
/** The `*.run.app` hostname and `www` are both Non_Canonical_Hosts (R2.7, R8.9). */
const RUN_APP_HOST = "snapgut-3f1a2b-uc.a.run.app";

const marketingPages = MARKETING_PAGES as readonly { path: string; file: string }[];

/** Everything the emitted documents and generated files are derived from. */
const SOURCE_DIRS = ["marketing", "app", "vite"];
const SOURCE_FILES = ["vite.config.ts", "shared/site.js", "shared/plans.js"];
/** The Build_Output files these assertions read. */
const OUTPUTS = [
  ...marketingPages.map((page) => page.file),
  NOT_FOUND_FILE as string,
  APP_SHELL_FILE as string,
  "csp-hashes.json",
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
/** The JSON-LD hash manifest the build emitted, keyed by Marketing_Page path. */
let cspHashes: Record<string, string[]> = {};

/** One request through the mounted app. `host` decides the Canonical_Host branch. */
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

  // `server/csp.js` reads the hash manifest at import time, which happens before
  // the build above on a cold `dist/`. Re-read it so the policy under test is the
  // one the built pages' structured data actually hashes to.
  reloadCspHashes();

  appShell = distText(APP_SHELL_FILE as string);
  notFoundDocument = distText(NOT_FOUND_FILE as string);
  cspHashes = JSON.parse(distText("csp-hashes.json"));

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
    "%s is cacheable at the edge, revalidated by the browser, and indexable",
    async (pathname) => {
      const res = await get(pathname);
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=3600, must-revalidate",
      );
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("x-robots-tag")).toBeNull();
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
    expect(res.headers.get("x-robots-tag")).toBeNull();
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
    const res = await get("/pricing/?plan=yearly");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/pricing?plan=yearly");
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

describe("a Non_Canonical_Host (R2.7, R8.9)", () => {
  const paths = ["/", "/pricing", LOGIN_PATH, "/app", "/nope"];

  it.each([RUN_APP_HOST, `www.${CANONICAL_HOST}`])(
    "%s carries noindex on every response",
    async (host) => {
      for (const pathname of paths) {
        const res = await get(pathname, host);
        expect(res.headers.get("x-robots-tag")).toBe("noindex");
      }
      const redirect = await get("/pricing/", host);
      expect(redirect.headers.get("x-robots-tag")).toBe("noindex");
    },
  );

  it.each(paths)("serves the same body for %s as the Canonical_Host does", async (pathname) => {
    const [canonical, other] = await Promise.all([
      get(pathname).then((r) => r.text()),
      get(pathname, RUN_APP_HOST).then((r) => r.text()),
    ]);
    expect(other).toBe(canonical);
  });

  it("keeps the same status for each class", async () => {
    for (const [pathname, status] of [
      ["/", 200],
      [LOGIN_PATH, 200],
      ["/nope", 404],
      ["/pricing/", 301],
    ] as const) {
      expect((await get(pathname, RUN_APP_HOST)).status).toBe(status);
    }
  });
});

describe("the JSON-LD hash merge (R11.4, R11.5)", () => {
  it("adds a Marketing_Page's own hashes to its script-src", async () => {
    // The home page is the one page with a structured-data block, so the build's
    // manifest must be non-empty for this assertion to mean anything.
    expect(cspHashes["/"]?.length ?? 0).toBeGreaterThan(0);
    const csp = (await get("/")).headers.get("content-security-policy");
    for (const hash of cspHashes["/"]) expect(scriptSrc(csp)).toContain(`'${hash}'`);
  });

  it("sends the App_Shell a policy with no hash at all", async () => {
    for (const pathname of [LOGIN_PATH, "/app", "/app/logs"]) {
      const csp = (await get(pathname)).headers.get("content-security-policy");
      expect(csp).toBe(CSP);
      expect(csp).not.toContain("sha256-");
    }
  });

  it("gives a Marketing_Page with no structured data the base policy", async () => {
    for (const pathname of marketingPages.map((p) => p.path)) {
      if ((cspHashes[pathname] ?? []).length > 0) continue;
      const csp = (await get(pathname)).headers.get("content-security-policy");
      // Not merely hash-free: never another page's hashes either.
      expect(csp).toBe(CSP);
    }
  });

  it("keeps script-src strict on every class", async () => {
    for (const pathname of ["/", "/pricing", LOGIN_PATH, "/app", hashedAssetPath, "/nope"]) {
      const directive = scriptSrc((await get(pathname)).headers.get("content-security-policy"));
      expect(directive).toContain("'self'");
      expect(directive).not.toContain("unsafe-inline");
      expect(directive).not.toContain("unsafe-eval");
      expect(directive).not.toMatch(/https?:\/\//);
    }
  });
});

// ---- the whole server: security headers and /api/* ----

describe("the security header set per route class (R11.8)", () => {
  let serverFetch: Fetch;

  beforeAll(async () => {
    // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
    await import("../server/index.js");
    if (!listener.fetch) throw new Error("server/index.js handed no fetch to serve()");
    serverFetch = listener.fetch;
  });

  it.each([
    ["Marketing_Page", "/", 200],
    ["Login_Route", LOGIN_PATH, 200],
    ["App_Route", "/app/logs", 200],
    ["/api/*", "/api/health", 200],
    ["hashed asset", "", 200],
    ["not-found document", "/nope", 404],
  ])("%s carries every hardening header", async (_class, pathname, status) => {
    const res = await request(serverFetch, (pathname as string) || hashedAssetPath);
    expect(res.status).toBe(status);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(self), microphone=(), geolocation=()",
    );
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    // HSTS is production-only; a dev or test run must not pin a hostname.
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("`/api/*` behaviour is unchanged (R2.8, R12.5, R12.9)", () => {
  let serverFetch: Fetch;

  beforeAll(async () => {
    // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
    await import("../server/index.js");
    serverFetch = listener.fetch as Fetch;
  });

  const api = (pathname: string, init?: RequestInit) =>
    request(serverFetch, pathname, init);

  it("answers the health check as it always has", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("still serves the Plan_Catalog", async () => {
    const res = await api("/api/billing/plans");
    expect(res.status).toBe(200);
    const plans = (await res.json()) as { id: string }[];
    expect(plans.length).toBeGreaterThan(0);
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
    for (const pathname of ["/api/health", "/api/billing/plans", "/api/me", "/api/nope"]) {
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
    // A bad path shape is rejected before any bucket read, so this needs no
    // credentials. What matters is that the per-class headers do not re-write it
    // as a not-found response: the proxy owns its own Cache-Control.
    const res = await api("/foods/not a slug.webp");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("Strict-Transport-Security in production (R11.1)", () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    secret: process.env.SESSION_SECRET,
    backend: process.env.USERS_BACKEND,
  };

  afterAll(() => {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved.secret;
    if (saved.backend === undefined) delete process.env.USERS_BACKEND;
    else process.env.USERS_BACKEND = saved.backend;
  });

  it("is sent on a Marketing_Page and an App_Shell response", async () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "test-only-secret";
    // Both production boot guards have to be satisfied for the module to load at
    // all (R18.3, R18.4); no request below reaches the store. `src/bootGuards.test.ts`
    // covers the refusals themselves.
    process.env.USERS_BACKEND = "firestore";
    vi.resetModules();
    // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
    await import("../server/index.js");
    const prodFetch = listener.fetch as Fetch;

    for (const pathname of ["/", LOGIN_PATH, "/app"]) {
      const res = await request(prodFetch, pathname);
      expect(res.headers.get("strict-transport-security")).toBe(
        "max-age=63072000; includeSubDomains",
      );
    }
  });
});
