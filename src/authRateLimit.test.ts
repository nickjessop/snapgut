// @vitest-environment node
//
// The auth throttle, end to end: a client-supplied forwarding header must not
// mint a fresh rate-limit bucket.
//
// Validates: Requirements 6.9, 13.3
//
// Uses buildApp from server/app.js with a minimal deps object.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-ignore -- untyped ESM JavaScript
import { buildApp } from "../server/app.js";
// @ts-ignore -- untyped ESM JavaScript
import { loadConfig } from "../server/config.js";
// @ts-ignore -- untyped ESM JavaScript
import { getStore } from "../server/store.js";
// @ts-ignore -- untyped ESM JavaScript
import { getEventStore } from "../server/eventStore.js";

type Fetch = (req: Request) => Response | Promise<Response>;

/** The limit the auth middleware applies, per Client_IP, per 60 s (Req 6.9). */
const AUTH_LIMIT = 20;

/** The password configured in the test environment. */
const TEST_PASSWORD = "test-auth-password-for-vitest";

const SECRET = "test-secret-for-vitest-only-do-not-use-in-production-pad-32chars";

let appFetch: Fetch;

async function createApp(overrides: Record<string, string> = {}) {
  const { config } = loadConfig({
    DATASTORE_BACKEND: "memory",
    AI_PROVIDER: "mock",
    AUTH_PASSWORD: TEST_PASSWORD,
    ...overrides,
  });
  const store = await getStore();
  const eventStore = await getEventStore();
  const ready = { value: true };
  const ai = { name: "mock", model: "mock", generate: async () => '{}' };
  const app = buildApp({ config: config!, store, eventStore, secret: SECRET, ai, ready });
  return app;
}

beforeAll(async () => {
  const app = await createApp({ TRUSTED_PROXY: "cloudflare" });
  appFetch = app.fetch.bind(app);
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** One `POST /api/auth/signin` through the real chain. */
function signinRequest(fetch: Fetch, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    fetch(
      new Request("http://origin.test/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      })
    )
  );
}

describe("auth rate limit behind a trusted proxy", () => {
  it("reaches the per-IP limit despite a rotating X-Forwarded-For", async () => {
    const edgeIp = "203.0.113.42";

    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT; i++) {
      const res = await signinRequest(appFetch, {
        "cf-connecting-ip": edgeIp,
        "x-forwarded-for": `10.0.0.${i}, ${edgeIp}`,
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array(AUTH_LIMIT).fill(200));

    const blocked = await signinRequest(appFetch, {
      "cf-connecting-ip": edgeIp,
      "x-forwarded-for": `10.0.0.99, ${edgeIp}`,
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
  });

  it("does not fail requests when no trusted proxy is configured", async () => {
    // Create an app with no trusted proxy
    const noProxyApp = await createApp({ TRUSTED_PROXY: "none" });
    const noProxyFetch = noProxyApp.fetch.bind(noProxyApp);

    const direct = await signinRequest(noProxyFetch, {});
    expect(direct.status).toBe(200);

    const forwarded = await signinRequest(noProxyFetch, { "x-forwarded-for": "1.2.3.4, 192.0.2.9" });
    expect(forwarded.status).toBe(200);
  });
});
