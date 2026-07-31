// @vitest-environment node
//
// The simulated checkout branch must be impossible in production.
//
// Without `STRIPE_SECRET_KEY`, `/api/billing/checkout` used to call
// `store.setPro(...)` and answer `{ simulated: true }` — a free Pro grant, up to
// and including Lifetime, available to any signed-in caller. Mounting the key
// closes it by configuration; these tests close it by code, so a revision that
// loses the mount refuses instead of giving Pro away.
//
// A missing Stripe key stays **Degraded**, not Fatal (docs/configuration.md): the
// server still boots and every other route class still serves. What changes is the
// answer on the billing routes.
//
// _Requirements: 18.10_
//
// Same harness as `src/bootGuards.test.ts` and `src/billingWebhook.test.ts`:
// `server/index.js` calls `serve()` at import time and exports nothing, so the
// listener boundary is stubbed and the handler it hands to `serve` is captured.
// Nothing in the billing logic is replaced.
//
// The Firestore client is stubbed to throw on construction. That is the real
// assertion behind the production case: the production Datastore_Backend is
// Firestore, so if the route reached the store at all the response would be a 500
// rather than the 503 asserted below. A refusal that cannot touch the store cannot
// write entitlement.

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
  serveStatic: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("@google-cloud/firestore", () => ({
  Firestore: class {
    constructor() {
      throw new Error("the store must not be reached on a refused checkout");
    }
  },
  FieldValue: {},
  Timestamp: {},
}));

const SESSION_SECRET = "test-only-secret";

const saved = {
  nodeEnv: process.env.NODE_ENV,
  sessionSecret: process.env.SESSION_SECRET,
  usersBackend: process.env.USERS_BACKEND,
  stripeSecret: process.env.STRIPE_SECRET_KEY,
};

function setEnv(
  name: "NODE_ENV" | "SESSION_SECRET" | "USERS_BACKEND" | "STRIPE_SECRET_KEY",
  value?: string
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Boot the server under the current environment; returns its fetch handler. */
async function boot(): Promise<Fetch> {
  vi.resetModules();
  listener.fetch = null;
  // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
  await import("../server/index.js");
  if (!listener.fetch) throw new Error("server/index.js did not hand a fetch handler to serve()");
  return listener.fetch;
}

/**
 * A session token the freshly booted server accepts. Imported *after* `boot()` so
 * it is the same `server/auth.js` instance the server is holding, under the same
 * `SESSION_SECRET`.
 */
async function token(email: string): Promise<string> {
  // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
  const auth = await import("../server/auth.js");
  return (auth.signToken as (e: string) => string)(email);
}

function checkout(appFetch: Fetch, plan: string, bearer?: string): Promise<Response> {
  return Promise.resolve(
    appFetch(
      new Request("http://origin.test/api/billing/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ plan }),
      })
    )
  );
}

beforeEach(() => {
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
  setEnv("STRIPE_SECRET_KEY", saved.stripeSecret);
  vi.resetModules();
});

/** A production revision with the Stripe key missing — the hole being closed. */
async function bootProductionWithoutStripe(): Promise<Fetch> {
  setEnv("NODE_ENV", "production");
  setEnv("SESSION_SECRET", SESSION_SECRET);
  setEnv("USERS_BACKEND", "firestore");
  setEnv("STRIPE_SECRET_KEY", undefined);
  return boot();
}

describe("checkout without a Stripe key, in production", () => {
  it("still boots — billing is Degraded, not Fatal", async () => {
    await expect(bootProductionWithoutStripe()).resolves.toBeTypeOf("function");
  });

  for (const plan of ["monthly", "annual", "lifetime"]) {
    it(`refuses to simulate the ${plan} plan and grants nothing`, async () => {
      const appFetch = await bootProductionWithoutStripe();

      const res = await checkout(appFetch, plan, await token(`buyer-${plan}@example.com`));

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: "billing_unavailable" });
      // The old branch answered with `simulated` plus a granted entitlement.
      expect(body).not.toHaveProperty("simulated");
      expect(body).not.toHaveProperty("pro");
    });
  }

  it("keeps answering 401 without a session", async () => {
    const appFetch = await bootProductionWithoutStripe();

    const res = await checkout(appFetch, "lifetime");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("leaves the portal and the webhook refusing as before", async () => {
    const appFetch = await bootProductionWithoutStripe();
    const bearer = await token("portal@example.com");

    const portal = await appFetch(
      new Request("http://origin.test/api/billing/portal", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
      })
    );
    expect(portal.status).toBe(400);
    expect(await portal.json()).toEqual({ error: "billing_disabled" });

    const hook = await appFetch(
      new Request("http://origin.test/api/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } }),
      })
    );
    expect(hook.status).toBe(400);
    expect(await hook.json()).toEqual({ error: "billing_disabled" });
  });
});

describe("checkout without a Stripe key, outside production", () => {
  it("still simulates, so local development keeps working", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("SESSION_SECRET", SESSION_SECRET);
    setEnv("USERS_BACKEND", undefined); // in-process store, as locally
    setEnv("STRIPE_SECRET_KEY", undefined);
    const appFetch = await boot();

    const email = "dev@example.com";
    // The route grants against an existing account, so create one first.
    // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
    const storeModule = await import("../server/store.js");
    const store = await (storeModule.getStore as () => Promise<{ upsertUser(e: string): unknown }>)();
    await store.upsertUser(email);

    const res = await checkout(appFetch, "monthly", await token(email));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { simulated?: boolean; pro?: boolean };
    expect(body.simulated).toBe(true);
    expect(body.pro).toBe(true);
  });
});
