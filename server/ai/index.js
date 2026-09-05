// Pluggable AI provider — selects an adapter based on config.ai.provider.

import { createOllamaProvider } from "./ollama.js";
import { createOpenaiProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createMockProvider } from "./mock.js";

export { normalizeBaseUrl, joinApiPath, mergeHeaders } from "./url.js";

/**
 * @typedef {{ prompt: string, image?: { data: string, mimeType: string },
 *              json: boolean, signal: AbortSignal }} AiRequest
 */

/**
 * @typedef {{ name: string, model: string,
 *              generate: (req: AiRequest) => Promise<string> }} AiProvider
 */

/** Configuration error thrown when a provider is unrecognised or a required setting is missing. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const SUPPORTED_PROVIDERS = [
  "ollama",
  "openai",
  "openai-compatible",
  "litellm",
  "anthropic",
  "gemini",
  "mock",
];

/**
 * Create an AI provider from the application config.
 * @param {object} config - The application config object (must have an `ai` property).
 * @returns {AiProvider}
 * @throws {ConfigError} on an unknown provider or missing required setting.
 */
export function createAiProvider(config) {
  const { provider, baseUrl, model, apiKey, jsonMode, extraHeaders } = config.ai;

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new ConfigError(
      `Unknown AI provider "${provider}". Supported values: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }

  // config.js applies these defaults too; repeated here so a hand-built config object
  // with baseUrl: null still works.
  const mode = jsonMode || "auto";
  const headers = extraHeaders || null;

  switch (provider) {
    case "ollama": {
      const url = baseUrl || "http://127.0.0.1:11434";
      if (!url || !url.trim()) {
        throw new ConfigError(
          `AI provider "ollama" requires a base URL (AI_BASE_URL). Default: http://127.0.0.1:11434`
        );
      }
      return createOllamaProvider({
        baseUrl: url,
        model,
        jsonMode: mode,
        extraHeaders: headers,
      });
    }

    case "openai": {
      const url = baseUrl || "https://api.openai.com";
      if (!url || !url.trim()) {
        throw new ConfigError(
          `AI provider "openai" requires a base URL (AI_BASE_URL). Default: https://api.openai.com`
        );
      }
      return createOpenaiProvider({
        baseUrl: url,
        model,
        apiKey,
        name: "openai",
        jsonMode: mode,
        extraHeaders: headers,
      });
    }

    case "litellm": {
      const url = baseUrl || "http://127.0.0.1:4000";
      if (!url || !url.trim()) {
        throw new ConfigError(
          `AI provider "litellm" requires a base URL (AI_BASE_URL). Default: http://127.0.0.1:4000`
        );
      }
      return createOpenaiProvider({
        baseUrl: url,
        model,
        apiKey,
        name: "litellm",
        jsonMode: mode,
        extraHeaders: headers,
      });
    }

    case "openai-compatible": {
      if (!baseUrl || !baseUrl.trim()) {
        throw new ConfigError(
          `AI provider "openai-compatible" requires a base URL (AI_BASE_URL). ` +
            `There is no default — point it at your gateway, e.g. http://127.0.0.1:8000/v1`
        );
      }
      return createOpenaiProvider({
        baseUrl,
        model,
        apiKey,
        name: "openai-compatible",
        jsonMode: mode,
        extraHeaders: headers,
      });
    }

    case "anthropic": {
      if (!apiKey || !apiKey.trim()) {
        throw new ConfigError(
          `AI provider "anthropic" requires an API key (AI_API_KEY).`
        );
      }
      const url = baseUrl || "https://api.anthropic.com";
      return createAnthropicProvider({
        baseUrl: url,
        model,
        apiKey,
        jsonMode: mode,
        extraHeaders: headers,
      });
    }

    case "gemini": {
      if (!apiKey || !apiKey.trim()) {
        throw new ConfigError(
          `AI provider "gemini" requires an API key (AI_API_KEY).`
        );
      }
      const url = baseUrl || "https://generativelanguage.googleapis.com";
      return createGeminiProvider({
        baseUrl: url,
        model,
        apiKey,
        jsonMode: mode,
        extraHeaders: headers,
      });
    }

    case "mock": {
      return createMockProvider({ model });
    }
  }
}
