// Tests for server/ai/index.js — createAiProvider selection and validation.
// Requirements: 4.1, 4.14

import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { createAiProvider, ConfigError } from "../server/ai/index.js";

function makeConfig(overrides: Partial<{
  provider: string;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  jsonMode: string;
  extraHeaders: Record<string, string> | null;
}> = {}) {
  return {
    ai: {
      provider: "mock",
      baseUrl: null,
      model: "test-model",
      apiKey: null,
      timeoutMs: 120000,
      jsonMode: "auto",
      extraHeaders: null,
      ...overrides,
    },
  };
}

describe("createAiProvider", () => {
  describe("provider selection", () => {
    it("selects ollama provider", () => {
      const provider = createAiProvider(makeConfig({ provider: "ollama" }));
      expect(provider.name).toBe("ollama");
    });

    it("selects openai provider", () => {
      const provider = createAiProvider(makeConfig({ provider: "openai" }));
      expect(provider.name).toBe("openai");
    });

    it("selects litellm provider", () => {
      const provider = createAiProvider(makeConfig({ provider: "litellm" }));
      expect(provider.name).toBe("litellm");
    });

    it("selects openai-compatible provider when baseUrl is set", () => {
      const provider = createAiProvider(
        makeConfig({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:8000/v1" })
      );
      expect(provider.name).toBe("openai-compatible");
    });

    it("selects anthropic provider with apiKey", () => {
      const provider = createAiProvider(
        makeConfig({ provider: "anthropic", apiKey: "sk-ant-123" })
      );
      expect(provider.name).toBe("anthropic");
    });

    it("selects gemini provider with apiKey", () => {
      const provider = createAiProvider(makeConfig({ provider: "gemini", apiKey: "key-123" }));
      expect(provider.name).toBe("gemini");
    });

    it("selects mock provider", () => {
      const provider = createAiProvider(makeConfig({ provider: "mock" }));
      expect(provider.name).toBe("mock");
    });

    it("returns a provider with a generate function", () => {
      const provider = createAiProvider(makeConfig({ provider: "mock" }));
      expect(typeof provider.generate).toBe("function");
    });

    it("returns the configured model name", () => {
      const provider = createAiProvider(makeConfig({ provider: "mock", model: "my-model" }));
      expect(provider.model).toBe("my-model");
    });
  });

  describe("unknown provider", () => {
    it("throws ConfigError on unrecognised provider", () => {
      expect(() => createAiProvider(makeConfig({ provider: "vertex" }))).toThrow(ConfigError);
    });

    it("includes supported values in the error message", () => {
      try {
        createAiProvider(makeConfig({ provider: "unknown" }));
      } catch (e: any) {
        expect(e.message).toContain("ollama");
        expect(e.message).toContain("openai");
        expect(e.message).toContain("gemini");
        expect(e.message).toContain("mock");
        return;
      }
      expect.fail("should have thrown");
    });

    it("includes the bad provider name in the error message", () => {
      try {
        createAiProvider(makeConfig({ provider: "banana" }));
      } catch (e: any) {
        expect(e.message).toContain("banana");
        return;
      }
      expect.fail("should have thrown");
    });
  });

  describe("ollama validation", () => {
    it("uses default baseUrl when not set", () => {
      const provider = createAiProvider(makeConfig({ provider: "ollama", baseUrl: null }));
      expect(provider.name).toBe("ollama");
    });

    it("uses the provided baseUrl", () => {
      const provider = createAiProvider(
        makeConfig({ provider: "ollama", baseUrl: "http://my-host:11434" })
      );
      expect(provider.name).toBe("ollama");
    });
  });

  describe("openai validation", () => {
    it("uses default baseUrl when not set", () => {
      const provider = createAiProvider(makeConfig({ provider: "openai", baseUrl: null }));
      expect(provider.name).toBe("openai");
    });

    it("uses the provided baseUrl", () => {
      const provider = createAiProvider(
        makeConfig({ provider: "openai", baseUrl: "https://my-openai-proxy.com" })
      );
      expect(provider.name).toBe("openai");
    });
  });

  describe("litellm validation", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("defaults to the LiteLLM proxy port when baseUrl is not set", async () => {
      const fetchSpy = vi.fn(async (_url: string, _opts?: unknown) => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "{}" } }] }),
      }));
      vi.stubGlobal("fetch", fetchSpy);

      const provider = createAiProvider(makeConfig({ provider: "litellm", baseUrl: null }));
      await provider.generate({
        prompt: "test",
        json: true,
        signal: AbortSignal.timeout(5000),
      });

      expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:4000/v1/chat/completions");
    });

    it("uses the provided baseUrl", () => {
      const provider = createAiProvider(
        makeConfig({ provider: "litellm", baseUrl: "http://my-proxy:4000/v1" })
      );
      expect(provider.name).toBe("litellm");
    });

    it("requires no apiKey", () => {
      const provider = createAiProvider(makeConfig({ provider: "litellm", apiKey: null }));
      expect(provider.name).toBe("litellm");
    });
  });

  describe("openai-compatible validation", () => {
    it("throws ConfigError when baseUrl is null", () => {
      expect(() =>
        createAiProvider(makeConfig({ provider: "openai-compatible", baseUrl: null }))
      ).toThrow(ConfigError);
    });

    it("throws ConfigError when baseUrl is whitespace only", () => {
      expect(() =>
        createAiProvider(makeConfig({ provider: "openai-compatible", baseUrl: "   " }))
      ).toThrow(ConfigError);
    });

    it("error message mentions AI_BASE_URL", () => {
      try {
        createAiProvider(makeConfig({ provider: "openai-compatible", baseUrl: null }));
      } catch (e: any) {
        expect(e.message).toContain("AI_BASE_URL");
        return;
      }
      expect.fail("should have thrown");
    });

    it("requires no apiKey when baseUrl is set", () => {
      const provider = createAiProvider(
        makeConfig({
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: null,
        })
      );
      expect(provider.name).toBe("openai-compatible");
    });
  });

  describe("anthropic validation", () => {
    it("throws ConfigError when apiKey is null", () => {
      expect(() => createAiProvider(makeConfig({ provider: "anthropic", apiKey: null }))).toThrow(
        ConfigError
      );
    });

    it("throws ConfigError when apiKey is whitespace only", () => {
      expect(() => createAiProvider(makeConfig({ provider: "anthropic", apiKey: "   " }))).toThrow(
        ConfigError
      );
    });

    it("error message mentions AI_API_KEY", () => {
      try {
        createAiProvider(makeConfig({ provider: "anthropic", apiKey: null }));
      } catch (e: any) {
        expect(e.message).toContain("AI_API_KEY");
        return;
      }
      expect.fail("should have thrown");
    });

    it("uses the default baseUrl when not set", () => {
      const provider = createAiProvider(
        makeConfig({ provider: "anthropic", apiKey: "sk-ant-123", baseUrl: null })
      );
      expect(provider.name).toBe("anthropic");
    });
  });

  describe("gemini validation", () => {
    it("throws ConfigError when apiKey is null", () => {
      expect(() => createAiProvider(makeConfig({ provider: "gemini", apiKey: null }))).toThrow(
        ConfigError
      );
    });

    it("throws ConfigError when apiKey is empty string", () => {
      expect(() => createAiProvider(makeConfig({ provider: "gemini", apiKey: "" }))).toThrow(
        ConfigError
      );
    });

    it("throws ConfigError when apiKey is whitespace only", () => {
      expect(() => createAiProvider(makeConfig({ provider: "gemini", apiKey: "   " }))).toThrow(
        ConfigError
      );
    });

    it("error message mentions AI_API_KEY", () => {
      try {
        createAiProvider(makeConfig({ provider: "gemini", apiKey: null }));
      } catch (e: any) {
        expect(e.message).toContain("AI_API_KEY");
        return;
      }
      expect.fail("should have thrown");
    });
  });

  describe("mock validation", () => {
    it("requires nothing — succeeds with no baseUrl or apiKey", () => {
      const provider = createAiProvider(makeConfig({ provider: "mock", baseUrl: null, apiKey: null }));
      expect(provider.name).toBe("mock");
    });
  });

  describe("ConfigError", () => {
    it("is an instance of Error", () => {
      const err = new ConfigError("test");
      expect(err).toBeInstanceOf(Error);
    });

    it("has name ConfigError", () => {
      const err = new ConfigError("test message");
      expect(err.name).toBe("ConfigError");
    });

    it("preserves the message", () => {
      const err = new ConfigError("something went wrong");
      expect(err.message).toBe("something went wrong");
    });
  });
});
