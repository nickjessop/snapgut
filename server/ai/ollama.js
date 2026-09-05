// Ollama AI provider adapter — calls POST {baseUrl}/api/generate.

import { normalizeBaseUrl, mergeHeaders } from "./url.js";

/**
 * @param {{ baseUrl: string, model: string,
 *           jsonMode?: "auto"|"json_object"|"off",
 *           extraHeaders?: Record<string, string>|null }} opts
 * @returns {import("./index.js").AiProvider}
 */
export function createOllamaProvider({
  baseUrl,
  model,
  jsonMode = "auto",
  extraHeaders = null,
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/generate`;

  return {
    name: "ollama",
    model,

    /**
     * @param {import("./index.js").AiRequest} req
     * @returns {Promise<string>}
     */
    async generate({ prompt, image, json, signal }) {
      const body = {
        model,
        prompt,
        stream: false,
      };

      if (image) {
        body.images = [image.data];
      }

      if (json && jsonMode !== "off") {
        body.format = "json";
      }

      const headers = mergeHeaders(
        { "Content-Type": "application/json" },
        extraHeaders
      );

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Ollama request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`
        );
      }

      const data = await res.json();

      const content = data.response;
      if (content == null) {
        throw new Error("Ollama response missing content at response");
      }

      return content;
    },
  };
}
