// @vitest-environment node
//
// Tests that non-JSON model output is gracefully handled:
// - For recognize: yields `{ dish: "Meal", ingredients: [] }` with annotation applied
// - For insights: yields `{ headline: "Insight", body: <raw text> }`
//
// Validates: Requirements 4.9, 4.16

import { beforeAll, describe, expect, it, vi } from "vitest";

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

const mockGenerate = vi.fn();
const SECRET = "test-secret-for-vitest-only-do-not-use-in-production-pad-32chars";

let serverFetch: Fetch;
let token: string;

beforeAll(async () => {
  const { config } = loadConfig({
    DATASTORE_BACKEND: "memory",
    AI_PROVIDER: "mock",
    AUTH_PASSWORD: "test-password-123",
  });

  const store = await getStore();
  const eventStore = await getEventStore();
  const ready = { value: true };
  const ai = { name: "mock-malformed", model: "test", generate: mockGenerate };

  const app = buildApp({ config: config!, store, eventStore, secret: SECRET, ai, ready });
  serverFetch = app.fetch.bind(app);

  await store.upsertUser("test@example.com");
  token = signToken("test@example.com", SECRET);
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

describe("non-JSON model output for /api/recognize", () => {
  it("returns fallback dish 'Meal' with empty ingredients when AI returns non-JSON", async () => {
    mockGenerate.mockResolvedValue("I can't recognize this food in the image");

    const res = await request("/api/recognize", {
      image: "aGVsbG8=",
      mimeType: "image/jpeg",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dish).toBe("Meal");
    expect(Array.isArray(body.ingredients)).toBe(true);
  });

  it("does not return an error status for non-JSON output", async () => {
    mockGenerate.mockResolvedValue("Sorry, I cannot process this image.");

    const res = await request("/api/recognize", {
      image: "aGVsbG8=",
      mimeType: "image/jpeg",
    });

    expect(res.status).toBe(200);
  });
});

describe("non-JSON model output for /api/insights", () => {
  it("returns fallback headline 'Insight' with raw text as body", async () => {
    const rawText = "I don't have enough data to provide meaningful insights yet.";
    mockGenerate.mockResolvedValue(rawText);

    const res = await request("/api/insights", {
      summary: { focus: "insufficient-data", mealCount: 2, symptomCount: 1 },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headline).toBe("Insight");
    expect(body.body).toBe(rawText);
  });

  it("does not return an error status for non-JSON output", async () => {
    mockGenerate.mockResolvedValue("Here are some thoughts about your gut health...");

    const res = await request("/api/insights", {
      summary: { focus: "gut-brain" },
    });

    expect(res.status).toBe(200);
  });
});
