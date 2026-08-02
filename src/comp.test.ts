// @vitest-environment node
//
// Complimentary Pro: an operator grant that bypasses Stripe.
//
// The design point worth protecting is that `comp` is a *separate field* rather than
// a `setPro` call with a far-future date. Two reasons, both asserted below: the record
// still says why an account has Pro, and revoking a comp cannot revoke a purchase.
// Collapsing them would make a gift indistinguishable from a sale in the datastore.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { entitlement, isPro } from "../server/store.js";

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

let appFetch: Fetch;
const savedAdminToken = process.env.ADMIN_TOKEN;
const ADMIN = "test-only-admin-token";

beforeAll(async () => {
  process.env.ADMIN_TOKEN = ADMIN;
  // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
  await import("../server/index.js");
  if (!listener.fetch) throw new Error("server/index.js did not hand a fetch handler to serve()");
  appFetch = listener.fetch;
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (savedAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = savedAdminToken;
  vi.resetModules();
});

let seq = 0;
const freshEmail = () => `comp-${++seq}@example.com`;

/** Create a verified account and return its session token. */
async function signUp(email: string): Promise<string> {
  const req = await appFetch(
    new Request("http://localhost/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
  );
  const { code } = (await req.json()) as { code: string };
  const res = await appFetch(
    new Request("http://localhost/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    })
  );
  return ((await res.json()) as { token: string }).token;
}

function setComp(email: string, comp?: boolean, token = ADMIN): Promise<Response> {
  return Promise.resolve(
    appFetch(
      new Request("http://localhost/api/admin/comp", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify(comp === undefined ? { email } : { email, comp }),
      })
    )
  );
}

async function me(token: string) {
  const res = await appFetch(
    new Request("http://localhost/api/me", { headers: { authorization: `Bearer ${token}` } })
  );
  return res.json() as Promise<{ pro: boolean; proUntil: number | null }>;
}

describe("isPro honours a comp grant", () => {
  it("treats a comped account as Pro with no expiry to maintain", () => {
    // The reason comp is checked before `pro`: a gift should not need a fake
    // subscription date kept alive beside it.
    expect(isPro({ comp: true, pro: false, proUntil: null })).toBe(true);
    expect(isPro({ comp: true, pro: false, proUntil: 1 })).toBe(true);
  });

  it("leaves the existing rules untouched", () => {
    expect(isPro({ pro: false })).toBe(false);
    expect(isPro({ pro: true, proUntil: null })).toBe(true); // lifetime
    expect(isPro({ pro: true, proUntil: Date.now() + 60_000 })).toBe(true);
    expect(isPro({ pro: true, proUntil: Date.now() - 60_000 })).toBe(false); // lapsed
  });

  it("ignores a comp that is not exactly true", () => {
    // Absent by default, and a truthy-but-wrong value should not grant Pro.
    for (const comp of [undefined, false, null, 0, "", "true", 1]) {
      expect(isPro({ comp, pro: false } as never)).toBe(false);
    }
  });

  it("reports Pro through the client entitlement snapshot", () => {
    // The client gates on this shape, so a comp has to reach it — not just isPro.
    expect(entitlement({ comp: true, pro: false, proUntil: null }).pro).toBe(true);
  });
});

describe("POST /api/admin/comp", () => {
  it("grants Pro without a Stripe flow", async () => {
    const email = freshEmail();
    const token = await signUp(email);
    expect((await me(token)).pro).toBe(false);

    const res = await setComp(email);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email, comp: true, pro: true });

    // The whole point: the session sees Pro immediately, through the normal path.
    expect((await me(token)).pro).toBe(true);
  });

  it("defaults to granting when comp is omitted", async () => {
    const email = freshEmail();
    await signUp(email);
    expect(await (await setComp(email)).json()).toMatchObject({ comp: true });
  });

  it("revokes on an explicit false", async () => {
    const email = freshEmail();
    const token = await signUp(email);
    await setComp(email, true);
    expect((await me(token)).pro).toBe(true);

    await setComp(email, false);
    expect((await me(token)).pro).toBe(false);
  });

  it("revoking a comp does not revoke a purchase", async () => {
    const email = freshEmail();
    const token = await signUp(email);

    // Simulate a real lifetime purchase alongside the comp.
    // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
    const { getStore } = await import("../server/store.js");
    const store = await getStore();
    await store.setPro(email, null, "cus_test_123");
    await setComp(email, true);

    await setComp(email, false);

    // Still Pro, because the purchase is untouched — and the customer id survives, so
    // a renewal webhook can still find this account.
    const after = await me(token);
    expect(after.pro).toBe(true);
    expect(after.proUntil).toBeNull();
    expect((await store.getUser(email)).stripeCustomerId).toBe("cus_test_123");
  });

  it("refuses an account that does not exist", async () => {
    // Creating one here would mint an account from an address nobody has verified.
    const res = await setComp("never-signed-up@example.com");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_account" });
  });

  it("rejects a malformed address", async () => {
    const res = await setComp("not-an-email");
    expect(res.status).toBe(400);
  });

  it("requires the admin token", async () => {
    const email = freshEmail();
    await signUp(email);

    expect((await setComp(email, true, "wrong-token")).status).toBe(401);
    const res = await appFetch(
      new Request("http://localhost/api/admin/comp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("does not grant Pro on a refused request", async () => {
    const email = freshEmail();
    const token = await signUp(email);
    await setComp(email, true, "wrong-token");
    expect((await me(token)).pro).toBe(false);
  });
});
