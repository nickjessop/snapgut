#!/usr/bin/env node
/**
 * Download and extract the food illustration pack.
 *
 * Downloads the release archive to a temp file, verifies its SHA-256 checksum,
 * and extracts into FOOD_PACK_DIR only after the checksum matches. Skips files
 * that already exist — safe to re-run.
 *
 * Leaves the target directory unchanged on any failure (timeout, stall, checksum
 * mismatch, or extraction error).
 *
 *   node scripts/fetch-food-pack.mjs
 *   FOOD_PACK_DIR=./my-pack node scripts/fetch-food-pack.mjs
 *
 * The pack is optional. Without it the UI renders generated letter avatars and
 * nothing else changes — see docs/food-pack.md.
 *
 * While this repository is private the release asset is not anonymously
 * downloadable, so this script will fail with an HTTP error. Until the repo is
 * public, fetch it with an authenticated account instead:
 *
 *   gh release download food-pack-v1 --pattern 'food-pack-v1.tar.gz'
 *   tar -xzf food-pack-v1.tar.gz -C ./food-pack
 *
 * Environment:
 *   FOOD_PACK_DIR  — extraction target (default: ./food-pack)
 */
import {
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Configuration — update these for each release.
// ---------------------------------------------------------------------------

/**
 * URL of the .tar.gz archive containing the food pack images.
 *
 * The archive holds bare `<slug>.webp` entries at its root — no wrapping
 * directory — which is what `extractArchive` below expects to flatten into
 * FOOD_PACK_DIR.
 */
const ARCHIVE_URL =
  "https://github.com/nickjessop/snap-gut/releases/download/food-pack-v1/food-pack-v1.tar.gz";

/**
 * Expected SHA-256 hex digest of the archive file.
 *
 * 3,036 files, 62,844,026 bytes compressed, ~66 MB extracted.
 */
const EXPECTED_SHA256 =
  "47d03aef1325bc5d1db6048c2c306ef415ccef985781f272abd2c741ea9c40c6";

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/** Maximum total download time in milliseconds. */
const TOTAL_TIMEOUT_MS = 600_000;

/** Maximum time without receiving any bytes before aborting. */
const STALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Resolve target directory
// ---------------------------------------------------------------------------

const FOOD_PACK_DIR = resolve(process.env.FOOD_PACK_DIR || "./food-pack");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fatal(message) {
  console.error(`fetch-food-pack: ${message}`);
  process.exit(1);
}

function tempFilePath() {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `food-pack-download-${id}.tar.gz`);
}

