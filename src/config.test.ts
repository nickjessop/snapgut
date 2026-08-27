// @vitest-environment node
//
// Unit tests for server/config.js — the loadConfig(env) function.
// Validates: PORT 1-65535, BIND_HOST loopback detection, exposed bind + no credential,
// DATASTORE_BACKEND known, AI_PROVIDER known + required settings, SESSION_SECRET length,
// derived exposedBind, and all defaults.
//
// _Requirements: 2.11, 4.14, 7.4, 7.14, 8.1, 9.4_

import { describe, expect, it } from "vitest";
// @ts-ignore — untyped ESM JavaScript
import { loadConfig } from "../server/config.js";

/** Minimal env that produces a valid config with no warnings. */
function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AUTH_PASSWORD: "a-secure-password-12",
    ...overrides,
  };
}

describe("loadConfig defaults", () => {
  it("returns ok=true with all defaults when env is empty", () => {
    const result = loadConfig({});
    // Exposed bind warning fires because default bind is 127.0.0.1 — no warning
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const c = result.config!;
    expect(c.port).toBe(8080);
    expect(c.bindHost).toBe("127.0.0.1");
    expect(c.exposedBind).toBe(false);
    expect(c.publicOrigin).toBeNull();
    expect(c.requireHttps).toBe(false);
    expect(c.trustedProxy).toBe("none");
    expect(c.dataDir).toBe("/data");
    expect(c.dbPath).toBe("/data/snapgut.db");
    expect(c.datastoreBackend).toBe("sqlite");
    expect(c.foodPackDir).toBe("./food-pack");
    expect(c.ai.provider).toBe("ollama");
    expect(c.ai.baseUrl).toBe("http://127.0.0.1:11434");
    expect(c.ai.model).toBe("");
    expect(c.ai.apiKey).toBeNull();
    expect(c.ai.timeoutMs).toBe(120000);
    expect(c.auth.email).toBe("admin@localhost");
    expect(c.auth.password).toBeNull();
    expect(c.sessionSecret).toBeNull();
  });

  it("config is frozen", () => {
    const result = loadConfig(validEnv());
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config!.ai)).toBe(true);
    expect(Object.isFrozen(result.config!.auth)).toBe(true);
  });
});

