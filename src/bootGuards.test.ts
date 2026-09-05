// @vitest-environment node
//
// Boot-time configuration guards, tested through loadConfig:
// 1. An unrecognised `DATASTORE_BACKEND` value produces an error — Requirement 2.11.
// 2. DATASTORE_BACKEND=memory + exposed (non-loopback) BIND_HOST produces a warning — Req 2.8.
// 3. Default DATASTORE_BACKEND is "sqlite" — Requirement 2.10.
//
// _Requirements: 2.8, 2.10, 2.11, 13.3_

import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript
import { loadConfig } from "../server/config.js";

/**
 * `AI_MODEL` is required for every provider except `mock`, and the default is
 * `ollama` — so a config that omits it never reaches ok=true. These assertions
 * are about DATASTORE_BACKEND, so the model is supplied and stays out of the way.
 */
const MODEL_ONLY = { AI_MODEL: "a-test-model" };

describe("DATASTORE_BACKEND guard (Requirement 2.11)", () => {
  it("rejects an unrecognised value, logs it and the accepted set, and exits 1", () => {
    const { ok, errors } = loadConfig({ DATASTORE_BACKEND: "dynamodb" });
    expect(ok).toBe(false);
    expect(errors[0]).toContain("dynamodb");
    expect(errors[0]).toContain("sqlite");
    expect(errors[0]).toContain("memory");
  });

  it("rejects another unrecognised value (firestore)", () => {
    const { ok, errors } = loadConfig({ DATASTORE_BACKEND: "firestore" });
    expect(ok).toBe(false);
    expect(errors[0]).toContain("firestore");
  });
});

describe("memory + exposed bind warning (Requirement 2.8)", () => {
  it("logs a warning when DATASTORE_BACKEND=memory and BIND_HOST is non-loopback", () => {
    const { ok, warnings } = loadConfig({
      ...MODEL_ONLY,
      DATASTORE_BACKEND: "memory",
      BIND_HOST: "0.0.0.0",
      AUTH_PASSWORD: "test-password-123",
    });
    expect(ok).toBe(true);
    const memWarnings = warnings.filter((w: string) => w.includes("memory"));
    expect(memWarnings.length).toBeGreaterThan(0);
    expect(memWarnings[0]).toContain("0.0.0.0");
  });

  it("does NOT warn when DATASTORE_BACKEND=memory and BIND_HOST is loopback", () => {
    const { ok, warnings } = loadConfig({
      ...MODEL_ONLY,
      DATASTORE_BACKEND: "memory",
      BIND_HOST: "127.0.0.1",
    });
    expect(ok).toBe(true);
    const memWarnings = warnings.filter((w: string) => w.includes("memory"));
    expect(memWarnings).toEqual([]);
  });

  it("does NOT warn when DATASTORE_BACKEND=memory and BIND_HOST is ::1", () => {
    const { ok, warnings } = loadConfig({
      ...MODEL_ONLY,
      DATASTORE_BACKEND: "memory",
      BIND_HOST: "::1",
    });
    expect(ok).toBe(true);
    const memWarnings = warnings.filter((w: string) => w.includes("memory"));
    expect(memWarnings).toEqual([]);
  });
});

describe("default DATASTORE_BACKEND is sqlite (Requirement 2.10)", () => {
  it("defaults to sqlite when DATASTORE_BACKEND is unset", () => {
    const { ok, config } = loadConfig({ ...MODEL_ONLY });
    expect(ok).toBe(true);
    expect(config!.datastoreBackend).toBe("sqlite");
  });
});
