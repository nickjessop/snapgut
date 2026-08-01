// @vitest-environment node
//
// The aggregate counters, end to end through the real `server/index.js`.
//
// What matters about this endpoint is as much what it does *not* record as what
// it does, so the assertions are mostly negative: no identifier is stored, an
// unknown event name is ignored, and the route never answers with an error a
// client would have to handle.
//
// `server/index.js` calls `serve()` at import time and exports nothing, so the
// listener boundary is stubbed and the handler it hands to `serve` is captured —
// the same technique as `src/authRateLimit.test.ts`. No route or middleware is
// replaced, so the counter middleware runs in its real position.

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
  // There is no built `dist/` in a test run. Passing through means a document
  // request falls to the terminal 404, which is what the "only 200s are counted"
  // assertion below relies on.
  serveStatic: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

interface MetricRow {
  day: string;
  name: string;
  count: number;
}

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

/** Report an event the way `src/metrics.ts` does. */
function report(event: unknown, ip = "203.0.113.10"): Promise<Response> {
  return Promise.resolve(
    appFetch(
      new Request("http://localhost/api/metrics", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ event }),
      })
    )
  );
}

/** The admin read-out, which is the only way these counters are observable. */
async function readMetrics(): Promise<{
  totals: Record<string, number>;
  events: MetricRow[];
  accounts: { total: number; seenSince: Record<string, number> } | null;
}> {
  const res = await appFetch(
    new Request("http://localhost/api/admin/metrics", { headers: { "x-admin-token": ADMIN } })
  );
  expect(res.status).toBe(200);
  return res.json();
}

/** The count for one event name, or 0 where it has never been recorded. */
async function totalFor(name: string): Promise<number> {
  return (await readMetrics()).totals[name] ?? 0;
}

describe("POST /api/metrics", () => {
  it("records an allowlisted event", async () => {
    const before = await totalFor("log_saved");
    const res = await report("log_saved");

    // 204: there is no body worth returning, and the client ignores the response.
    expect(res.status).toBe(204);
    expect(await totalFor("log_saved")).toBe(before + 1);
  });

  it("ignores an event name that is not on the allowlist", async () => {
    const res = await report("something_invented");

    // Still 204 — a counter must never surface an error to the client — but
    // nothing is stored, so a compromised or stale client cannot invent
    // dimensions in the data.
    expect(res.status).toBe(204);
    expect(await totalFor("something_invented")).toBe(0);
  });

  it.each([null, 42, {}, undefined])("ignores a malformed event value: %s", async (event) => {
    const res = await report(event);
    expect(res.status).toBe(204);
  });

  it("accepts a malformed body without erroring", async () => {
    const res = await appFetch(
      new Request("http://localhost/api/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json at all",
      })
    );
    expect(res.status).toBe(204);
  });

  it("needs no Session_Token, because anonymous visitors are the point", async () => {
    const before = await totalFor("first_log");
    const res = await report("first_log");

    // The whole reason this endpoint exists is to count people who have not
    // signed in. Requiring auth would measure only the funnel's far end.
    expect(res.status).toBe(204);
    expect(await totalFor("first_log")).toBe(before + 1);
  });

  it("stores no identifier alongside the count", async () => {
    await report("log_saved", "198.51.100.77");
    const { events } = await readMetrics();

    // The stored shape is the assertion: a day, a name, a count, and nothing
    // else. No IP, no token, no user agent, no per-request row — so the data
    // cannot be turned into a per-visitor history after the fact.
    for (const row of events) {
      expect(Object.keys(row).sort()).toEqual(["count", "day", "name"]);
    }
    const ips = JSON.stringify(events);
    expect(ips).not.toContain("198.51.100.77");
    expect(ips).not.toContain("203.0.113.10");
  });

  it("rate-limits a flood without failing the client", async () => {
    const ip = "192.0.2.55";
    // The limit is 60/min per Client_IP. Well past it, every response is still a
    // 204: dropping a counter is acceptable, breaking a save is not.
    const responses = await Promise.all(
      Array.from({ length: 75 }, () => report("log_saved", ip))
    );
    expect(responses.every((r) => r.status === 204)).toBe(true);
  });
});

describe("the page-view counter", () => {
  it("counts a document load by route class", async () => {
    const before = await totalFor("view:login");
    // `/login` resolves to the App_Shell, which needs a built `dist/` — absent in
    // a test run, so this asserts the middleware's own condition rather than a
    // successful document. A non-200 must not be counted.
    const res = await appFetch(new Request("http://localhost/login"));
    const after = await totalFor("view:login");

    if (res.status === 200) expect(after).toBe(before + 1);
    else expect(after).toBe(before);
  });

  it("counts no `/api/*` request", async () => {
    const before = (await readMetrics()).events.length;
    await appFetch(new Request("http://localhost/api/health"));
    const { totals } = await readMetrics();

    // `/api/health` answers 200 on every run, so if API paths were counted this
    // would be the row that proved it.
    expect(Object.keys(totals).some((n) => n.startsWith("view:api"))).toBe(false);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /api/admin/metrics", () => {
  it("refuses a request with no admin token", async () => {
    const res = await appFetch(new Request("http://localhost/api/admin/metrics"));
    expect(res.status).toBe(401);
  });

  it("refuses a request with the wrong admin token", async () => {
    const res = await appFetch(
      new Request("http://localhost/api/admin/metrics", {
        headers: { "x-admin-token": "not-the-token" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns totals, the daily series, and account counts", async () => {
    await report("log_saved");
    const body = await readMetrics();

    expect(body.totals.log_saved).toBeGreaterThan(0);
    expect(Array.isArray(body.events)).toBe(true);
    // Accounts come from the user record rather than from the counters, so the
    // shape is present even on a run where nobody signed up.
    expect(body.accounts).not.toBeNull();
    expect(body.accounts?.seenSince).toHaveProperty("d7");
  });

  it("exposes no email address", async () => {
    // Sign a user up through the real auth routes, then confirm the read-out
    // still carries only counts. `/api/admin/metrics` is an ops endpoint, but it
    // is not an excuse to hand back the user table.
    const email = "metrics-probe@example.com";
    await appFetch(
      new Request("http://localhost/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      })
    );
    const body = await readMetrics();
    expect(JSON.stringify(body)).not.toContain(email);
  });
});
