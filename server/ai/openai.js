// OpenAI-compatible AI provider adapter — calls POST {baseUrl}/v1/chat/completions.

/**
 * @param {{ baseUrl: string, model: string, apiKey: string|null }} opts
 * @returns {import("./index.js").AiProvider}
 */
export function createOpenaiProvider({ baseUrl, model, apiKey }) {
  return {
    name: "openai",
    model,

    /**
     * @param {import("./index.js").AiRequest} req
     * @returns {Promise<string>}
     */
    async generate({ prompt, image, json, signal }) {
      /** @type {Array<{role: string, content: string | Array<object>}>} */
      const messages = [];

      if (image) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${image.mimeType};base64,${image.data}`,
              },
            },
          ],
        });
      } else {
        messages.push({ role: "user", content: prompt });
      }

      /** @type {Record<string, any>} */
      const body = { model, messages };
      if (json) {
        body.response_format = { type: "json_object" };
      }

      /** @type {Record<string, string>} */
      const headers = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `OpenAI provider returned ${res.status}: ${text.slice(0, 200)}`
        );
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content == null) {
        throw new Error(
          "OpenAI provider returned no content in choices[0].message.content"
        );
      }

      return content;
    },
  };
}
