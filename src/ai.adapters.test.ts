// @vitest-environment node
//
// Tests for each AI provider adapter's request shape — URL, headers, body
// structure including image and JSON-mode fields.
//
// Validates: Requirements 4.9, 4.10

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-ignore -- untyped ESM JavaScript
import { createOllamaProvider } from "../server/ai/ollama.js";
// @ts-ignore -- untyped ESM JavaScript
import { createOpenaiProvider } from "../server/ai/openai.js";
// @ts-ignore -- untyped ESM JavaScript
import { createGeminiProvider } from "../server/ai/gemini.js";
// @ts-ignore -- untyped ESM JavaScript
import { createMockProvider } from "../server/ai/mock.js";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

describe("ollama adapter request shape", () => {
  const provider = createOllamaProvider({
    baseUrl: "http://localhost:11434",
    model: "llava",
  });

  it("calls the correct URL with POST", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: '{"dish":"Test"}' }), { status: 200 })
    );

    await provider.generate({
      prompt: "Identify food",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/generate");
    expect(opts.method).toBe("POST");
  });

  it("sends Content-Type application/json", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: "{}" }), { status: 200 })
    );

    await provider.generate({
      prompt: "test",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("includes model, prompt, stream: false in body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: "{}" }), { status: 200 })
    );

    await provider.generate({
      prompt: "Identify food",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("llava");
    expect(body.prompt).toBe("Identify food");
    expect(body.stream).toBe(false);
  });

  it("includes image as base64 in images array", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: "{}" }), { status: 200 })
    );

    await provider.generate({
      prompt: "Identify food",
      image: { data: "aGVsbG8=", mimeType: "image/jpeg" },
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.images).toEqual(["aGVsbG8="]);
  });

  it("sets format: json when json mode is requested", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: "{}" }), { status: 200 })
    );

    await provider.generate({
      prompt: "test",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.format).toBe("json");
  });

  it("omits format field when json is false", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: "plain text" }), { status: 200 })
    );

    await provider.generate({
      prompt: "test",
      json: false,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.format).toBeUndefined();
  });

  it("passes the abort signal", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: "{}" }), { status: 200 })
    );

    const signal = AbortSignal.timeout(5000);
    await provider.generate({ prompt: "test", json: true, signal });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.signal).toBe(signal);
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("openai adapter request shape", () => {
  const provider = createOpenaiProvider({
    baseUrl: "https://api.openai.com",
    model: "gpt-4o",
    apiKey: "sk-test-key",
  });

  it("calls the correct URL with POST", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"dish":"Test"}' } }] }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "Identify food",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts.method).toBe("POST");
  });

  it("sends Authorization header with Bearer token", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "test",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("omits Authorization header when apiKey is null", async () => {
    const noKeyProvider = createOpenaiProvider({
      baseUrl: "http://localhost:1234",
      model: "local-model",
      apiKey: null,
    });

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        { status: 200 }
      )
    );

    await noKeyProvider.generate({
      prompt: "test",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["Authorization"]).toBeUndefined();
  });

  it("includes model and messages with text prompt in body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "Identify food",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("Identify food");
  });

  it("includes image as data URL in messages content array", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "Identify food",
      image: { data: "aGVsbG8=", mimeType: "image/png" },
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.messages[0].content).toBeInstanceOf(Array);
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "Identify food" });
    expect(body.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    });
  });

  it("sets response_format for JSON mode", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "test",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format when json is false", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "test",
      json: false,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.response_format).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe("gemini adapter request shape", () => {
  const provider = createGeminiProvider({
    model: "gemini-2.0-flash",
    apiKey: "test-gemini-key",
  });

  it("calls the correct URL with the API key and model", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"dish":"Test"}' }] } }],
        }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "Identify food",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=test-gemini-key"
    );
    expect(opts.method).toBe("POST");
  });

  it("sends Content-Type application/json", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
        }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "test",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("includes text prompt in parts", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
        }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "Identify food",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts).toContainEqual({ text: "Identify food" });
  });

  it("includes image as inlineData in parts", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
        }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "Identify food",
      image: { data: "aGVsbG8=", mimeType: "image/webp" },
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    const imagePart = body.contents[0].parts.find((p: any) => p.inlineData);
    expect(imagePart).toEqual({
      inlineData: { mimeType: "image/webp", data: "aGVsbG8=" },
    });
  });

  it("sets generationConfig.responseMimeType for JSON mode", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
        }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "test",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json" });
  });

  it("omits generationConfig when json is false", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "hello" }] } }],
        }),
        { status: 200 }
      )
    );

    await provider.generate({
      prompt: "test",
      json: false,
      signal: AbortSignal.timeout(5000),
    });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.generationConfig).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mock — does not call fetch
// ---------------------------------------------------------------------------

describe("mock adapter", () => {
  const provider = createMockProvider({ model: "mock-model" });

  it("does not call fetch", async () => {
    await provider.generate({
      prompt: "You are a food recognition assistant",
      image: { data: "aGVsbG8=", mimeType: "image/jpeg" },
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns valid JSON for recognition", async () => {
    const text = await provider.generate({
      prompt: "You are a food recognition assistant",
      image: { data: "aGVsbG8=", mimeType: "image/jpeg" },
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const parsed = JSON.parse(text);
    expect(typeof parsed.dish).toBe("string");
    expect(parsed.dish.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.ingredients)).toBe(true);
    expect(parsed.ingredients.length).toBeGreaterThanOrEqual(1);
    expect(parsed.ingredients.length).toBeLessThanOrEqual(10);
    for (const ing of parsed.ingredients) {
      expect(typeof ing.name).toBe("string");
      expect(["confident", "maybe"]).toContain(ing.confidence);
    }
  });

  it("returns valid JSON for insights", async () => {
    const text = await provider.generate({
      prompt: "You are a careful gut-health analyst SUMMARY:{}",
      json: true,
      signal: AbortSignal.timeout(5000),
    });

    const parsed = JSON.parse(text);
    expect(typeof parsed.headline).toBe("string");
    expect(parsed.headline.length).toBeGreaterThan(0);
    expect(typeof parsed.body).toBe("string");
    expect(parsed.body.length).toBeGreaterThan(0);
  });
});
