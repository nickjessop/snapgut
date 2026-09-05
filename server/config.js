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
 * @property {{ provider: "ollama"|"openai"|"openai-compatible"|"litellm"|"anthropic"|"gemini"|"mock",
 *              baseUrl: string|null, model: string, apiKey: string|null, timeoutMs: number,
 *              jsonMode: "auto"|"json_object"|"off",
 *              extraHeaders: Record<string, string>|null }} ai
 * @property {{ email: string, password: string|null, credentialRejected: boolean }} auth
 * @property {string|null} sessionSecret
 */

const TRUTHY_VALUES = ["1", "true", "yes"];
const VALID_TRUSTED_PROXIES = ["none", "xff", "cloudflare"];
const VALID_DATASTORE_BACKENDS = ["sqlite", "memory"];
const VALID_AI_PROVIDERS = [
  "ollama",
  "openai",
  "openai-compatible",
  "litellm",
  "anthropic",
  "gemini",
  "mock",
];
const VALID_AI_JSON_MODES = ["auto", "json_object", "off"];
/** Per-provider base URL defaults. Providers absent here have no sensible default. */
const AI_DEFAULT_BASE_URLS = {
  ollama: "http://127.0.0.1:11434",
  openai: "https://api.openai.com",
  litellm: "http://127.0.0.1:4000",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];
/**
 * Minimum usable length for AUTH_PASSWORD after trimming (Req 6.14, 7.4).
 * A credential below this length is treated as if it were absent.
 */
