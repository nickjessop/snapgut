// @vitest-environment node
//
// Tests that AI request logging includes only permitted fields and excludes
// sensitive content: no prompt text, no image bytes, no diary content.
//
// Validates: Requirements 4.13

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-ignore -- untyped ESM JavaScript
import { buildApp } from "../server/app.js";
// @ts-ignore -- untyped ESM JavaScript
import { loadConfig } from "../server/config.js";
// @ts-ignore -- untyped ESM JavaScript
import { signToken } from "../server/auth.js";
// @ts-ignore -- untyped ESM JavaScript
import { getStore } from "../server/store.js";
// @ts-ignore -- untyped ESM JavaScript
import { getEventStore } from "../server/eventStore.js";

type Fetch = (req: Request) => Response | Promise<Response>;

let serverFetch: Fetch;
let token: string;
let logSpy: ReturnType<typeof vi.spyOn>;

const SECRET = "test-secret-for-vitest-only-do-not-use-in-production-pad-32chars";

beforeAll(async () => {
  const { config } = loadConfig({
    DATASTORE_BACKEND: "memory",
    AI_PROVIDER: "mock",
    AUTH_PASSWORD: "test-password-123",
  });

  const store = await getStore();
  const eventStore = await getEventStore();
  const ready = { value: true };
  const ai = { name: "mock", model: "mock", generate: async () => '{"dish":"Test Meal","ingredients":[{"name":"Egg","confidence":"confident"}]}' };

  const app = buildApp({ config: config!, store, eventStore, secret: SECRET, ai, ready });
  serverFetch = app.fetch.bind(app);

  await store.upsertUser("logger@example.com");
  token = signToken("logger@example.com", SECRET);
});

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(path: string, body: any): Promise<Response> {
  return Promise.resolve(
    serverFetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
    )
  );
}

describe("AI request logging", () => {
  it("logs provider name, kind, outcome, and elapsed for recognize", async () => {
    await request("/api/recognize", {
      image: "aGVsbG8=",
      mimeType: "image/jpeg",
      note: "This is leftover pizza",
    });

    const aiCalls = logSpy.mock.calls.filter(
      (call) => call[0] === "ai"
    );
    expect(aiCalls.length).toBeGreaterThanOrEqual(1);

    const loggedObj = aiCalls[0][1];
    expect(loggedObj.provider).toBeDefined();
    expect(loggedObj.kind).toBe("recognize");
    expect(["ok", "error", "timeout"]).toContain(loggedObj.outcome);
    expect(typeof loggedObj.elapsedMs).toBe("number");
  });

  it("logs provider name, kind, outcome, and elapsed for insights", async () => {
    await request("/api/insights", {
      summary: {
        focus: "fodmap-suspect",
        mealCount: 12,
        symptomCount: 5,
        topSymptoms: [{ label: "Bloating", count: 4 }],
        associations: [{ trigger: "Garlic", symptom: "Bloating", count: 3, confidence: 0.75 }],
      },
    });

    const aiCalls = logSpy.mock.calls.filter(
      (call) => call[0] === "ai"
    );
    expect(aiCalls.length).toBeGreaterThanOrEqual(1);

    const loggedObj = aiCalls[0][1];
    expect(loggedObj.provider).toBeDefined();
    expect(loggedObj.kind).toBe("insights");
    expect(["ok", "error", "timeout"]).toContain(loggedObj.outcome);
    expect(typeof loggedObj.elapsedMs).toBe("number");
  });

  it("does NOT log prompt text", async () => {
    await request("/api/recognize", {
      image: "aGVsbG8=",
      mimeType: "image/jpeg",
      note: "Ramen with egg",
    });

    const allLoggedText = logSpy.mock.calls
      .map((call) => JSON.stringify(call))
      .join(" ");

    expect(allLoggedText).not.toContain("food recognition assistant");
    expect(allLoggedText).not.toContain("gut-health analyst");
  });

  it("does NOT log image bytes", async () => {
    const fakeImage = "VGhpcyBpcyBhIGZha2UgaW1hZ2UgZm9yIHRlc3Rpbmc=";

    await request("/api/recognize", {
      image: fakeImage,
      mimeType: "image/jpeg",
    });

    const allLoggedText = logSpy.mock.calls
      .map((call) => JSON.stringify(call))
      .join(" ");

    expect(allLoggedText).not.toContain(fakeImage);
  });

  it("does NOT log diary content (food names, symptoms)", async () => {
    await request("/api/insights", {
      summary: {
        focus: "fodmap-suspect",
        mealCount: 12,
        symptomCount: 5,
        topSymptoms: [{ label: "Severe Bloating After Dinner", count: 4 }],
        associations: [
          { trigger: "Fermented Kimchi", symptom: "Severe Bloating After Dinner", count: 3, confidence: 0.8 },
        ],
      },
    });

    const allLoggedText = logSpy.mock.calls
      .map((call) => JSON.stringify(call))
      .join(" ");

    expect(allLoggedText).not.toContain("Severe Bloating After Dinner");
    expect(allLoggedText).not.toContain("Fermented Kimchi");
  });
});
