// @vitest-environment node
//
// The Stripe webhook, end to end: renewals extend Pro, cancellations let the paid
// period run out, repeat deliveries grant nothing extra, and anything we don't act
// on is acknowledged rather than retried forever.
//
// `server/index.js` calls `serve()` at import time and exports nothing, so the
// listener boundary is stubbed and the handler it hands to `serve` is captured —
// the same technique as `src/authRateLimit.test.ts` and `src/bootGuards.test.ts`.
// That handler is the app itself: the real route, the real Plan_Catalog, and the
// real in-memory store, with no part of the billing logic replaced.
//
// The `stripe` package is stubbed because it is the only thing here that would
// otherwise reach the network. Signature verification is *not* weakened: the route
// still calls `webhooks.constructEvent` and still answers 400 when it throws — the
// stub simply decides validity from a fixed header value instead of an HMAC, which
// is what makes the 400 path assertable without the real signing secret.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Fetch = (req: Request) => Response | Promise<Response>;

const listener = vi.hoisted(() => ({ fetch: null as Fetch | null }));

/** What the stubbed `subscriptions.retrieve` returns, and the ids it was asked for. */
const stripeStub = vi.hoisted(() => ({
  subscription: null as unknown,
  retrieved: [] as string[],
}));

/** The only `stripe-signature` value the stubbed verifier accepts. */
const GOOD_SIG = "t=1,v1=accepted-by-the-stub";

vi.mock("@hono/node-server", () => ({
  serve: (options: { fetch: Fetch }) => {
    listener.fetch = options.fetch;
    return { close() {} };
  },
}));

