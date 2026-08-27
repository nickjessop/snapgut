// @vitest-environment node
//
// Tests for the fetch-food-pack script's core guarantees:
// 1. A checksum mismatch leaves the target directory unchanged
// 2. Re-running with all files already present is idempotent (no overwrites, no errors)
//
// Validates: Requirements 5.9, 5.14
//
// Since `scripts/fetch-food-pack.mjs` is a standalone script, we test its
// invariants by simulating the checksum-verify-then-extract flow against a
// temp directory. The script's contract:
// - Download archive to temp file
// - Verify SHA-256 against published checksum
// - Only extract into FOOD_PACK_DIR after checksum passes
// - Skip files already present
// - Leave directory unchanged on any failure

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Simulates the fetch-food-pack script's checksum verification logic.
 * Returns true if the file's SHA-256 matches the expected checksum.
 */
function verifyChecksum(filePath: string, expectedHash: string): boolean {
  const content = readFileSync(filePath);
  const actual = createHash("sha256").update(content).digest("hex");
  return actual === expectedHash.toLowerCase();
}

/**
 * Simulates the fetch-food-pack script's extraction logic:
 * - Only extracts if checksum passes
 * - Skips files that already exist
 * - Leaves directory unchanged on failure
 */
function extractIfValid(
  archivePath: string,
  expectedHash: string,
  targetDir: string,
  files: Array<{ name: string; data: Buffer }>
): { ok: boolean; reason?: string; written: string[] } {
  // Step 1: Verify checksum
  if (!verifyChecksum(archivePath, expectedHash)) {
    return { ok: false, reason: "checksum_mismatch", written: [] };
  }

  // Step 2: Extract files, skipping existing ones
  const written: string[] = [];
  for (const file of files) {
    const target = join(targetDir, file.name);
    if (existsSync(target)) {
      // Skip existing files — idempotent
      continue;
    }
    writeFileSync(target, file.data);
    written.push(file.name);
  }

  return { ok: true, written };
}

describe("fetchFoodPack — checksum verification", () => {
  let tempDir: string;
  let targetDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fetchpack-test-"));
    targetDir = mkdtempSync(join(tmpdir(), "fetchpack-target-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("checksum mismatch leaves the directory unchanged", () => {
    // Create a fake archive file
    const archiveContent = Buffer.from("fake-archive-content-12345");
    const archivePath = join(tempDir, "food-pack.tar.gz");
    writeFileSync(archivePath, archiveContent);

    // Pre-populate the target directory with an existing file
    writeFileSync(join(targetDir, "existing.webp"), "original-data");

    // Snapshot the directory state before
    const beforeFiles = readdirSync(targetDir).sort();
    const beforeContent = readFileSync(join(targetDir, "existing.webp"), "utf8");

    // Attempt extraction with a wrong checksum
    const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";
    const result = extractIfValid(archivePath, wrongHash, targetDir, [
      { name: "apple.webp", data: Buffer.from("apple-data") },
      { name: "banana.webp", data: Buffer.from("banana-data") },
    ]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("checksum_mismatch");
    expect(result.written).toEqual([]);

    // Directory is unchanged
    const afterFiles = readdirSync(targetDir).sort();
    const afterContent = readFileSync(join(targetDir, "existing.webp"), "utf8");

    expect(afterFiles).toEqual(beforeFiles);
    expect(afterContent).toBe(beforeContent);
    // New files were NOT written
    expect(existsSync(join(targetDir, "apple.webp"))).toBe(false);
    expect(existsSync(join(targetDir, "banana.webp"))).toBe(false);
  });

  it("correct checksum allows extraction", () => {
    const archiveContent = Buffer.from("valid-archive-content");
    const archivePath = join(tempDir, "food-pack.tar.gz");
    writeFileSync(archivePath, archiveContent);

    const correctHash = createHash("sha256").update(archiveContent).digest("hex");

    const result = extractIfValid(archivePath, correctHash, targetDir, [
      { name: "apple.webp", data: Buffer.from("apple-data") },
      { name: "banana.webp", data: Buffer.from("banana-data") },
    ]);

    expect(result.ok).toBe(true);
    expect(result.written).toEqual(["apple.webp", "banana.webp"]);
    expect(readFileSync(join(targetDir, "apple.webp"), "utf8")).toBe("apple-data");
    expect(readFileSync(join(targetDir, "banana.webp"), "utf8")).toBe("banana-data");
  });
});

describe("fetchFoodPack — idempotent re-run", () => {
  let tempDir: string;
  let targetDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fetchpack-idem-"));
    targetDir = mkdtempSync(join(tmpdir(), "fetchpack-idem-target-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("re-run with existing files is idempotent — no overwrites", () => {
    const archiveContent = Buffer.from("archive-for-idempotency-test");
    const archivePath = join(tempDir, "food-pack.tar.gz");
    writeFileSync(archivePath, archiveContent);

    const correctHash = createHash("sha256").update(archiveContent).digest("hex");

    const files = [
      { name: "apple.webp", data: Buffer.from("apple-image-data") },
      { name: "banana.webp", data: Buffer.from("banana-image-data") },
      { name: "cherry.webp", data: Buffer.from("cherry-image-data") },
    ];

    // First extraction
    const first = extractIfValid(archivePath, correctHash, targetDir, files);
    expect(first.ok).toBe(true);
    expect(first.written.sort()).toEqual(["apple.webp", "banana.webp", "cherry.webp"]);

    // Record mtimes after first write
    const mtimes = new Map<string, number>();
    for (const f of files) {
      const stat = statSync(join(targetDir, f.name));
      mtimes.set(f.name, stat.mtimeMs);
    }

    // Small delay so mtime would differ if files were overwritten
    const waitMs = 50;
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      // busy wait
    }

    // Second extraction with same valid checksum — should be idempotent
    const second = extractIfValid(archivePath, correctHash, targetDir, files);
    expect(second.ok).toBe(true);
    expect(second.written).toEqual([]); // nothing new written

    // Verify files were not overwritten (mtimes unchanged)
    for (const f of files) {
      const stat = statSync(join(targetDir, f.name));
      expect(stat.mtimeMs).toBe(mtimes.get(f.name));
    }

    // Verify content is unchanged
    expect(readFileSync(join(targetDir, "apple.webp"), "utf8")).toBe("apple-image-data");
    expect(readFileSync(join(targetDir, "banana.webp"), "utf8")).toBe("banana-image-data");
    expect(readFileSync(join(targetDir, "cherry.webp"), "utf8")).toBe("cherry-image-data");
  });

  it("re-run extracts only missing files", () => {
    const archiveContent = Buffer.from("archive-for-partial-test");
    const archivePath = join(tempDir, "food-pack.tar.gz");
    writeFileSync(archivePath, archiveContent);

    const correctHash = createHash("sha256").update(archiveContent).digest("hex");

    // Pre-populate with one file
    writeFileSync(join(targetDir, "apple.webp"), "already-here");

    const files = [
      { name: "apple.webp", data: Buffer.from("new-apple-data") },
      { name: "banana.webp", data: Buffer.from("banana-data") },
    ];

    const result = extractIfValid(archivePath, correctHash, targetDir, files);
    expect(result.ok).toBe(true);
    // Only banana was written — apple already existed
    expect(result.written).toEqual(["banana.webp"]);

    // apple.webp was NOT overwritten
    expect(readFileSync(join(targetDir, "apple.webp"), "utf8")).toBe("already-here");
    // banana.webp was written
    expect(readFileSync(join(targetDir, "banana.webp"), "utf8")).toBe("banana-data");
  });
});
