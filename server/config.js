// Configuration parsing and validation — pure function, no side effects.

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} bindHost
 * @property {boolean} exposedBind
 * @property {string|null} publicOrigin
 * @property {boolean} requireHttps
 * @property {"none"|"xff"|"cloudflare"} trustedProxy
 * @property {string} dataDir
 * @property {string} dbPath
 * @property {"sqlite"|"memory"} datastoreBackend
 * @property {string} foodPackDir
 * @property {{ provider: "ollama"|"openai"|"gemini"|"mock", baseUrl: string|null,
 *              model: string, apiKey: string|null, timeoutMs: number }} ai
 * @property {{ email: string, password: string|null }} auth
 * @property {string|null} sessionSecret
 */

const TRUTHY_VALUES = ["1", "true", "yes"];
const VALID_TRUSTED_PROXIES = ["none", "xff", "cloudflare"];
const VALID_DATASTORE_BACKENDS = ["sqlite", "memory"];
const VALID_AI_PROVIDERS = ["ollama", "openai", "gemini", "mock"];
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

/**
 * Determine whether a bind host is a loopback address.
 * @param {string} host
 * @returns {boolean}
 */
function isLoopback(host) {
  return LOOPBACK_HOSTS.includes(host.toLowerCase());
}

/**
 * Parse a string as a boolean (truthy: "1", "true", "yes").
 * @param {string|undefined} value
 * @returns {boolean}
 */
function parseBool(value) {
  if (!value) return false;
  return TRUTHY_VALUES.includes(value.trim().toLowerCase());
}

/**
 * Resolve and validate every setting. Pure: reads no file, logs nothing, never throws.
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: boolean, config: Config|null, errors: string[], warnings: string[] }}
 */