describe("PORT validation (Req 8.1)", () => {
  it("accepts port 1", () => {
    const { ok, config } = loadConfig(validEnv({ PORT: "1" }));
    expect(ok).toBe(true);
    expect(config!.port).toBe(1);
  });

  it("accepts port 65535", () => {
    const { ok, config } = loadConfig(validEnv({ PORT: "65535" }));
    expect(ok).toBe(true);
    expect(config!.port).toBe(65535);
  });

  it("rejects port 0", () => {
    const { ok, errors } = loadConfig(validEnv({ PORT: "0" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("PORT");
    expect(errors[0]).toContain("1");
    expect(errors[0]).toContain("65535");
  });

  it("rejects port 65536", () => {
    const { ok, errors } = loadConfig(validEnv({ PORT: "65536" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("PORT");
  });

  it("rejects non-numeric port", () => {
    const { ok, errors } = loadConfig(validEnv({ PORT: "abc" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("PORT");
  });

  it("rejects negative port", () => {
    const { ok, errors } = loadConfig(validEnv({ PORT: "-1" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("PORT");
  });

  it("rejects fractional port", () => {
    const { ok, errors } = loadConfig(validEnv({ PORT: "80.5" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("PORT");
  });
});

describe("BIND_HOST and exposedBind (Req 7.4)", () => {
  it("127.0.0.1 is loopback", () => {
    const { config } = loadConfig(validEnv({ BIND_HOST: "127.0.0.1" }));
    expect(config!.exposedBind).toBe(false);
  });

  it("::1 is loopback", () => {
    const { config } = loadConfig(validEnv({ BIND_HOST: "::1" }));
    expect(config!.exposedBind).toBe(false);
  });

  it("localhost is loopback (case-insensitive)", () => {
    const { config } = loadConfig(validEnv({ BIND_HOST: "Localhost" }));
    expect(config!.exposedBind).toBe(false);
  });

  it("0.0.0.0 is exposed", () => {
    const { config } = loadConfig(validEnv({ BIND_HOST: "0.0.0.0" }));
    expect(config!.exposedBind).toBe(true);
  });

  it("192.168.1.1 is exposed", () => {
    const { config } = loadConfig(validEnv({ BIND_HOST: "192.168.1.1" }));
    expect(config!.exposedBind).toBe(true);
  });
});

describe("exposed bind + no credential warning (Req 7.4)", () => {
  it("warns when bind is exposed and no AUTH_PASSWORD", () => {
    const { ok, warnings } = loadConfig({ BIND_HOST: "0.0.0.0" });
    expect(ok).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("AUTH_PASSWORD");
    expect(warnings[0]).toContain("exposed");
  });

  it("no warning when bind is loopback and no AUTH_PASSWORD", () => {
    const { warnings } = loadConfig({ BIND_HOST: "127.0.0.1" });
    expect(warnings).toEqual([]);
  });

  it("no warning when bind is exposed and AUTH_PASSWORD is set", () => {
    const { warnings } = loadConfig({
      BIND_HOST: "0.0.0.0",
      AUTH_PASSWORD: "my-secret-pass-123",
    });
    // May have memory warning but not the credential warning
    const credWarnings = warnings.filter((w: string) => w.includes("AUTH_PASSWORD"));
    expect(credWarnings).toEqual([]);
  });
});

describe("DATASTORE_BACKEND validation (Req 2.11)", () => {
  it("accepts sqlite", () => {
    const { ok, config } = loadConfig(validEnv({ DATASTORE_BACKEND: "sqlite" }));
    expect(ok).toBe(true);
    expect(config!.datastoreBackend).toBe("sqlite");
  });

  it("accepts memory", () => {
    const { ok, config } = loadConfig(validEnv({ DATASTORE_BACKEND: "memory" }));
    expect(ok).toBe(true);
    expect(config!.datastoreBackend).toBe("memory");
  });

  it("rejects unknown backend", () => {
    const { ok, errors } = loadConfig(validEnv({ DATASTORE_BACKEND: "dynamodb" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("DATASTORE_BACKEND");
    expect(errors[0]).toContain("dynamodb");
    expect(errors[0]).toContain("sqlite");
    expect(errors[0]).toContain("memory");
  });

  it("defaults to sqlite when unset", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.datastoreBackend).toBe("sqlite");
  });
});

describe("AI_PROVIDER validation (Req 4.14)", () => {
  it("accepts all valid providers", () => {
    for (const p of ["ollama", "openai", "gemini", "mock"]) {
      const env: Record<string, string> = { ...validEnv(), AI_PROVIDER: p };
      if (p === "gemini") env.AI_API_KEY = "test-key-value";
      const { ok, config } = loadConfig(env);
      expect(ok).toBe(true);
      expect(config!.ai.provider).toBe(p);
    }
  });

  it("rejects unknown provider", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_PROVIDER: "vertex" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_PROVIDER");
    expect(errors[0]).toContain("vertex");
  });

  it("gemini without API key is an error", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_PROVIDER: "gemini" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("gemini");
    expect(errors[0]).toContain("AI_API_KEY");
  });

  it("gemini with API key is valid", () => {
    const { ok, config } = loadConfig(
      validEnv({ AI_PROVIDER: "gemini", AI_API_KEY: "my-key" })
    );
    expect(ok).toBe(true);
    expect(config!.ai.provider).toBe("gemini");
    expect(config!.ai.apiKey).toBe("my-key");
  });

  it("defaults to ollama when unset", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.ai.provider).toBe("ollama");
  });

  it("ollama gets default base URL", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.ai.baseUrl).toBe("http://127.0.0.1:11434");
  });

  it("openai base URL is null when AI_BASE_URL unset", () => {
    const { ok, config } = loadConfig(validEnv({ AI_PROVIDER: "openai" }));
    expect(ok).toBe(true);
    expect(config!.ai.baseUrl).toBeNull();
  });
});

describe("SESSION_SECRET validation (Req 7.14)", () => {
  it("null when unset", () => {
    const { ok, config } = loadConfig(validEnv());
    expect(ok).toBe(true);
    expect(config!.sessionSecret).toBeNull();
  });

  it("accepts 32+ character secret", () => {
    const secret = "a".repeat(32);
    const { ok, config } = loadConfig(validEnv({ SESSION_SECRET: secret }));
    expect(ok).toBe(true);
    expect(config!.sessionSecret).toBe(secret);
  });

  it("rejects <32 character secret", () => {
    const { ok, errors } = loadConfig(validEnv({ SESSION_SECRET: "short" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("SESSION_SECRET");
    expect(errors[0]).toContain("32");
  });

  it("rejects 31 character secret", () => {
    const { ok, errors } = loadConfig(validEnv({ SESSION_SECRET: "a".repeat(31) }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("SESSION_SECRET");
  });
});

describe("memory + exposed bind warning", () => {
  it("warns when memory backend and exposed bind", () => {
    const { warnings } = loadConfig({
      BIND_HOST: "0.0.0.0",
      DATASTORE_BACKEND: "memory",
      AUTH_PASSWORD: "my-secure-pw-123",
    });
    const memWarnings = warnings.filter((w: string) => w.includes("memory"));
    expect(memWarnings.length).toBeGreaterThan(0);
    expect(memWarnings[0]).toContain("lost");
  });

  it("no warning when memory backend and loopback bind", () => {
    const { warnings } = loadConfig({
      BIND_HOST: "127.0.0.1",
      DATASTORE_BACKEND: "memory",
    });
    const memWarnings = warnings.filter((w: string) => w.includes("memory"));
    expect(memWarnings).toEqual([]);
  });
});

describe("error accumulation", () => {
  it("accumulates multiple errors", () => {
    const { ok, errors } = loadConfig({
      PORT: "99999",
      DATASTORE_BACKEND: "invalid",
      AI_PROVIDER: "nope",
      SESSION_SECRET: "short",
    });
    expect(ok).toBe(false);
    expect(errors.length).toBe(4);
  });
});

describe("TRUSTED_PROXY", () => {
  it("accepts valid values", () => {
    for (const v of ["none", "xff", "cloudflare"]) {
      const { ok, config } = loadConfig(validEnv({ TRUSTED_PROXY: v }));
      expect(ok).toBe(true);
      expect(config!.trustedProxy).toBe(v);
    }
  });

  it("rejects invalid value", () => {
    const { ok, errors } = loadConfig(validEnv({ TRUSTED_PROXY: "nginx" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("TRUSTED_PROXY");
  });
});

describe("REQUIRE_HTTPS parsing", () => {
  it("false by default", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.requireHttps).toBe(false);
  });

  it("true for '1'", () => {
    const { config } = loadConfig(validEnv({ REQUIRE_HTTPS: "1" }));
    expect(config!.requireHttps).toBe(true);
  });

  it("true for 'true'", () => {
    const { config } = loadConfig(validEnv({ REQUIRE_HTTPS: "true" }));
    expect(config!.requireHttps).toBe(true);
  });

  it("true for 'yes'", () => {
    const { config } = loadConfig(validEnv({ REQUIRE_HTTPS: "yes" }));
    expect(config!.requireHttps).toBe(true);
  });

  it("false for '0'", () => {
    const { config } = loadConfig(validEnv({ REQUIRE_HTTPS: "0" }));
    expect(config!.requireHttps).toBe(false);
  });
});

describe("DB_PATH resolution", () => {
  it("defaults to ${dataDir}/snapgut.db", () => {
    const { config } = loadConfig(validEnv({ DATA_DIR: "/mnt/data" }));
    expect(config!.dbPath).toBe("/mnt/data/snapgut.db");
  });

  it("uses explicit DB_PATH when set", () => {
    const { config } = loadConfig(validEnv({ DB_PATH: "/custom/path.db" }));
    expect(config!.dbPath).toBe("/custom/path.db");
  });
});

describe("AI_TIMEOUT_MS", () => {
  it("defaults to 120000", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.ai.timeoutMs).toBe(120000);
  });

  it("accepts custom value", () => {
    const { config } = loadConfig(validEnv({ AI_TIMEOUT_MS: "30000" }));
    expect(config!.ai.timeoutMs).toBe(30000);
  });

  it("falls back to default for invalid value", () => {
    const { config } = loadConfig(validEnv({ AI_TIMEOUT_MS: "abc" }));
    expect(config!.ai.timeoutMs).toBe(120000);
  });
});

describe("AUTH_EMAIL", () => {
  it("defaults to admin@localhost", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.auth.email).toBe("admin@localhost");
  });

  it("trims and lowercases", () => {
    const { config } = loadConfig(validEnv({ AUTH_EMAIL: "  Admin@Example.COM  " }));
    expect(config!.auth.email).toBe("admin@example.com");
  });
});

describe("pure function contract", () => {
  it("never throws", () => {
    // Even with completely garbage input, loadConfig should return a result object
    const result = loadConfig({
      PORT: "banana",
      DATASTORE_BACKEND: "🎉",
      AI_PROVIDER: "skynet",
      SESSION_SECRET: "x",
      TRUSTED_PROXY: "haproxy",
    });
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("warnings");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
