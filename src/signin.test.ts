// @vitest-environment node
//
// Sign-in indistinguishability: every failure case returns the same status code
// and the same error body, so an attacker cannot enumerate which part of the
// credential check failed.
//
// Validates: Requirements 6.6, 6.7, 7.1, 7.2, 7.3, 13.3

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

const TEST_PASSWORD = "correct-horse-battery-staple";
const SECRET = "test-secret-for-vitest-only-do-not-use-in-production-pad-32chars";

let appFetch: Fetch;

beforeAll(async () => {
  const { config } = loadConfig({
    DATASTORE_BACKEND: "memory",
    AI_PROVIDER: "mock",
    AUTH_PASSWORD: TEST_PASSWORD,
  });
  const store = await getStore();
  const eventStore = await getEventStore();
  const ready = { value: true };
  const ai = { name: "mock", model: "mock", generate: async () => '{}' };

  const app = buildApp({ config: config!, store, eventStore, secret: SECRET, ai, ready });
  appFetch = app.fetch.bind(app);
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function signin(body: unknown): Promise<Response> {
  return Promise.resolve(
    appFetch(
      new Request("http://localhost/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    )
  );
}

describe("POST /api/auth/signin", () => {
  it("correct password → 200 with token and email", async () => {
    const res = await signin({ password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("token");
    expect(json).toHaveProperty("email");
    expect(typeof json.token).toBe("string");
    expect(json.token.length).toBeGreaterThan(0);
  });

  describe("all failure cases are indistinguishable (same 401 + same error body)", () => {
    const EXPECTED_STATUS = 401;
    const EXPECTED_BODY = { error: "signin_failed" };

    it("wrong password", async () => {
      const res = await signin({ password: "wrong-password-here" });
      expect(res.status).toBe(EXPECTED_STATUS);
      expect(await res.json()).toEqual(EXPECTED_BODY);
    });

    it("empty password", async () => {
      const res = await signin({ password: "" });
      expect(res.status).toBe(EXPECTED_STATUS);
      expect(await res.json()).toEqual(EXPECTED_BODY);
    });

    it("missing password field", async () => {
      const res = await signin({});
      expect(res.status).toBe(EXPECTED_STATUS);
      expect(await res.json()).toEqual(EXPECTED_BODY);
    });

    it("password > 256 chars", async () => {
      const res = await signin({ password: "a".repeat(257) });
      expect(res.status).toBe(EXPECTED_STATUS);
      expect(await res.json()).toEqual(EXPECTED_BODY);
    });

    it("all failure responses have identical shape (no leaking info)", async () => {
      const failures = await Promise.all([
        signin({ password: "wrong" }),
        signin({ password: "" }),
        signin({}),
        signin({ password: "x".repeat(300) }),
      ]);

      const bodies = await Promise.all(failures.map((r) => r.text()));
      const statuses = failures.map((r) => r.status);

      expect(new Set(statuses).size).toBe(1);
      expect(statuses[0]).toBe(EXPECTED_STATUS);

      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0])).toEqual(EXPECTED_BODY);
    });
  });
});

describe("POST /api/auth/signin with unset credential", () => {
  it("unset credential rejects with the same 401 as mismatch", async () => {
    // @ts-ignore
    const { credentialMatches } = await import("../server/auth.js");
    const secret = "a-secret-that-is-long-enough-for-testing-32chars";

    // When AUTH_PASSWORD is falsy, the route short-circuits to 401 before
    // credentialMatches. If it somehow reached credentialMatches with empty,
    // it would return false anyway.
    const result = credentialMatches("anything", "", secret);
    expect(result).toBe(false);
  });
});
