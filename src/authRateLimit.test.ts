// @vitest-environment node
//
// The auth throttle, end to end: a client-supplied forwarding header must not
// mint a fresh rate-limit bucket.
//
// Validates: Requirements 14.4, 14.7
//
// `src/clientIp.test.ts` covers the derivation in isolation. This file drives the
// real `/api/auth/request` — the middleware chain in `server/index.js`, in its
// real order, against the in-memory store — because the criterion is about the
// limiter's behaviour, not the helper's return value.
//
// `server/index.js` calls `serve()` at import time and exports nothing, so the
// listener boundary is stubbed and the handler it hands to `serve` is captured.
// That is the app itself: no route, guard, or limiter is replaced.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Fetch = (req: Request) => Response | Promise<Response>;

const listener = vi.hoisted(() => ({ fetch: null as Fetch | null }));

vi.mock("@hono/node-server", () => ({
  serve: (options: { fetch: Fetch }) => {
    listener.fetch = options.fetch;
    return { close() {} };
  },
}));

vi.mock("@hono/node-server/serve-static", () => ({
  // There is no built `dist/` in a test run, and the auth routes are registered
  // ahead of the static handlers regardless — so these pass straight through.
  serveStatic: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

/** The limit the auth middleware applies, per Client_IP, per 60 s (Req 14.5). */
const AUTH_LIMIT = 20;

let appFetch: Fetch;
const originalProxy = process.env.TRUSTED_PROXY;

beforeAll(async () => {
  // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
  await import("../server/index.js");
  if (!listener.fetch) throw new Error("server/index.js did not hand a fetch handler to serve()");
  appFetch = listener.fetch;
});

beforeEach(() => {
  // Without RESEND_API_KEY the dev path logs the verification code, which is
  // noise here (and exactly the kind of value that must stay out of assertions).
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalProxy === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = originalProxy;
});

let seq = 0;
/** A fresh address per request, so the per-email throttle never masks the per-IP one. */
const uniqueEmail = () => `spoof-${++seq}@example.com`;

/** One `POST /api/auth/request` through the real chain. */
function authRequest(headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    appFetch(
      new Request("http://origin.test/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: uniqueEmail() }),
      })
    )
  );
}

describe("auth rate limit behind a trusted proxy", () => {
  it("reaches the per-IP limit despite a rotating X-Forwarded-For", async () => {
    process.env.TRUSTED_PROXY = "cloudflare";
    const edgeIp = "203.0.113.42";

    // Every request carries a different leftmost X-Forwarded-For entry — the
    // position a client can occupy — and the same edge-set CF-Connecting-IP.
    // All of them must land in one bucket (Req 14.4).
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT; i++) {
      const res = await authRequest({
        "cf-connecting-ip": edgeIp,
        "x-forwarded-for": `10.0.0.${i}, ${edgeIp}`,
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array(AUTH_LIMIT).fill(200));

    const blocked = await authRequest({
      "cf-connecting-ip": edgeIp,
      "x-forwarded-for": `10.0.0.99, ${edgeIp}`,
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
  });

  it("does not fail requests when no trusted proxy is configured", async () => {
    delete process.env.TRUSTED_PROXY;

    // No forwarding header at all — the documented `"local"` fallback (Req 14.3).
    const direct = await authRequest({});
    expect(direct.status).toBe(200);

    // A forwarding header present but untrusted: the rightmost, proxy-assigned
    // entry keys the bucket and the request still succeeds.
    const forwarded = await authRequest({ "x-forwarded-for": "1.2.3.4, 192.0.2.9" });
    expect(forwarded.status).toBe(200);
  });
});