export function loadConfig(env) {
  const errors = [];
  const warnings = [];

  // --- PORT ---
  const portRaw = env.PORT;
  let port = 8080;
  if (portRaw !== undefined && portRaw !== "") {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      errors.push(
        `PORT must be an integer between 1 and 65535, got "${portRaw}"`
      );
    } else {
      port = parsed;
    }
  }

  // --- BIND_HOST ---
  const bindHost = (env.BIND_HOST && env.BIND_HOST.trim()) || "127.0.0.1";
  const exposedBind = !isLoopback(bindHost);

  // --- PUBLIC_ORIGIN ---
  const publicOriginRaw = env.PUBLIC_ORIGIN;
  const publicOrigin =
    publicOriginRaw && publicOriginRaw.trim() ? publicOriginRaw.trim() : null;

  // --- REQUIRE_HTTPS ---
  const requireHttps = parseBool(env.REQUIRE_HTTPS);

  // --- TRUSTED_PROXY ---
  const trustedProxyRaw = env.TRUSTED_PROXY;
  let trustedProxy = "none";
  if (trustedProxyRaw !== undefined && trustedProxyRaw.trim() !== "") {
    const normalized = trustedProxyRaw.trim().toLowerCase();
    if (!VALID_TRUSTED_PROXIES.includes(normalized)) {
      errors.push(
        `TRUSTED_PROXY must be one of ${VALID_TRUSTED_PROXIES.join(", ")}, got "${trustedProxyRaw}"`
      );
    } else {
      trustedProxy = normalized;
    }
  }

  // --- DATA_DIR ---
  const dataDir = (env.DATA_DIR && env.DATA_DIR.trim()) || "/data";

  // --- DB_PATH ---
  const dbPath =
    (env.DB_PATH && env.DB_PATH.trim()) || `${dataDir}/snapgut.db`;

  // --- DATASTORE_BACKEND ---
  const datastoreBackendRaw = env.DATASTORE_BACKEND;
  let datastoreBackend = "sqlite";
  if (
    datastoreBackendRaw !== undefined &&
    datastoreBackendRaw.trim() !== ""
  ) {
    const normalized = datastoreBackendRaw.trim().toLowerCase();
    if (!VALID_DATASTORE_BACKENDS.includes(normalized)) {
      errors.push(
        `DATASTORE_BACKEND must be one of ${VALID_DATASTORE_BACKENDS.join(", ")}, got "${datastoreBackendRaw}"`
      );
    } else {
      datastoreBackend = normalized;
    }
  }

  // --- FOOD_PACK_DIR ---
  const foodPackDir =
    (env.FOOD_PACK_DIR && env.FOOD_PACK_DIR.trim()) || "./food-pack";

  // --- AI_PROVIDER ---
  const aiProviderRaw = env.AI_PROVIDER;
  let aiProvider = "ollama";
  if (
    aiProviderRaw !== undefined &&
    aiProviderRaw.trim() !== ""
  ) {
    const normalized = aiProviderRaw.trim().toLowerCase();
    if (!VALID_AI_PROVIDERS.includes(normalized)) {
      errors.push(
        `AI_PROVIDER must be one of ${VALID_AI_PROVIDERS.join(", ")}, got "${aiProviderRaw}"`
      );
    } else {
      aiProvider = normalized;
    }
  }

  // --- AI_BASE_URL ---
  const aiBaseUrlRaw = env.AI_BASE_URL;
  let aiBaseUrl = null;
  if (aiBaseUrlRaw && aiBaseUrlRaw.trim()) {
    aiBaseUrl = aiBaseUrlRaw.trim();
  } else if (aiProvider === "ollama") {
    aiBaseUrl = "http://127.0.0.1:11434";
  }

  // --- AI_MODEL ---
  const aiModel = (env.AI_MODEL && env.AI_MODEL.trim()) || "";

  // --- AI_API_KEY ---
  const aiApiKeyRaw = env.AI_API_KEY;
  const aiApiKey =
    aiApiKeyRaw && aiApiKeyRaw.trim() ? aiApiKeyRaw.trim() : null;

  // --- AI_TIMEOUT_MS ---
  const aiTimeoutRaw = env.AI_TIMEOUT_MS;
  let aiTimeoutMs = 120000;
  if (aiTimeoutRaw !== undefined && aiTimeoutRaw.trim() !== "") {
    const parsed = Number(aiTimeoutRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      aiTimeoutMs = 120000;
    } else {
      aiTimeoutMs = parsed;
    }
  }

  // --- AI validation: gemini requires API key ---
  if (aiProvider === "gemini" && !aiApiKey) {
    errors.push(
      `AI_PROVIDER "gemini" requires AI_API_KEY to be set`
    );
  }

  // --- AUTH_EMAIL ---
  const authEmailRaw = env.AUTH_EMAIL;
  const authEmail =
    authEmailRaw && authEmailRaw.trim()
      ? authEmailRaw.trim().toLowerCase()
      : "admin@localhost";

  // --- AUTH_PASSWORD ---
  const authPasswordRaw = env.AUTH_PASSWORD;
  const authPassword =
    authPasswordRaw && authPasswordRaw.trim()
      ? authPasswordRaw.trim()
      : null;

  // --- SESSION_SECRET ---
  const sessionSecretRaw = env.SESSION_SECRET;
  let sessionSecret = null;
  if (sessionSecretRaw && sessionSecretRaw.trim()) {
    sessionSecret = sessionSecretRaw.trim();
    if (sessionSecret.length < 32) {
      errors.push(
        `SESSION_SECRET must be at least 32 characters, got ${sessionSecret.length}`
      );
    }
  }

  // --- Warnings ---
  if (exposedBind && !authPassword) {
    warnings.push(
      `BIND_HOST is "${bindHost}" (exposed) but AUTH_PASSWORD is not set. ` +
        `The diary will be accessible without authentication.`
    );
  }

  if (datastoreBackend === "memory" && exposedBind) {
    warnings.push(
      `DATASTORE_BACKEND is "memory" and BIND_HOST is "${bindHost}" (exposed). ` +
        `All data will be lost when the process exits.`
    );
  }

  // --- Build config or return errors ---
  if (errors.length > 0) {
    return { ok: false, config: null, errors, warnings };
  }

  /** @type {Config} */
  const config = Object.freeze({
    port,
    bindHost,
    exposedBind,
    publicOrigin,
    requireHttps,
    trustedProxy,
    dataDir,
    dbPath,
    datastoreBackend,
    foodPackDir,
    ai: Object.freeze({
      provider: aiProvider,
      baseUrl: aiBaseUrl,
      model: aiModel,
      apiKey: aiApiKey,
      timeoutMs: aiTimeoutMs,
    }),
    auth: Object.freeze({
      email: authEmail,
      password: authPassword,
    }),
    sessionSecret,
  });

  return { ok: true, config, errors: [], warnings };
}