function cleanupTemp(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Download with timeout and stall detection
// ---------------------------------------------------------------------------

async function download(url, dest) {
  const controller = new AbortController();

  // Total timeout
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(totalTimer);
    if (err.name === "AbortError") {
      throw new Error(`Download timed out after ${TOTAL_TIMEOUT_MS / 1000}s (total timeout)`);
    }
    throw new Error(`Download failed: ${err.message}`);
  }

  if (!response.ok) {
    clearTimeout(totalTimer);
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const body = response.body;
  if (!body) {
    clearTimeout(totalTimer);
    throw new Error("Download failed: no response body");
  }

  const writer = createWriteStream(dest);

  // Stall detection: reset on each chunk
  let stallTimer = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  resetStallTimer();

  try {
    const reader = body.getReader();
    let done = false;

    while (!done) {
      let result;
      try {
        result = await reader.read();
      } catch (err) {
        if (err.name === "AbortError" || controller.signal.aborted) {
          // Determine if it was a stall or total timeout
          throw new Error(
            `Download stalled: no bytes received for ${STALL_TIMEOUT_MS / 1000}s`
          );
        }
        throw new Error(`Download failed: ${err.message}`);
      }

      done = result.done;
      if (!done) {
        resetStallTimer();
        writer.write(Buffer.from(result.value));
      }
    }

    writer.end();
    await new Promise((res, rej) => {
      writer.on("finish", res);
      writer.on("error", rej);
    });
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    clearTimeout(totalTimer);
  }
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

async function computeSha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Extraction (tar.gz) — skips files already present
// ---------------------------------------------------------------------------

function extractArchive(archivePath, targetDir) {
  mkdirSync(targetDir, { recursive: true });

  // Determine which files already exist so we can skip them
  const existing = new Set();
  try {
    for (const f of readdirSync(targetDir)) {
      existing.add(f);
    }
  } catch {
    // directory might not exist yet, that's fine
  }

  // List archive contents first
  let listing;
  try {
    listing = execSync(`tar -tzf "${archivePath}"`, { encoding: "utf8" });
  } catch (err) {
    throw new Error(`Extraction failed: cannot list archive contents — ${err.message}`);
  }

  const entries = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("/"));

  // Determine files to extract (skip already present)
  const toExtract = [];
  for (const entry of entries) {
    // The entry might be "food-pack/apple.webp" or just "apple.webp"
    // We want the basename
    const parts = entry.split("/");
    const basename = parts[parts.length - 1];
    if (!basename) continue;
    if (!existing.has(basename)) {
      toExtract.push(entry);
    }
  }

  if (toExtract.length === 0) {
    console.log("All files already present — nothing to extract.");
    return;
  }

  console.log(`Extracting ${toExtract.length} new files (${existing.size} already present)...`);

  // Extract to a staging temp dir first, then move files into targetDir.
  // This ensures targetDir is unchanged on extraction failure.
  const stagingDir = join(tmpdir(), `food-pack-staging-${randomBytes(8).toString("hex")}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    // Extract all needed files into staging
    // Use --strip-components to flatten if archive has a top-level directory
    // Detect if entries share a common prefix directory
    const hasPrefix = entries.length > 0 && entries.every((e) => e.includes("/"));
    const stripComponents = hasPrefix ? 1 : 0;

    try {
      execSync(
        `tar -xzf "${archivePath}" --strip-components=${stripComponents} -C "${stagingDir}"`,
        { encoding: "utf8", stdio: "pipe" }
      );
    } catch (err) {
      throw new Error(`Extraction failed: tar returned an error — ${err.message}`);
    }

    // Move only new files from staging into target
    const staged = readdirSync(stagingDir);
    let moved = 0;
    for (const file of staged) {
      const destPath = join(targetDir, file);
      if (!existsSync(destPath)) {
        copyFileSync(join(stagingDir, file), destPath);
        moved++;
      }
    }

    console.log(`Extracted ${moved} files into ${targetDir}.`);
  } finally {
    // Clean up staging directory
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Food pack target: ${FOOD_PACK_DIR}`);
  console.log(`Archive URL: ${ARCHIVE_URL}`);

  // Supply-chain guard. An all-zero digest can never be a real SHA-256, so it
  // only ever appears as an unfilled placeholder. Refuse rather than download
  // something we cannot meaningfully verify. This must keep firing for any
  // future release that lands here with the digest blanked back out.
  if (EXPECTED_SHA256 === "0".repeat(64)) {
    fatal(
      "EXPECTED_SHA256 is the all-zero placeholder — the archive cannot be verified.\n" +
        "  Set EXPECTED_SHA256 in this script to the real digest of the release asset\n" +
        "  (shasum -a 256 food-pack-v1.tar.gz), and check ARCHIVE_URL points at it."
    );
  }

  // Reject any digest that is not a well-formed 64-char hex SHA-256, so a
  // truncated or corrupted paste fails loudly here rather than at comparison.
  if (!/^[0-9a-f]{64}$/i.test(EXPECTED_SHA256)) {
    fatal(
      `EXPECTED_SHA256 is not a valid SHA-256 hex digest: "${EXPECTED_SHA256}"\n` +
        "  Expected 64 hexadecimal characters."
    );
  }

  const tempFile = tempFilePath();

  try {
    // Step 1: Download
    console.log("Downloading archive...");
    await download(ARCHIVE_URL, tempFile);
    console.log("Download complete.");

    // Step 2: Verify checksum
    console.log("Verifying SHA-256 checksum...");
    const actual = await computeSha256(tempFile);

    if (actual !== EXPECTED_SHA256.toLowerCase()) {
      fatal(
        `Checksum mismatch.\n` +
          `  Expected: ${EXPECTED_SHA256}\n` +
          `  Got:      ${actual}\n` +
          `  The archive may be corrupted or tampered with.`
      );
    }
    console.log("Checksum verified.");

    // Step 3: Extract (skip existing files)
    extractArchive(tempFile, FOOD_PACK_DIR);

    console.log("Done.");
  } catch (err) {
    cleanupTemp(tempFile);
    fatal(err.message);
  }

  cleanupTemp(tempFile);
}

main();
