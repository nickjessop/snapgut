// @vitest-environment node
//
// Tests that AI provider requests are aborted at the configured timeout.
//
// Validates: Requirements 4.15

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-ignore -- untyped ESM JavaScript
import { createOllamaProvider } from "../server/ai/ollama.js";
// @ts-ignore -- untyped ESM JavaScript
import { createOpenaiProvider } from "../server/ai/openai.js";
// @ts-ignore -- untyped ESM JavaScript
import { createAnthropicProvider } from "../server/ai/anthropic.js";
// @ts-ignore -- untyped ESM JavaScript
import { createGeminiProvider } from "../server/ai/gemini.js";

beforeEach(() => {
  // Stub fetch to respect the abort signal — when the signal fires, reject with
  // an AbortError just like real fetch does.
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          const err = new DOMException("The operation was aborted.", "AbortError");
          reject(err);
          return;
        }
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new DOMException("The operation was aborted.", "AbortError");
            reject(err);
          });
        }
        // Never resolves otherwise — simulates a slow model server.
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI provider timeout", () => {
  it("ollama: aborts when signal times out", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "llava",
    });

    await expect(
      provider.generate({
        prompt: "test",
        json: true,
        signal: AbortSignal.timeout(50),
      })
    ).rejects.toThrow();
  });

  it("openai: aborts when signal times out", async () => {
    const provider = createOpenaiProvider({
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    await expect(
      provider.generate({
        prompt: "test",
        json: true,
        signal: AbortSignal.timeout(50),
      })
    ).rejects.toThrow();
  });

  it("anthropic: aborts when signal times out", async () => {
    const provider = createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "sk-ant-test",
    });

    await expect(
      provider.generate({
        prompt: "test",
        json: true,
        signal: AbortSignal.timeout(50),
      })
    ).rejects.toThrow();
  });

  it("anthropic: the thrown error has AbortError or TimeoutError name", async () => {
    const provider = createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "sk-ant-test",
    });

    try {
      await provider.generate({
        prompt: "test",
        json: true,
        signal: AbortSignal.timeout(50),
      });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(["AbortError", "TimeoutError"]).toContain(err.name);
    }
  });

  it("gemini: aborts when signal times out", async () => {
    const provider = createGeminiProvider({
      model: "gemini-2.0-flash",
      apiKey: "test-key",
    });

    await expect(
      provider.generate({
        prompt: "test",
        json: true,
        signal: AbortSignal.timeout(50),
      })
    ).rejects.toThrow();
  });

  it("the thrown error has AbortError or TimeoutError name", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "llava",
    });

    try {
      await provider.generate({
        prompt: "test",
        json: true,
        signal: AbortSignal.timeout(50),
      });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(["AbortError", "TimeoutError"]).toContain(err.name);
    }
  });
});
