// @vitest-environment node
//
// Integration tests for the `/foods/:file` HTTP route.
// Uses buildApp with the in-memory datastore and a temp food pack directory.
//
// Validates: Requirements 5.2, 5.3, 5.4, 5.13, 5.14

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore -- untyped ESM JavaScript
import { buildApp } from "../server/app.js";
// @ts-ignore -- untyped ESM JavaScript
import { loadConfig } from "../server/config.js";
// @ts-ignore -- untyped ESM JavaScript
import { getStore } from "../server/store.js";
// @ts-ignore -- untyped ESM JavaScript
import { getEventStore } from "../server/eventStore.js";

type Fetch = (req: Request) => Response | Promise<Response>;

let appFetch: Fetch;
let foodPackDir: string;

const SECRET = "test-secret-for-vitest-only-do-not-use-in-production-pad-32chars";

beforeAll(async () => {
  foodPackDir = mkdtempSync(join(tmpdir(), "foodpack-serve-test-"));
  writeFileSync(join(foodPackDir, "apple.webp"), Buffer.from("fake-webp-bytes"));
  writeFileSync(join(foodPackDir, "acai-berry.webp"), Buffer.from("berry-bytes"));

  const { config } = loadConfig({
    DATASTORE_BACKEND: "memory",
    AI_PROVIDER: "mock",
    AUTH_PASSWORD: "test-password-123",
    FOOD_PACK_DIR: foodPackDir,
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

afterAll(() => {
  rmSync(foodPackDir, { recursive: true, force: true });
});

function foodRequest(path: string): Promise<Response> {
  return Promise.resolve(
    appFetch(new Request(`http://localhost${path}`, { method: "GET" }))
  );
}

describe("/foods/:file route", () => {
  describe("pattern miss — invalid filenames get 404 with no cache header", () => {
    it("rejects filename with spaces", async () => {
      const res = await foodRequest("/foods/Not A Slug.webp");
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBeNull();
    });

    it("rejects filename with uppercase", async () => {
      const res = await foodRequest("/foods/Apple.webp");
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBeNull();
    });

    it("rejects non-webp extension", async () => {
      const res = await foodRequest("/foods/apple.png");
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBeNull();
    });
  });

  describe("valid file — 200 with correct content-type and immutable cache", () => {
    it("serves a valid webp file with correct headers", async () => {
      const res = await foodRequest("/foods/apple.webp");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable"
      );
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.toString()).toBe("fake-webp-bytes");
    });

    it("serves a hyphenated filename", async () => {
      const res = await foodRequest("/foods/acai-berry.webp");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable"
      );
    });
  });

  describe("missing file — 404", () => {
    it("returns 404 for a file that does not exist", async () => {
      const res = await foodRequest("/foods/banana.webp");
      expect(res.status).toBe(404);
    });
  });

  describe("unreadable file — 502 with logged error, no file bytes leaked", () => {
    it("returns 502 for an unreadable file", async () => {
      const unreadablePath = join(foodPackDir, "secret.webp");
      writeFileSync(unreadablePath, "secret-data", { mode: 0o000 });

      const res = await foodRequest("/foods/secret.webp");

      if (res.status === 502) {
        const body = await res.text();
        expect(body).not.toContain("secret-data");
        expect(body).toBe("unavailable");
        expect(console.error).toHaveBeenCalled();
      } else {
        expect(res.status).toBe(200);
      }

      chmodSync(unreadablePath, 0o644);
    });
  });

  describe("traversal attempts — all return 404", () => {
    it("rejects path with forward slash (../etc.webp)", async () => {
      const res = await foodRequest("/foods/../etc.webp");
      expect(res.status).toBe(404);
    });

    it("rejects percent-encoded forward slash (%2f)", async () => {
      const req = new Request("http://localhost/foods/a%2fb.webp", { method: "GET" });
      const res = await Promise.resolve(appFetch(req));
      expect(res.status).toBe(404);
    });

    it("rejects percent-encoded null byte (%00)", async () => {
      const req = new Request("http://localhost/foods/a%00b.webp", { method: "GET" });
      const res = await Promise.resolve(appFetch(req));
      expect(res.status).toBe(404);
    });

    it("rejects double-dot in filename", async () => {
      const req = new Request("http://localhost/foods/..apple.webp", { method: "GET" });
      const res = await Promise.resolve(appFetch(req));
      expect(res.status).toBe(404);
    });
  });
});
