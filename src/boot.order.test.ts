// @vitest-environment node
//
// Boot ordering: config errors cause exit before listen (Req 9.12, 9.13).
//
// Validates: Requirements 9.7, 9.12, 9.13

import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript
import { loadConfig } from "../server/config.js";

describe("config errors cause exit before listen (Req 9.12)", () => {
  it("returns ok=false for an invalid PORT, preventing listen", () => {
    const { ok, errors } = loadConfig({ PORT: "99999" });
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("PORT");
  });

  it("returns ok=false for an unknown DATASTORE_BACKEND, preventing listen", () => {
    const { ok, errors } = loadConfig({ DATASTORE_BACKEND: "dynamodb" });
    expect(ok).toBe(false);
    expect(errors[0]).toContain("DATASTORE_BACKEND");
  });

  it("returns ok=false for an unknown AI_PROVIDER, preventing listen", () => {
    const { ok, errors } = loadConfig({ AI_PROVIDER: "skynet" });
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_PROVIDER");
  });

  it("returns ok=false for SESSION_SECRET under 32 chars, preventing listen", () => {
    const { ok, errors } = loadConfig({ SESSION_SECRET: "short" });
    expect(ok).toBe(false);
    expect(errors[0]).toContain("SESSION_SECRET");
  });

  it("returns ok=false for gemini without API key, preventing listen", () => {
    const { ok, errors } = loadConfig({ AI_PROVIDER: "gemini" });
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_API_KEY");
  });

  it("returns ok=false for invalid TRUSTED_PROXY, preventing listen", () => {
    const { ok, errors } = loadConfig({ TRUSTED_PROXY: "nginx" });
    expect(ok).toBe(false);
    expect(errors[0]).toContain("TRUSTED_PROXY");
  });

  it("accumulates all errors so the operator sees every issue at once", () => {
    const { ok, errors } = loadConfig({
      PORT: "banana",
      DATASTORE_BACKEND: "firestore",
      AI_PROVIDER: "vertex",
      SESSION_SECRET: "x",
    });
    expect(ok).toBe(false);
    expect(errors.length).toBe(4);
  });
});

describe("valid config allows boot to proceed", () => {
  it("returns ok=true with defaults (boot can proceed to listen)", () => {
    const { ok, config } = loadConfig({});
    expect(ok).toBe(true);
    expect(config).not.toBeNull();
  });

  it("returns ok=true with a complete valid config", () => {
    const { ok, config } = loadConfig({
      PORT: "3000",
      BIND_HOST: "0.0.0.0",
      DATASTORE_BACKEND: "memory",
      AI_PROVIDER: "mock",
      AUTH_PASSWORD: "secure-password-123",
      SESSION_SECRET: "a".repeat(64),
    });
    expect(ok).toBe(true);
    expect(config!.port).toBe(3000);
  });
});
