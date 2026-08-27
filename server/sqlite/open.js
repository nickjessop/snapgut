// Shared SQLite database opening logic.
// Resolves DB_PATH, ensures parent directory exists, opens the file,
// and fails with a logged path + error on an unopenable file.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Default database path when DB_PATH is unset (inside the Docker volume mount). */
export const DEFAULT_DB_PATH = "/data/snapgut.db";

/**
 * Open a SQLite database at the resolved DB_PATH.
 * - Defaults to `/data/snapgut.db` when `DB_PATH` is unset.
 * - Creates the parent directory if it doesn't exist.
 * - On failure: logs the path and error, then exits with code 1.
 *
 * @param {typeof import("node:sqlite").DatabaseSync} DatabaseSync
 * @returns {{ db: InstanceType<typeof import("node:sqlite").DatabaseSync>, dbPath: string }}
 */
export function openDatabase(DatabaseSync) {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;

  // Ensure parent directory exists (recursive handles nested paths).
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (err) {
    console.error(`Fatal: cannot create parent directory for DB_PATH="${dbPath}": ${err.message}`);
    process.exit(1);
  }

  // Open (or create) the database file.
  try {
    const db = new DatabaseSync(dbPath);
    return { db, dbPath };
  } catch (err) {
    console.error(`Fatal: cannot open database at "${dbPath}": ${err.message}`);
    process.exit(1);
  }
}
