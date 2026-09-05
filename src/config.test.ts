// @vitest-environment node
//
// Unit tests for server/config.js — the loadConfig(env) function.
// Validates: PORT 1-65535, BIND_HOST loopback detection, exposed bind + no credential,
// DATASTORE_BACKEND known, AI_PROVIDER known + required settings, SESSION_SECRET length,
// derived exposedBind, and all defaults.
//
// _Requirements: 2.11, 4.14, 6.14, 6.16, 7.4, 7.14, 8.1, 9.4_

import { describe, expect, it } from "vitest";
// @ts-ignore — untyped ESM JavaScript
import { loadConfig } from "../server/config.js";

/**
 * Minimal env that produces a valid config with no warnings.
 *
 * `AI_MODEL` is here because it is required for every provider except `mock`, so
 * there is no such thing as a valid config that omits it while the default
 * `ollama` provider is in play.
 */
function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AUTH_PASSWORD: "a-secure-password-12",
    AI_MODEL: "a-test-model",
    ...overrides,
  };
}

/** The one setting with no usable default, so "defaults" still means everything else. */
const MODEL_ONLY = { AI_MODEL: "a-test-model" };

describe("loadConfig defaults", () => {
  it("returns ok=true with all defaults when only AI_MODEL is supplied", () => {
    const result = loadConfig({ ...MODEL_ONLY });
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
    expect(c.ai.model).toBe("a-test-model");
    expect(c.ai.apiKey).toBeNull();
    expect(c.ai.timeoutMs).toBe(120000);
    expect(c.ai.jsonMode).toBe("auto");
    expect(c.ai.extraHeaders).toBeNull();
    expect(c.auth.email).toBe("admin@localhost");
    expect(c.auth.password).toBeNull();
    expect(c.auth.credentialRejected).toBe(false);
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

describe("exposed bind + unusable credential is a boot failure (Req 7.4)", () => {
  it("errors when bind is exposed and AUTH_PASSWORD is unset", () => {
    const { ok, config, errors } = loadConfig({ ...MODEL_ONLY, BIND_HOST: "0.0.0.0" });
    expect(ok).toBe(false);
    expect(config).toBeNull();
    const credErrors = errors.filter((e: string) => e.includes("AUTH_PASSWORD"));
    expect(credErrors.length).toBeGreaterThan(0);
    expect(credErrors[0]).toContain("exposed");
  });

  it("errors when bind is exposed and AUTH_PASSWORD is whitespace-only", () => {
    const { ok, config, errors } = loadConfig({
      ...MODEL_ONLY,
      BIND_HOST: "0.0.0.0",
      AUTH_PASSWORD: "     ",
    });
    expect(ok).toBe(false);
    expect(config).toBeNull();
    const credErrors = errors.filter((e: string) => e.includes("AUTH_PASSWORD"));
    expect(credErrors.length).toBeGreaterThan(0);
  });

  it("errors when bind is exposed and AUTH_PASSWORD is 11 characters", () => {
    const eleven = "abcdefghijk";
    expect(eleven.length).toBe(11);
    const { ok, config, errors } = loadConfig({
      ...MODEL_ONLY,
      BIND_HOST: "0.0.0.0",
      AUTH_PASSWORD: eleven,
    });
    expect(ok).toBe(false);
    expect(config).toBeNull();
    const credErrors = errors.filter((e: string) => e.includes("AUTH_PASSWORD"));
    expect(credErrors.length).toBeGreaterThan(0);
    expect(credErrors[0]).toContain("12");
    expect(credErrors[0]).toContain("minimum");
  });

  it("errors when bind is a LAN address and AUTH_PASSWORD is unset", () => {
    const { ok, config, errors } = loadConfig({ ...MODEL_ONLY, BIND_HOST: "192.168.1.50" });
    expect(ok).toBe(false);
    expect(config).toBeNull();
    expect(errors.some((e: string) => e.includes("AUTH_PASSWORD"))).toBe(true);
  });

  it("accepts a 12-character AUTH_PASSWORD on an exposed bind (boundary)", () => {
    const twelve = "abcdefghijkl";
    expect(twelve.length).toBe(12);
    const { ok, config, errors } = loadConfig({
      ...MODEL_ONLY,
      BIND_HOST: "0.0.0.0",
      AUTH_PASSWORD: twelve,
    });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(config!.auth.password).toBe(twelve);
    expect(config!.auth.credentialRejected).toBe(false);
  });

  it("no credential error or warning when bind is exposed and AUTH_PASSWORD is long enough", () => {
    const { ok, errors, warnings } = loadConfig({
      ...MODEL_ONLY,
      BIND_HOST: "0.0.0.0",
      AUTH_PASSWORD: "my-secret-pass-123",
    });
    expect(ok).toBe(true);
    // May have a memory warning but not a credential error or warning
    expect(errors).toEqual([]);
    const credWarnings = warnings.filter((w: string) => w.includes("AUTH_PASSWORD"));
    expect(credWarnings).toEqual([]);
  });
});

describe("loopback bind + unusable credential is a warning, not a failure (Req 6.14)", () => {
  it("warns but boots when bind is loopback and AUTH_PASSWORD is 11 characters", () => {
    const eleven = "abcdefghijk";
    const { ok, config, errors, warnings } = loadConfig({
      ...MODEL_ONLY,
      BIND_HOST: "127.0.0.1",
      AUTH_PASSWORD: eleven,
    });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(config!.auth.password).toBeNull();
    const credWarnings = warnings.filter((w: string) => w.includes("AUTH_PASSWORD"));
    expect(credWarnings.length).toBeGreaterThan(0);
    expect(credWarnings[0]).toContain("12");
  });

  it("no warning when bind is loopback and no AUTH_PASSWORD (unchanged)", () => {
    const { ok, warnings } = loadConfig({ ...MODEL_ONLY, BIND_HOST: "127.0.0.1" });
    expect(ok).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("resolves a too-short credential to null so sign-in has one rejection path", () => {
    const { config } = loadConfig({ ...MODEL_ONLY, AUTH_PASSWORD: "short" });
    expect(config!.auth.password).toBeNull();
  });

  it("auth.password is the trimmed value when valid", () => {
    const { config } = loadConfig({ ...MODEL_ONLY, AUTH_PASSWORD: "  a-valid-credential  " });
    expect(config!.auth.password).toBe("a-valid-credential");
  });

  it("a value that is only 12 characters after trimming is rejected", () => {
    const { config } = loadConfig({ ...MODEL_ONLY, AUTH_PASSWORD: "   abcdefghij   " });
    expect(config!.auth.password).toBeNull();
  });

  it("auth stays frozen with exactly { email, password, credentialRejected }", () => {
    const { config } = loadConfig(validEnv());
    expect(Object.isFrozen(config!.auth)).toBe(true);
    expect(Object.keys(config!.auth).sort()).toEqual([
      "credentialRejected",
      "email",
      "password",
    ]);
  });
});

// The boot summary in `server/main.js` has to tell "nothing configured" apart
// from "configured but unusable", because they read as opposite things to an
// operator: the first is a deliberately open loopback instance, the second is a
// misconfiguration. `password` alone is null for both, so this flag carries it.
describe("auth.credentialRejected distinguishes unset from unusable (Req 6.14)", () => {
  it("is false when no credential was supplied at all", () => {
    const { config } = loadConfig({ ...MODEL_ONLY });
    expect(config!.auth.password).toBeNull();
    expect(config!.auth.credentialRejected).toBe(false);
  });

  it("is false when a whitespace-only value was supplied — nothing was configured", () => {
    const { config } = loadConfig({ ...MODEL_ONLY, AUTH_PASSWORD: "     " });
    expect(config!.auth.password).toBeNull();
    expect(config!.auth.credentialRejected).toBe(false);
  });

  it("is true when a credential was supplied but is under 12 characters", () => {
    const { config } = loadConfig({ ...MODEL_ONLY, AUTH_PASSWORD: "abcdefghijk" });
    expect(config!.auth.password).toBeNull();
    expect(config!.auth.credentialRejected).toBe(true);
  });

  it("is false when the credential is usable", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.auth.password).not.toBeNull();
    expect(config!.auth.credentialRejected).toBe(false);
  });
});

describe("credential value never appears in diagnostics (Req 6.16)", () => {
  const cases: Array<[string, Record<string, string>]> = [
    [
      "exposed bind, too short",
      { ...MODEL_ONLY, BIND_HOST: "0.0.0.0", AUTH_PASSWORD: "hunter2-abc" },
    ],
    [
      "loopback bind, too short",
      { ...MODEL_ONLY, BIND_HOST: "127.0.0.1", AUTH_PASSWORD: "hunter2-abc" },
    ],
    [
      "exposed bind, whitespace-only",
      { ...MODEL_ONLY, BIND_HOST: "0.0.0.0", AUTH_PASSWORD: "   " },
    ],
    ["exposed bind, unset", { ...MODEL_ONLY, BIND_HOST: "0.0.0.0" }],
  ];

  for (const [label, env] of cases) {
    it(`no message leaks the credential or its length — ${label}`, () => {
      const { errors, warnings } = loadConfig(env);
      const messages = [...errors, ...warnings];
      expect(messages.length).toBeGreaterThan(0);

      const credential = (env.AUTH_PASSWORD ?? "").trim();
      for (const message of messages) {
        if (credential.length > 0) {
          expect(message).not.toContain(credential);
          // The actual length must never be reported; only the 12-char minimum.
          expect(message).not.toMatch(new RegExp(`\\b${credential.length}\\b`));
        }
      }
    });
  }
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
    for (const p of [
      "ollama",
      "openai",
      "openai-compatible",
      "litellm",
      "anthropic",
      "gemini",
      "mock",
    ]) {
      const env: Record<string, string> = { ...validEnv(), AI_PROVIDER: p };
      if (p === "gemini" || p === "anthropic") env.AI_API_KEY = "test-key-value";
      if (p === "openai-compatible") env.AI_BASE_URL = "http://127.0.0.1:8000/v1";
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

  it("openai gets the api.openai.com default base URL", () => {
    const { ok, config } = loadConfig(validEnv({ AI_PROVIDER: "openai" }));
    expect(ok).toBe(true);
    expect(config!.ai.baseUrl).toBe("https://api.openai.com");
  });

  it("litellm gets the proxy default base URL", () => {
    const { config } = loadConfig(validEnv({ AI_PROVIDER: "litellm" }));
    expect(config!.ai.baseUrl).toBe("http://127.0.0.1:4000");
  });

  it("anthropic gets the api.anthropic.com default base URL", () => {
    const { config } = loadConfig(
      validEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "sk-ant-key" })
    );
    expect(config!.ai.baseUrl).toBe("https://api.anthropic.com");
  });

  it("gemini gets the generativelanguage default base URL", () => {
    const { config } = loadConfig(validEnv({ AI_PROVIDER: "gemini", AI_API_KEY: "key" }));
    expect(config!.ai.baseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  it("mock base URL is null when AI_BASE_URL unset", () => {
    const { ok, config } = loadConfig(validEnv({ AI_PROVIDER: "mock" }));
    expect(ok).toBe(true);
    expect(config!.ai.baseUrl).toBeNull();
  });

  it("AI_BASE_URL overrides the per-provider default", () => {
    const { config } = loadConfig(
      validEnv({ AI_PROVIDER: "openai", AI_BASE_URL: "http://my-gateway:4000/v1" })
    );
    expect(config!.ai.baseUrl).toBe("http://my-gateway:4000/v1");
  });

  it("anthropic without API key is an error", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_PROVIDER: "anthropic" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("anthropic");
    expect(errors[0]).toContain("AI_API_KEY");
  });

  it("openai-compatible without base URL is an error", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_PROVIDER: "openai-compatible" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("openai-compatible");
    expect(errors[0]).toContain("AI_BASE_URL");
  });

  it("openai-compatible with base URL is valid", () => {
    const { ok, config } = loadConfig(
      validEnv({ AI_PROVIDER: "openai-compatible", AI_BASE_URL: "http://127.0.0.1:8000/v1" })
    );
    expect(ok).toBe(true);
    expect(config!.ai.baseUrl).toBe("http://127.0.0.1:8000/v1");
  });
});

describe("AI_JSON_MODE validation (Req 4.14)", () => {
  it("defaults to auto when unset", () => {
    const { ok, config } = loadConfig(validEnv());
    expect(ok).toBe(true);
    expect(config!.ai.jsonMode).toBe("auto");
  });

  it("accepts all valid modes", () => {
    for (const mode of ["auto", "json_object", "off"]) {
      const { ok, config } = loadConfig(validEnv({ AI_JSON_MODE: mode }));
      expect(ok).toBe(true);
      expect(config!.ai.jsonMode).toBe(mode);
    }
  });

  it("trims and lowercases the value", () => {
    const { ok, config } = loadConfig(validEnv({ AI_JSON_MODE: "  OFF  " }));
    expect(ok).toBe(true);
    expect(config!.ai.jsonMode).toBe("off");
  });

  it("rejects an unrecognised mode", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_JSON_MODE: "schema" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_JSON_MODE");
    expect(errors[0]).toContain("schema");
    expect(errors[0]).toContain("auto");
    expect(errors[0]).toContain("json_object");
    expect(errors[0]).toContain("off");
  });

  it("empty string falls back to auto", () => {
    const { ok, config } = loadConfig(validEnv({ AI_JSON_MODE: "" }));
    expect(ok).toBe(true);
    expect(config!.ai.jsonMode).toBe("auto");
  });
});

describe("AI_EXTRA_HEADERS validation (Req 4.14)", () => {
  it("defaults to null when unset", () => {
    const { ok, config } = loadConfig(validEnv());
    expect(ok).toBe(true);
    expect(config!.ai.extraHeaders).toBeNull();
  });

  it("parses a JSON object of string values", () => {
    const { ok, config } = loadConfig(
      validEnv({
        AI_EXTRA_HEADERS: '{"HTTP-Referer":"https://example.com","X-Title":"SnapGut"}',
      })
    );
    expect(ok).toBe(true);
    expect(config!.ai.extraHeaders).toEqual({
      "HTTP-Referer": "https://example.com",
      "X-Title": "SnapGut",
    });
  });

  it("the parsed object is frozen", () => {
    const { config } = loadConfig(validEnv({ AI_EXTRA_HEADERS: '{"X-Title":"SnapGut"}' }));
    expect(Object.isFrozen(config!.ai.extraHeaders)).toBe(true);
  });

  it("rejects malformed JSON", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_EXTRA_HEADERS: "{not json" }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_EXTRA_HEADERS");
  });

  it("rejects a JSON array", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_EXTRA_HEADERS: '["X-Title"]' }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_EXTRA_HEADERS");
    expect(errors[0]).toContain("array");
  });

  it("rejects a JSON scalar", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_EXTRA_HEADERS: '"X-Title"' }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_EXTRA_HEADERS");
  });

  it("rejects non-string values", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_EXTRA_HEADERS: '{"X-Retries":3}' }));
    expect(ok).toBe(false);
    expect(errors[0]).toContain("AI_EXTRA_HEADERS");
    expect(errors[0]).toContain("X-Retries");
  });

  it("empty string leaves it null", () => {
    const { ok, config } = loadConfig(validEnv({ AI_EXTRA_HEADERS: "" }));
    expect(ok).toBe(true);
    expect(config!.ai.extraHeaders).toBeNull();
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
      ...MODEL_ONLY,
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
      ...MODEL_ONLY,
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

// The value is handed straight to `AbortSignal.timeout()` in `server/app.js`, and
// `AbortSignal.timeout(0)` fires on the next macrotask — so 0 aborts every AI
// request rather than disabling the timeout. An unusable value is a boot error
// rather than a silent reset to 120000, so a typo is reported instead of quietly
// ignored.
describe("AI_TIMEOUT_MS", () => {
  it("defaults to 120000", () => {
    const { config } = loadConfig(validEnv());
    expect(config!.ai.timeoutMs).toBe(120000);
  });

  it("accepts custom value", () => {
    const { config } = loadConfig(validEnv({ AI_TIMEOUT_MS: "30000" }));
    expect(config!.ai.timeoutMs).toBe(30000);
  });

  it("treats an empty value as unset and uses the default", () => {
    const { ok, config } = loadConfig(validEnv({ AI_TIMEOUT_MS: "" }));
    expect(ok).toBe(true);
    expect(config!.ai.timeoutMs).toBe(120000);
  });

  it("accepts 1 ms — the smallest usable value (boundary)", () => {
    const { ok, config } = loadConfig(validEnv({ AI_TIMEOUT_MS: "1" }));
    expect(ok).toBe(true);
    expect(config!.ai.timeoutMs).toBe(1);
  });

  it("rejects 0 — it aborts every AI request rather than disabling the timeout", () => {
    const { ok, config, errors } = loadConfig(validEnv({ AI_TIMEOUT_MS: "0" }));
    expect(ok).toBe(false);
    expect(config).toBeNull();
    const timeoutErrors = errors.filter((e: string) => e.includes("AI_TIMEOUT_MS"));
    expect(timeoutErrors.length).toBe(1);
    expect(timeoutErrors[0]).toContain("greater than zero");
  });

  it("rejects a negative value", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_TIMEOUT_MS: "-1" }));
    expect(ok).toBe(false);
    expect(errors.some((e: string) => e.includes("AI_TIMEOUT_MS"))).toBe(true);
  });

  it("rejects a non-numeric value instead of silently substituting the default", () => {
    const { ok, config, errors } = loadConfig(validEnv({ AI_TIMEOUT_MS: "abc" }));
    expect(ok).toBe(false);
    expect(config).toBeNull();
    const timeoutErrors = errors.filter((e: string) => e.includes("AI_TIMEOUT_MS"));
    expect(timeoutErrors.length).toBe(1);
    expect(timeoutErrors[0]).toContain("abc");
  });
});