vi.mock("@hono/node-server/serve-static", () => ({
  // There is no built `dist/` in a test run, and /api/* is registered ahead of the
  // static handlers regardless — so these pass straight through.
  serveStatic: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("stripe", () => ({
  default: class StripeStub {
    webhooks = {
      constructEvent: (raw: string, sig: string | undefined, secret: string | undefined) => {
        // Stands in for the HMAC check: a missing/wrong signature or a missing
        // signing secret throws, exactly as the real library does.
        if (!secret) throw new Error("no signing secret");
        if (sig !== GOOD_SIG) throw new Error("signature mismatch");
        return JSON.parse(raw);
      },
    };
    subscriptions = {
      retrieve: (id: string) => {
        stripeStub.retrieved.push(id);
        if (!stripeStub.subscription) throw new Error("no such subscription");
        return Promise.resolve(stripeStub.subscription);
      },
    };
  },
}));

// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import * as storeModule from "../server/store.js";
import { PLANS } from "../shared/plans.js";

interface UserRecord {
  email: string;
  pro: boolean;
  proUntil: number | null;
  stripeCustomerId: string | null;
}

interface UserStore {
  getUser(email: string): Promise<UserRecord | null>;
  upsertUser(email: string): Promise<UserRecord>;
  setPro(email: string, proUntil: number | null, customerId?: string): Promise<UserRecord | null>;
}

const userStore = storeModule.getStore as () => Promise<UserStore>;
const isPro = storeModule.isPro as (user: UserRecord | null) => boolean;

const DAY = 86_400_000;
const secs = (ms: number) => Math.floor(ms / 1000);

let appFetch: Fetch;
const savedSecret = process.env.STRIPE_SECRET_KEY;
const savedWebhook = process.env.STRIPE_WEBHOOK_SECRET;

beforeAll(async () => {
  // Both are read at module scope in `server/index.js`, so they have to be in place
  // before the import: without a key the route short-circuits to `billing_disabled`.
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_stub";
  // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
  await import("../server/index.js");
  if (!listener.fetch) throw new Error("server/index.js did not hand a fetch handler to serve()");
  appFetch = listener.fetch;
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  stripeStub.subscription = null;
  stripeStub.retrieved = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedSecret;
  if (savedWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedWebhook;
});

let seq = 0;
const nextId = () => ++seq;
const uniqueEmail = (label = "sub") => `${label}-${nextId()}@example.com`;
const uniqueCustomer = () => `cus_test${nextId()}`;

/** One webhook delivery through the real route. */
function deliver(event: unknown, sig: string | null = GOOD_SIG): Promise<Response> {
  return Promise.resolve(
    appFetch(
      new Request("http://origin.test/api/billing/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(sig === null ? {} : { "stripe-signature": sig }),
        },
        body: JSON.stringify(event),
      })
    )
  );
}

/** An existing Pro subscriber with a linked Stripe customer id. */
async function subscriber(proUntil: number | null): Promise<{ email: string; customer: string }> {
  const email = uniqueEmail();
  const customer = uniqueCustomer();
  const store = await userStore();
  await store.upsertUser(email);
  await store.setPro(email, proUntil, customer);
  return { email, customer };
}

const readUser = async (email: string): Promise<UserRecord> => {
  const user = await (await userStore()).getUser(email);
  if (!user) throw new Error("user vanished");
  return user;
};

/** A paid renewal invoice, trimmed to the fields the handler reads. */
function invoicePaidEvent(opts: {
  id?: string;
  customer?: string;
  customerEmail?: string;
  periodEndMs?: number;
  subscription?: string;
}) {
  const object: Record<string, unknown> = {
    id: "in_test",
    object: "invoice",
    customer: opts.customer,
    customer_email: opts.customerEmail,
  };
  if (opts.periodEndMs !== undefined) {
    object.lines = {
      data: [{ period: { start: secs(Date.now()), end: secs(opts.periodEndMs) } }],
    };
  }
  if (opts.subscription) object.subscription = opts.subscription;
  return { id: opts.id ?? `evt_${nextId()}`, type: "invoice.paid", data: { object } };
}

/** A `customer.subscription.deleted` event, in the pre-2025 shape. */
function subscriptionDeletedEvent(opts: {
  id?: string;
  customer: string;
  periodEndMs?: number;
  endedAtMs?: number;
}) {
  return {
    id: opts.id ?? `evt_${nextId()}`,
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_test",
        object: "subscription",
        status: "canceled",
        customer: opts.customer,
        current_period_end: opts.periodEndMs === undefined ? undefined : secs(opts.periodEndMs),
        ended_at: opts.endedAtMs === undefined ? undefined : secs(opts.endedAtMs),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Renewals (the bug: a monthly subscriber lost Pro after 31 days)
// ---------------------------------------------------------------------------

describe("invoice.paid", () => {
  it("extends Pro to the end of the period the invoice paid for", async () => {
    const nearlyUp = Date.now() + 2 * DAY;
    const { email, customer } = await subscriber(nearlyUp);
    const paidThrough = Date.now() + 33 * DAY;

    const res = await deliver(invoicePaidEvent({ customer, periodEndMs: paidThrough }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    const user = await readUser(email);
    expect(user.proUntil).toBe(secs(paidThrough) * 1000);
    expect(isPro(user)).toBe(true);
  });

  it("grants nothing extra on a repeat delivery of the same event", async () => {
    const { email, customer } = await subscriber(Date.now() + 2 * DAY);
    const paidThrough = Date.now() + 33 * DAY;
    const event = invoicePaidEvent({ customer, periodEndMs: paidThrough });

    await deliver(event);
    const afterFirst = (await readUser(email)).proUntil;
    await deliver(event); // Stripe retrying a delivery it never saw acknowledged
    await deliver(event);
    const afterRetries = (await readUser(email)).proUntil;

    // The write is a set to an absolute instant, so retries converge rather than
    // stacking another period on each time.
    expect(afterRetries).toBe(afterFirst);
    expect(afterRetries).toBeLessThan(Date.now() + 40 * DAY);
  });

  it("does not shorten Pro when an older invoice arrives late", async () => {
    const paidThrough = Date.now() + 60 * DAY;
    const { email, customer } = await subscriber(paidThrough);

    await deliver(invoicePaidEvent({ customer, periodEndMs: Date.now() + 5 * DAY }));

    expect((await readUser(email)).proUntil).toBe(paidThrough);
  });

  it("falls back to the subscription's current period end when the invoice has no lines", async () => {
    const { email, customer } = await subscriber(Date.now() + DAY);
    const paidThrough = Date.now() + 30 * DAY;
    // The 2025-03 shape, where `current_period_end` sits on the item.
    stripeStub.subscription = {
      id: "sub_live",
      items: { data: [{ current_period_end: secs(paidThrough) }] },
    };

    await deliver(invoicePaidEvent({ customer, subscription: "sub_live" }));

    expect(stripeStub.retrieved).toEqual(["sub_live"]);
    expect((await readUser(email)).proUntil).toBe(secs(paidThrough) * 1000);
  });

  it("matches the account by email and links the customer id when the id is not linked yet", async () => {
    // The first invoice of a new subscription can overtake
    // `checkout.session.completed`, so no customer id is on file yet.
    const email = uniqueEmail("fresh");
    const customer = uniqueCustomer();
    await (await userStore()).upsertUser(email);
    const paidThrough = Date.now() + 31 * DAY;

    await deliver(invoicePaidEvent({ customer, customerEmail: email, periodEndMs: paidThrough }));

    const user = await readUser(email);
    expect(user.stripeCustomerId).toBe(customer);
    expect(user.proUntil).toBe(secs(paidThrough) * 1000);
    expect(isPro(user)).toBe(true);
  });

  it("acknowledges an invoice for a customer it cannot match", async () => {
    const res = await deliver(
      invoicePaidEvent({ customer: "cus_never_seen", periodEndMs: Date.now() + 31 * DAY })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it("leaves a lifetime purchase without an expiry", async () => {
    const { email, customer } = await subscriber(null);

    await deliver(invoicePaidEvent({ customer, periodEndMs: Date.now() + 31 * DAY }));

    const user = await readUser(email);
    expect(user.proUntil).toBeNull();
    expect(isPro(user)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("customer.subscription.deleted", () => {
  it("lets the period already paid for run out instead of cutting access off", async () => {
    const paidThrough = Date.now() + 9 * DAY;
    const { email, customer } = await subscriber(paidThrough);

    const res = await deliver(subscriptionDeletedEvent({ customer, periodEndMs: paidThrough }));

    expect(res.status).toBe(200);
    const user = await readUser(email);
    expect(user.proUntil).toBe(secs(paidThrough) * 1000);
    expect(isPro(user)).toBe(true); // still Pro today, gone in nine days
  });

  it("revokes immediately when the paid period is already over (dunning cancel)", async () => {
    // Stripe only cancels for non-payment once its retry schedule is exhausted,
    // which is weeks past the period end.
    const lapsed = Date.now() - 20 * DAY;
    const { email, customer } = await subscriber(lapsed);

    await deliver(subscriptionDeletedEvent({ customer, periodEndMs: lapsed }));

    expect(isPro(await readUser(email))).toBe(false);
  });

  it("never extends Pro, even if the subscription reports a later period end", async () => {
    const held = Date.now() + 3 * DAY;
    const { email, customer } = await subscriber(held);

    await deliver(subscriptionDeletedEvent({ customer, periodEndMs: Date.now() + 300 * DAY }));

    expect((await readUser(email)).proUntil).toBe(held);
  });

  it("is a no-op on a repeat delivery", async () => {
    const paidThrough = Date.now() + 9 * DAY;
    const { email, customer } = await subscriber(paidThrough);
    const event = subscriptionDeletedEvent({ customer, periodEndMs: paidThrough });

    await deliver(event);
    const afterFirst = (await readUser(email)).proUntil;
    await deliver(event);

    expect((await readUser(email)).proUntil).toBe(afterFirst);
  });

  it("does not touch a lifetime purchase", async () => {
    const { email, customer } = await subscriber(null);

    await deliver(subscriptionDeletedEvent({ customer, periodEndMs: Date.now() - DAY }));

    const user = await readUser(email);
    expect(user.proUntil).toBeNull();
    expect(isPro(user)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The first grant, unchanged
// ---------------------------------------------------------------------------

describe("checkout.session.completed", () => {
  const checkoutEvent = (email: string, plan: string, customer?: string) => ({
    id: `evt_${nextId()}`,
    type: "checkout.session.completed",
    data: {
      object: { id: "cs_test", object: "checkout.session", customer, metadata: { email, plan } },
    },
  });

  it("grants a monthly subscriber the Plan_Catalog duration and records the customer", async () => {
    const email = uniqueEmail("checkout");
    const customer = uniqueCustomer();
    await (await userStore()).upsertUser(email);

    await deliver(checkoutEvent(email, "monthly", customer));

    const monthly = PLANS.monthly.durationMs;
    if (monthly === null) throw new Error("the monthly plan must have a duration");
    const user = await readUser(email);
    expect(user.stripeCustomerId).toBe(customer);
    expect(user.proUntil).toBeGreaterThan(Date.now() + monthly - 60_000);
    expect(user.proUntil).toBeLessThanOrEqual(Date.now() + monthly);
    expect(isPro(user)).toBe(true);
  });

  it("grants lifetime with no expiry at all", async () => {
    const email = uniqueEmail("lifetime");
    await (await userStore()).upsertUser(email);

    await deliver(checkoutEvent(email, "lifetime", uniqueCustomer()));

    const user = await readUser(email);
    expect(user.proUntil).toBeNull();
    expect(isPro(user)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

describe("delivery handling", () => {
  it("acknowledges an event type it does not handle, so Stripe stops retrying", async () => {
    const held = Date.now() + 5 * DAY;
    const { email, customer } = await subscriber(held);

    for (const type of [
      // Deliberately unhandled: a failed charge does not change what the customer
      // already paid for, and Stripe's retries either recover or end in a cancel.
      "invoice.payment_failed",
      "customer.subscription.updated",
      "payment_intent.succeeded",
    ]) {
      const res = await deliver({ id: `evt_${nextId()}`, type, data: { object: { customer } } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
    }

    expect((await readUser(email)).proUntil).toBe(held);
  });

  it("rejects a bad signature with 400 and changes nothing", async () => {
    const held = Date.now() + 2 * DAY;
    const { email, customer } = await subscriber(held);
    const event = invoicePaidEvent({ customer, periodEndMs: Date.now() + 33 * DAY });

    const forged = await deliver(event, "t=1,v1=forged");
    expect(forged.status).toBe(400);
    expect(await forged.text()).toBe("bad signature");

    const unsigned = await deliver(event, null);
    expect(unsigned.status).toBe(400);

    expect((await readUser(email)).proUntil).toBe(held);
  });

  it("asks Stripe to retry when a grant fails, rather than dropping the renewal", async () => {
    const { email, customer } = await subscriber(Date.now() + DAY);
    const store = await userStore();
    const setPro = vi
      .spyOn(store, "setPro")
      .mockRejectedValueOnce(new Error("firestore unavailable"));

    const res = await deliver(invoicePaidEvent({ customer, periodEndMs: Date.now() + 31 * DAY }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "webhook_error" });
    setPro.mockRestore();

    // The retry lands the grant, because the write is a set to an absolute instant.
    const paidThrough = Date.now() + 31 * DAY;
    await deliver(invoicePaidEvent({ customer, periodEndMs: paidThrough }));
    expect((await readUser(email)).proUntil).toBe(secs(paidThrough) * 1000);
  });

  it("never puts an address, a customer id, or a Stripe object in a response or a log", async () => {
    const { email, customer } = await subscriber(Date.now() + DAY);
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });

    const res = await deliver(invoicePaidEvent({ customer, periodEndMs: Date.now() + 31 * DAY }));
    const body = await res.text();

    expect(body).toBe(JSON.stringify({ received: true }));
    expect(body).not.toContain("@");
    expect(logged.join("\n")).toBe("billing event=invoice.paid outcome=renewal_extended");
    for (const line of logged) {
      expect(line).not.toContain(email);
      expect(line).not.toContain(customer);
    }
  });
});
