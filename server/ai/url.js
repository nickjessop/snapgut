// Base URL helpers shared by the network adapters — normalisation and path joining.
// Gateways such as LiteLLM, vLLM and OpenRouter document base URLs that already end in
// "/v1", so appending an OpenAI-style path naively produces "/v1/v1/..." and a 404.

/**
 * Strip trailing slashes (and surrounding whitespace) from a base URL.
 * @param {string|null|undefined} baseUrl
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return "";
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Join a base URL with an API path, collapsing a duplicated "/v1" segment when the
 * base URL already ends in "/v1".
 * @param {string|null|undefined} baseUrl
 * @param {string} path - Path beginning with a slash, e.g. "/v1/chat/completions".
 * @returns {string}
 */
export function joinApiPath(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = path.startsWith("/") ? path : `/${path}`;

  if (base.endsWith("/v1") && suffix.startsWith("/v1/")) {
    return `${base}${suffix.slice("/v1".length)}`;
  }

  return `${base}${suffix}`;
}

/**
 * Merge user-supplied extra headers under the adapter's own headers, so auth and
 * content-type headers always win.
 * @param {Record<string, string>} own - The adapter's headers.
 * @param {Record<string, string>|null|undefined} extra - Headers from AI_EXTRA_HEADERS.
 * @returns {Record<string, string>}
 */
export function mergeHeaders(own, extra) {
  return { ...(extra || {}), ...own };
}
