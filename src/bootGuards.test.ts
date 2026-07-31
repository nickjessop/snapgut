// @vitest-environment node
//
// The two configuration mistakes the Origin_Server is not allowed to survive in
// production: a missing `SESSION_SECRET`, and a Datastore_Backend that is not
// Firestore.
//
// _Requirements: 18.2, 18.3, 18.4, 18.10_
//
// Both guards run at the top of `server/index.js`, before any route is
// registered and before `serve()` is reached, so the observable behaviour is
// that importing the module throws — no listener, no traffic. That is exactly
// what these tests assert: the import is driven for real, with the process
// environment set to each misconfiguration in turn.
//
// `server/index.js` calls `serve()` at import time and exports nothing, so the
// listener boundary is stubbed and the handler it would hand to `serve` is
// captured — the same technique as `src/authRateLimit.test.ts`. Capturing it is
// what makes the negative cases meaningful: when a guard fires, nothing was
// handed over at all.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fetch = (req: Request) => Response | Promise<Response>;

const listener = vi.hoisted(() => ({ fetch: null as Fetch | null }));

vi.mock("@hono/node-server", () => ({
  serve: (options: { fetch: Fetch }) => {
    listener.fetch = options.fetch;
    return { close() {} };
  },
}));

vi.mock("@hono/node-server/serve-static", () => ({
  // There is no built `dist/` in a test run, and nothing here issues a request.
  serveStatic: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

const saved = {
  nodeEnv: process.env.NODE_ENV,
  sessionSecret: process.env.SESSION_SECRET,
  usersBackend: process.env.USERS_BACKEND,
};

/** Set or clear a variable, so "unset" is testable rather than approximated. */
function setEnv(name: "NODE_ENV" | "SESSION_SECRET" | "USERS_BACKEND", value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A fresh import of the server module under the current environment. */
async function boot(): Promise<void> {
  vi.resetModules();
  listener.fetch = null;
  // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
  await import("../server/index.js");
}

beforeEach(() => {
  // Boot logs a line or two; they are noise here.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  setEnv("NODE_ENV", saved.nodeEnv);
  setEnv("SESSION_SECRET", saved.sessionSecret);
  setEnv("USERS_BACKEND", saved.usersBackend);
  vi.resetModules();
});

describe("production boot guards", () => {
  it("refuses to boot without SESSION_SECRET (R18.4)", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("SESSION_SECRET", undefined);
    setEnv("USERS_BACKEND", "firestore");

    await expect(boot()).rejects.toThrow(/SESSION_SECRET must be set in production/);
    expect(listener.fetch).toBeNull();
  });

  it("refuses to boot when USERS_BACKEND is unset (R18.2, R18.3)", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("SESSION_SECRET", "test-only-secret");
    setEnv("USERS_BACKEND", undefined);

    await expect(boot()).rejects.toThrow(/USERS_BACKEND must be "firestore" in production/);
    expect(listener.fetch).toBeNull();
  });

  it("refuses to boot on any Datastore_Backend other than firestore (R18.3)", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("SESSION_SECRET", "test-only-secret");
    setEnv("USERS_BACKEND", "memory");

    await expect(boot()).rejects.toThrow(/USERS_BACKEND must be "firestore" in production/);
    expect(listener.fetch).toBeNull();
  });

  it("boots in production once both are configured", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("SESSION_SECRET", "test-only-secret");
    setEnv("USERS_BACKEND", "firestore");

    await expect(boot()).resolves.toBeUndefined();
    expect(listener.fetch).toBeTypeOf("function");
  });

  it("fires neither guard outside production", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("SESSION_SECRET", undefined);
    setEnv("USERS_BACKEND", undefined);

    // Local development runs against the in-process store with no secret set;
    // both guards are scoped to production so that keeps working.
    await expect(boot()).resolves.toBeUndefined();
    expect(listener.fetch).toBeTypeOf("function");
  });
});
