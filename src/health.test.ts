// @vitest-environment node
//
// The /api/health route: not-ready then ready (Req 9.7).
//
// Validates: Requirements 9.7

import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript
import { buildApp } from "../server/app.js";
// @ts-ignore -- untyped ESM JavaScript
import { loadConfig } from "../server/config.js";
// @ts-ignore -- untyped ESM JavaScript
import { getStore } from "../server/store.js";
// @ts-ignore -- untyped ESM JavaScript
import { getEventStore } from "../server/eventStore.js";

function makeApp(readyValue: boolean) {
  const { config } = loadConfig({ DATASTORE_BACKEND: "memory", AUTH_PASSWORD: "test-pass-1234" });
  const store = getStore();
  const eventStore = getEventStore();
  const ready = { value: readyValue };
  const ai = { name: "mock", model: "mock", generate: async () => '{}' };
  return { app: buildApp({ config: config!, store, eventStore, secret: "a".repeat(64), ai, ready }), ready };
}

function healthReq() {
  return new Request("http://localhost:8080/api/health");
}

describe("/api/health (Req 9.7)", () => {
  it("reports not-ready when the ready flag is false", async () => {
    const { app } = makeApp(false);
    const res = await app.fetch(healthReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ready).toBe(false);
    expect(json.schema).toBe(1);
  });

  it("reports ready when the ready flag is true", async () => {
    const { app } = makeApp(true);
    const res = await app.fetch(healthReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ready).toBe(true);
    expect(json.schema).toBe(1);
  });

  it("transitions from not-ready to ready when the flag is flipped", async () => {
    const { app, ready } = makeApp(false);

    let res = await app.fetch(healthReq());
    expect((await res.json()).ready).toBe(false);

    ready.value = true;

    res = await app.fetch(healthReq());
    expect((await res.json()).ready).toBe(true);
  });

  it("is unauthenticated — no token required", async () => {
    const { app } = makeApp(true);
    // No Authorization header
    const res = await app.fetch(healthReq());
    expect(res.status).toBe(200);
  });

  it("returns only ready and schema — no config, no version, no counts", async () => {
    const { app } = makeApp(true);
    const res = await app.fetch(healthReq());
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["ready", "schema"]);
  });
});
