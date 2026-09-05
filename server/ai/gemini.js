// Gemini AI provider adapter — calls the Gemini REST endpoint with an API key (no ADC).

import { normalizeBaseUrl, mergeHeaders } from "./url.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * @param {{ model: string, apiKey: string, baseUrl?: string|null,
 *           jsonMode?: "auto"|"json_object"|"off",
 *           extraHeaders?: Record<string, string>|null }} opts
 * @returns {import("./index.js").AiProvider}
 */
export function createGeminiProvider({
  model,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  jsonMode = "auto",
  extraHeaders = null,
}) {
  const host = normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL;

  return {
    name: "gemini",
    model,

    /**
     * @param {import("./index.js").AiRequest} req
     * @returns {Promise<string>}
     */
    async generate({ prompt, image, json, signal }) {
      const parts = [];

      if (image) {
        parts.push({
          inlineData: { mimeType: image.mimeType, data: image.data },
        });
      }

      parts.push({ text: prompt });

      const body = {
        contents: [{ parts }],
      };

      if (json && jsonMode !== "off") {
        body.generationConfig = { responseMimeType: "application/json" };
      }

      const url = `${host}/v1beta/models/${model}:generateContent?key=${apiKey}`;

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
          `Gemini request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`
        );
      }

      const data = await res.json();

      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (content == null) {
        throw new Error(
          "Gemini response missing content at candidates[0].content.parts[0].text"
        );
      }

      return content;
    },
  };
}
