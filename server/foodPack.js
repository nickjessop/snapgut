import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Filename pattern: lowercase alphanumeric + hyphens, ending in .webp.
 * Matches the existing inline validation from server/index.js.
 */
const VALID_PATTERN = /^[a-z0-9-]+\.webp$/;

/** Maximum allowed filename length. */
const MAX_NAME_LENGTH = 128;

/**
 * Characters and sequences that indicate a path traversal attempt.
 * We reject these even though the regex above would already block most —
 * defence in depth against percent-encoded or null-byte variants.
 */
function hasTraversalAttempt(name) {
  if (name.includes("/") || name.includes("\\")) return true;
  if (name.includes("..")) return true;
  if (name.includes("\0")) return true;
  // Percent-encoded forms of the above
  if (/%2[fF]/.test(name)) return true;   // %2f or %2F → /
  if (/%5[cC]/.test(name)) return true;   // %5c or %5C → \
  if (/%2[eE].*%2[eE]/.test(name)) return true; // %2e%2e → ..
  if (/%00/.test(name)) return true;       // %00 → null byte
  return false;
}

/**
 * Read a food-pack file from `dir` by validated `name`.
 *
 * @param {string} dir - The food pack directory path.
 * @param {string} name - The requested filename (e.g. "apple.webp").
 * @returns {Promise<{ ok: true, bytes: Buffer } | { ok: false, reason: "invalid"|"missing"|"unreadable" }>}
 */
export async function readPackFile(dir, name) {
  // Validate name: reject traversal attempts, bad patterns, and overlong names
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    hasTraversalAttempt(name) ||
    !VALID_PATTERN.test(name)
  ) {
    return { ok: false, reason: "invalid" };
  }

  const filePath = join(dir, name);

  // Resolve the directory path fully (including symlinks like /var → /private/var on macOS)
  let resolvedDir;
  try {
    resolvedDir = await realpath(dir);
  } catch {
    // If the directory itself doesn't resolve, the file can't exist
    return { ok: false, reason: "missing" };
  }

  // Resolve the file's real path to catch symlink escapes
  let resolvedFile;
  try {
    resolvedFile = await realpath(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unreadable" };
  }

  // The file must resolve to be directly inside the dir (not a subdirectory, not outside)
  if (!resolvedFile.startsWith(resolvedDir + "/")) {
    return { ok: false, reason: "invalid" };
  }

  // Also verify it's a regular file (not a directory, device, etc.)
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return { ok: false, reason: "invalid" };
    }
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unreadable" };
  }

  // Read the file
  try {
    const bytes = await readFile(filePath);
    return { ok: true, bytes };
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Boot-time survey of the food pack directory.
 * Counts .webp files and warns about symlinks that point outside the directory.
 *
 * @param {string} dir - The food pack directory path.
 * @returns {Promise<{ count: number, warnings: string[] }>}
 */
export async function surveyPack(dir) {
  const warnings = [];
  let count = 0;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`Food pack directory unreadable or absent: ${dir} (${err?.code || err?.message})`);
    return { count: 0, warnings };
  }

  let resolvedDir;
  try {
    resolvedDir = await realpath(dir);
  } catch {
    resolvedDir = resolve(dir);
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".webp")) continue;
    count++;

    if (entry.isSymbolicLink()) {
      try {
        const target = await realpath(join(dir, entry.name));
        if (!target.startsWith(resolvedDir + "/") && target !== resolvedDir) {
          warnings.push(
            `Symlink "${entry.name}" points outside the food pack directory`
          );
        }
      } catch (err) {
        warnings.push(
          `Symlink "${entry.name}" could not be resolved: ${err?.message}`
        );
      }
    }
  }

  return { count, warnings };
}
