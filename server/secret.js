// Session secret resolution — reads from env, persisted file, or generates a new one.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { ConfigError } from "./ai/index.js";

const SECRET_FILENAME = "session-secret";
const MIN_SECRET_LENGTH = 32;

/**
 * Resolve the session secret from config or the persisted file, generating and
 * writing one when neither exists.
 *
 * @param {{ sessionSecret: string|null, dataDir: string }} config
 * @returns {{ secret: string, source: "env"|"file"|"generated", path: string|null }}
 * @throws {ConfigError} when a supplied or persisted secret is under 32 bytes
 */
export function resolveSessionSecret(config) {
  // Case 1: SESSION_SECRET is set in environment/config
  if (config.sessionSecret && config.sessionSecret.length > 0) {
    if (config.sessionSecret.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(
        `SESSION_SECRET is too short (${config.sessionSecret.length} chars). ` +
          `Must be at least ${MIN_SECRET_LENGTH} characters.`
      );
    }
    return { secret: config.sessionSecret, source: "env", path: null };
  }

  // Case 2: No env secret — try to read persisted file
  const secretPath = join(config.dataDir, SECRET_FILENAME);

  try {
    const contents = readFileSync(secretPath, "utf8").trim();
    if (contents.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(
        `Persisted session secret at ${secretPath} is too short ` +
          `(${contents.length} chars). Must be at least ${MIN_SECRET_LENGTH} characters.`
      );
    }
    return { secret: contents, source: "file", path: secretPath };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (err.code !== "ENOENT") {
      throw new ConfigError(
        `Unable to read session secret from ${secretPath}: ${err.message}`
      );
    }
  }

  // Case 3: File doesn't exist — generate a new secret
  const generated = randomBytes(32).toString("hex"); // 64 hex chars

  // Ensure parent directory exists
  mkdirSync(dirname(secretPath), { recursive: true });

  // Write with owner-only read/write permission (0o600)
  writeFileSync(secretPath, generated, { mode: 0o600 });

  // Log the path, NEVER the value
  console.log(`Session secret generated and written to: ${secretPath}`);

  return { secret: generated, source: "generated", path: secretPath };
}