const MIN_CREDENTIAL_LENGTH = 12;

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
  /**
   * False when AI_PROVIDER named something unrecognised. `aiProvider` still holds
   * the default in that case, so the per-provider checks below would report
   * requirements of a provider the operator never asked for. They are skipped
   * instead: the AI_PROVIDER error is the one that needs fixing first.
   */
  let aiProviderValid = true;
  if (
    aiProviderRaw !== undefined &&
    aiProviderRaw.trim() !== ""
  ) {
    const normalized = aiProviderRaw.trim().toLowerCase();
    if (!VALID_AI_PROVIDERS.includes(normalized)) {
      errors.push(
        `AI_PROVIDER must be one of ${VALID_AI_PROVIDERS.join(", ")}, got "${aiProviderRaw}"`
      );
      aiProviderValid = false;
    } else {
      aiProvider = normalized;
    }
  }

  // --- AI_BASE_URL ---
  const aiBaseUrlRaw = env.AI_BASE_URL;
  let aiBaseUrl = null;
  if (aiBaseUrlRaw && aiBaseUrlRaw.trim()) {
    aiBaseUrl = aiBaseUrlRaw.trim();
  } else if (AI_DEFAULT_BASE_URLS[aiProvider]) {
    aiBaseUrl = AI_DEFAULT_BASE_URLS[aiProvider];
  }

  // --- AI_MODEL ---
  const aiModel = (env.AI_MODEL && env.AI_MODEL.trim()) || "";

  // --- AI_API_KEY ---
  const aiApiKeyRaw = env.AI_API_KEY;
  const aiApiKey =
    aiApiKeyRaw && aiApiKeyRaw.trim() ? aiApiKeyRaw.trim() : null;

  // --- AI_TIMEOUT_MS ---
  // The value goes straight to `AbortSignal.timeout()` at the two AI call sites in
  // `server/app.js`. `AbortSignal.timeout(0)` fires on the next macrotask, so a
  // zero would abort every AI request before the model could answer — `0` is
  // invalid, not "no timeout". A negative or non-numeric value is equally unusable.
  //
  // This is an error rather than a silent reset to the default: an operator who
  // typos a reliability-relevant timeout should be told at boot, not discover
  // months later that the value they set was never in effect.
  const aiTimeoutRaw = env.AI_TIMEOUT_MS;
  let aiTimeoutMs = 120000;
  if (aiTimeoutRaw !== undefined && aiTimeoutRaw.trim() !== "") {
    const parsed = Number(aiTimeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push(
        `AI_TIMEOUT_MS must be a number of milliseconds greater than zero, got "${aiTimeoutRaw}". ` +
          `There is no way to disable the timeout: 0 aborts every AI request immediately. ` +
          `Use a large value such as 300000 instead.`
      );
    } else {
      aiTimeoutMs = parsed;
    }
  }

  // --- AI_JSON_MODE ---
  const aiJsonModeRaw = env.AI_JSON_MODE;
  let aiJsonMode = "auto";
  if (aiJsonModeRaw !== undefined && aiJsonModeRaw.trim() !== "") {
    const normalized = aiJsonModeRaw.trim().toLowerCase();
    if (!VALID_AI_JSON_MODES.includes(normalized)) {
      errors.push(
        `AI_JSON_MODE must be one of ${VALID_AI_JSON_MODES.join(", ")}, got "${aiJsonModeRaw}"`
      );
    } else {
      aiJsonMode = normalized;
    }
  }

  // --- AI_EXTRA_HEADERS ---
  const aiExtraHeadersRaw = env.AI_EXTRA_HEADERS;
  let aiExtraHeaders = null;
  if (aiExtraHeadersRaw !== undefined && aiExtraHeadersRaw.trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(aiExtraHeadersRaw.trim());
    } catch {
      errors.push(
        `AI_EXTRA_HEADERS must be a JSON object of header name to string value, ` +
          `e.g. {"X-Title":"SnapGut"} — could not parse it as JSON`
      );
    }
    if (parsed !== undefined) {
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        errors.push(
          `AI_EXTRA_HEADERS must be a JSON object, got ${Array.isArray(parsed) ? "an array" : `type "${parsed === null ? "null" : typeof parsed}"`}`
        );
      } else {
        const badKeys = Object.keys(parsed).filter(
          (key) => typeof parsed[key] !== "string"
        );
        if (badKeys.length > 0) {
          errors.push(
            `AI_EXTRA_HEADERS values must all be strings, got a non-string for ${badKeys.join(", ")}`
          );
        } else {
          aiExtraHeaders = Object.freeze({ ...parsed });
        }
      }
    }
  }

  // --- AI validation: gemini requires API key ---
  if (aiProvider === "gemini" && !aiApiKey) {
    errors.push(
      `AI_PROVIDER "gemini" requires AI_API_KEY to be set`
    );
  }

  // --- AI validation: anthropic requires API key ---
  if (aiProvider === "anthropic" && !aiApiKey) {
    errors.push(
      `AI_PROVIDER "anthropic" requires AI_API_KEY to be set`
    );
  }

  // --- AI validation: openai-compatible has no default base URL ---
  if (aiProvider === "openai-compatible" && !aiBaseUrl) {
    errors.push(
      `AI_PROVIDER "openai-compatible" requires AI_BASE_URL to be set`
    );
  }

  // --- AI validation: every network provider needs a model ---
  // Each adapter in `server/ai/` passes `model` through verbatim. An empty value
  // is rejected by Ollama, the OpenAI-shaped providers and Anthropic, and makes
  // Gemini's URL-based path a 404 — so six of the seven providers are guaranteed
  // to fail, and without this check the operator only finds out as a
  // `503 ai_unavailable` at first use. `mock` never calls out, so it tolerates it.
  if (aiProviderValid && aiProvider !== "mock" && !aiModel) {
    errors.push(
      `AI_PROVIDER "${aiProvider}" requires AI_MODEL to be set to a non-empty ` +
        `model identifier — every provider except "mock" rejects an empty model`
    );
  }

  // --- AUTH_EMAIL ---
  const authEmailRaw = env.AUTH_EMAIL;
  const authEmail =
    authEmailRaw && authEmailRaw.trim()
      ? authEmailRaw.trim().toLowerCase()
      : "admin@localhost";

  // --- AUTH_PASSWORD ---
  // A credential is only usable when, after trimming, it is non-empty and at
  // least MIN_CREDENTIAL_LENGTH characters (Req 6.14, 7.4). `.env.example` ships
  // AUTH_PASSWORD with an empty value, so Req 7.4's "equal to the .env.example
  // placeholder" clause is already covered by the empty check below.
  //
  // An unusable credential resolves to null rather than to its raw value, so the
  // existing `!config.auth.password` short-circuit in POST /api/auth/signin
  // rejects every request with the same 401 { error: "signin_failed" } it returns
  // for a credential that does not match — one rejection path, not two.
  const authPasswordRaw = env.AUTH_PASSWORD;
  const authPasswordTrimmed = authPasswordRaw ? authPasswordRaw.trim() : "";
  const authPasswordPresent = authPasswordTrimmed.length > 0;
  const authPassword =
    authPasswordTrimmed.length >= MIN_CREDENTIAL_LENGTH
      ? authPasswordTrimmed
      : null;
  // A credential was supplied and thrown away. Two states collapse into
  // `password === null` — nothing configured, and something configured that is
  // unusable — and the boot summary has to tell them apart, because the first is
  // an intentional open loopback instance and the second is a misconfiguration
  // that closes sign-in. A boolean carries that distinction without carrying the
  // value or its length (Req 6.16).
  const authCredentialRejected = authPasswordPresent && !authPassword;

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

  // --- Credential validation (Req 7.4, 6.14) ---
  // These messages name the setting and the condition that failed. They never
  // contain the credential value or its length (Req 6.16).
  if (exposedBind && !authPassword) {
    if (authPasswordPresent) {
      errors.push(
        `AUTH_PASSWORD is shorter than the ${MIN_CREDENTIAL_LENGTH}-character minimum ` +
          `and BIND_HOST is "${bindHost}" (exposed). ` +
          `Set AUTH_PASSWORD to at least ${MIN_CREDENTIAL_LENGTH} characters, ` +
          `or set BIND_HOST to 127.0.0.1, before starting the server.`
      );
    } else {
      errors.push(
        `AUTH_PASSWORD is not set and BIND_HOST is "${bindHost}" (exposed). ` +
          `The diary would be reachable beyond this machine without authentication. ` +
          `Set AUTH_PASSWORD to at least ${MIN_CREDENTIAL_LENGTH} characters, ` +
          `or set BIND_HOST to 127.0.0.1, before starting the server.`
      );
    }
  } else if (authCredentialRejected) {
    // Loopback bind: a developer should not be blocked from booting, but the
    // credential is unusable so every sign-in will be rejected.
    warnings.push(
      `AUTH_PASSWORD is shorter than the ${MIN_CREDENTIAL_LENGTH}-character minimum, ` +
        `so sign-in will be rejected for every request until it is at least ` +
        `${MIN_CREDENTIAL_LENGTH} characters.`
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
      jsonMode: aiJsonMode,
      extraHeaders: aiExtraHeaders,
    }),
    auth: Object.freeze({
      email: authEmail,
      password: authPassword,
      credentialRejected: authCredentialRejected,
    }),
    sessionSecret,
  });

  return { ok: true, config, errors: [], warnings };
}
