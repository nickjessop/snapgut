// Anthropic AI provider adapter — calls POST {baseUrl}/v1/messages with an API key.
// The Messages API has no response_format field, so JSON mode relies on the
// prompt-level instruction; both call sites already defend the parse.

import { joinApiPath, mergeHeaders } from "./url.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

/**
 * @param {{ baseUrl: string, model: string, apiKey: string,
 *           jsonMode?: "auto"|"json_object"|"off",
 *           extraHeaders?: Record<string, string>|null }} opts
 * @returns {import("./index.js").AiProvider}
 */
export function createAnthropicProvider({
  baseUrl,
  model,
  apiKey,
  extraHeaders = null,
}) {
  const url = joinApiPath(baseUrl, "/v1/messages");

  return {
    name: "anthropic",
    model,

    /**
     * @param {import("./index.js").AiRequest} req
     * @returns {Promise<string>}
     */
    async generate({ prompt, image, signal }) {
      /** @type {Array<Record<string, any>>} */
      const content = [];

      // Anthropic recommends placing images before the text that refers to them.
      if (image) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.data,
          },
        });
      }

      content.push({ type: "text", text: prompt });

      const body = {
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content }],
      };

      const headers = mergeHeaders(
        {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
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
          `Anthropic request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`
        );
      }

      const data = await res.json();

      const text = data?.content?.[0]?.text;
      if (text == null) {
        throw new Error(
          "Anthropic response missing content at content[0].text"
        );
      }

      return text;
    },
  };
}
