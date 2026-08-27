// Ollama AI provider adapter — calls POST {baseUrl}/api/generate.

/**
 * @param {{ baseUrl: string, model: string }} opts
 * @returns {import("./index.js").AiProvider}
 */
export function createOllamaProvider({ baseUrl, model }) {
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

      if (json) {
        body.format = "json";
      }

      const url = `${baseUrl}/api/generate`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      return data.response;
    },
  };
}