// Every adapter in `server/ai/` passes `model` through verbatim, and an empty
// model is rejected by six of the seven providers. Enforcing it at boot turns a
// guaranteed `503 ai_unavailable` at first use into a named config error.
describe("AI_MODEL is required for every provider except mock", () => {
  const networkProviders: Array<[string, Record<string, string>]> = [
    ["ollama", {}],
    ["openai", {}],
    ["openai-compatible", { AI_BASE_URL: "http://127.0.0.1:8000/v1" }],
    ["litellm", {}],
    ["anthropic", { AI_API_KEY: "sk-ant-key" }],
    ["gemini", { AI_API_KEY: "gemini-key" }],
  ];

  for (const [provider, extra] of networkProviders) {
    it(`errors when provider is ${provider} and AI_MODEL is unset`, () => {
      const { ok, config, errors } = loadConfig({
        AUTH_PASSWORD: "a-secure-password-12",
        AI_PROVIDER: provider,
        ...extra,
      });
      expect(ok).toBe(false);
      expect(config).toBeNull();
      const modelErrors = errors.filter((e: string) => e.includes("AI_MODEL"));
      expect(modelErrors.length).toBe(1);
      expect(modelErrors[0]).toContain(provider);
    });

    it(`accepts ${provider} once AI_MODEL is set`, () => {
      const { ok, config } = loadConfig({
        AUTH_PASSWORD: "a-secure-password-12",
        AI_PROVIDER: provider,
        AI_MODEL: "a-test-model",
        ...extra,
      });
      expect(ok).toBe(true);
      expect(config!.ai.model).toBe("a-test-model");
    });
  }

  it("errors for the default provider when AI_MODEL is unset", () => {
    const { ok, errors } = loadConfig({ AUTH_PASSWORD: "a-secure-password-12" });
    expect(ok).toBe(false);
    expect(errors.some((e: string) => e.includes("AI_MODEL"))).toBe(true);
  });

  it("treats a whitespace-only AI_MODEL as empty", () => {
    const { ok, errors } = loadConfig(validEnv({ AI_MODEL: "   " }));
    expect(ok).toBe(false);
    expect(errors.some((e: string) => e.includes("AI_MODEL"))).toBe(true);
  });

  it("trims the value", () => {
    const { config } = loadConfig(validEnv({ AI_MODEL: "  llama3.2-vision  " }));
    expect(config!.ai.model).toBe("llama3.2-vision");
  });

  it("mock needs no model — it never calls out", () => {
    const { ok, config, errors } = loadConfig({
      AUTH_PASSWORD: "a-secure-password-12",
      AI_PROVIDER: "mock",
    });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(config!.ai.model).toBe("");
  });

  it("does not pile an AI_MODEL error on top of an unrecognised AI_PROVIDER", () => {
    const { ok, errors } = loadConfig({
      AUTH_PASSWORD: "a-secure-password-12",
      AI_PROVIDER: "vertex",
    });
    expect(ok).toBe(false);
    expect(errors.filter((e: string) => e.includes("AI_PROVIDER")).length).toBe(1);
    expect(errors.filter((e: string) => e.includes("AI_MODEL"))).toEqual([]);
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
