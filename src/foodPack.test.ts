// Tests for server/foodPack.js — readPackFile validation and surveyPack boot survey.
// Requirements: 5.1, 5.2, 5.3, 5.4

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { readPackFile, surveyPack } from "../server/foodPack.js";

describe("readPackFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foodpack-test-"));
    writeFileSync(join(dir, "apple.webp"), Buffer.from("fake-webp-data"));
    writeFileSync(join(dir, "acai-berry.webp"), Buffer.from("berry-data"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("validation — pattern and length", () => {
    it("rejects empty name", async () => {
      const result = await readPackFile(dir, "");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects name exceeding 128 chars", async () => {
      const longName = "a".repeat(125) + ".webp"; // 129 chars
      const result = await readPackFile(dir, longName);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("accepts name at exactly 128 chars", async () => {
      const name = "a".repeat(123) + ".webp"; // 123 + 5 = 128 chars
      writeFileSync(join(dir, name), Buffer.from("data"));
      const result = await readPackFile(dir, name);
      expect(result.ok).toBe(true);
    });

    it("rejects uppercase letters", async () => {
      const result = await readPackFile(dir, "Apple.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects spaces in filename", async () => {
      const result = await readPackFile(dir, "not a slug.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects underscores", async () => {
      const result = await readPackFile(dir, "some_food.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects non-webp extensions", async () => {
      const result = await readPackFile(dir, "apple.png");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects no extension", async () => {
      const result = await readPackFile(dir, "apple");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects double extension", async () => {
      const result = await readPackFile(dir, "apple.webp.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("validation — traversal attempts", () => {
    it("rejects forward slash", async () => {
      const result = await readPackFile(dir, "../etc/passwd.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects backslash", async () => {
      const result = await readPackFile(dir, "..\\apple.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects parent-directory segments", async () => {
      const result = await readPackFile(dir, "..apple.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects null bytes", async () => {
      const result = await readPackFile(dir, "apple\0.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects percent-encoded forward slash (%2f)", async () => {
      const result = await readPackFile(dir, "a%2fb.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects percent-encoded forward slash (%2F uppercase)", async () => {
      const result = await readPackFile(dir, "a%2Fb.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects percent-encoded backslash (%5c)", async () => {
      const result = await readPackFile(dir, "a%5cb.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects percent-encoded backslash (%5C uppercase)", async () => {
      const result = await readPackFile(dir, "a%5Cb.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects percent-encoded dot-dot (%2e%2e)", async () => {
      const result = await readPackFile(dir, "%2e%2e.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects percent-encoded null byte (%00)", async () => {
      const result = await readPackFile(dir, "a%00b.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("file reading — success", () => {
    it("returns ok with bytes for a valid file", async () => {
      const result = await readPackFile(dir, "apple.webp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Buffer.isBuffer(result.bytes)).toBe(true);
        expect(result.bytes.toString()).toBe("fake-webp-data");
      }
    });

    it("returns ok with bytes for a hyphenated filename", async () => {
      const result = await readPackFile(dir, "acai-berry.webp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bytes.toString()).toBe("berry-data");
      }
    });
  });

  describe("file reading — missing", () => {
    it("returns missing for non-existent file", async () => {
      const result = await readPackFile(dir, "banana.webp");
      expect(result).toEqual({ ok: false, reason: "missing" });
    });
  });

  describe("file reading — unreadable", () => {
    it("returns unreadable for permission errors", async () => {
      const filePath = join(dir, "secret.webp");
      writeFileSync(filePath, "data", { mode: 0o000 });
      const result = await readPackFile(dir, "secret.webp");
      // On some systems root can still read 0o000 files, so allow either unreadable or ok
      expect(result.ok === false ? result.reason : "ok").toMatch(/unreadable|ok/);
    });
  });

  describe("symlink safety", () => {
    it("rejects symlinks pointing outside the directory", async () => {
      const outsideFile = join(tmpdir(), "outside-secret.webp");
      writeFileSync(outsideFile, "secret-data");
      symlinkSync(outsideFile, join(dir, "escape.webp"));
      const result = await readPackFile(dir, "escape.webp");
      expect(result).toEqual({ ok: false, reason: "invalid" });
      rmSync(outsideFile, { force: true });
    });

    it("allows symlinks pointing inside the directory", async () => {
      symlinkSync(join(dir, "apple.webp"), join(dir, "alias.webp"));
      const result = await readPackFile(dir, "alias.webp");
      expect(result.ok).toBe(true);
    });
  });
});

describe("surveyPack", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foodpack-survey-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts webp files in the directory", async () => {
    writeFileSync(join(dir, "apple.webp"), "data");
    writeFileSync(join(dir, "banana.webp"), "data");
    writeFileSync(join(dir, "readme.txt"), "ignored");
    const result = await surveyPack(dir);
    expect(result.count).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("returns count 0 for empty directory", async () => {
    const result = await surveyPack(dir);
    expect(result.count).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("returns count 0 and warning for non-existent directory", async () => {
    const result = await surveyPack("/tmp/nonexistent-food-pack-dir-xyz");
    expect(result.count).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("unreadable or absent");
  });

  it("warns about symlinks pointing outside the directory", async () => {
    const outsideFile = join(tmpdir(), "outside-pack.webp");
    writeFileSync(outsideFile, "external-data");
    writeFileSync(join(dir, "local.webp"), "local-data");
    symlinkSync(outsideFile, join(dir, "external.webp"));
    const result = await surveyPack(dir);
    expect(result.count).toBe(2); // both .webp files are counted
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("external.webp");
    expect(result.warnings[0]).toContain("outside");
    rmSync(outsideFile, { force: true });
  });

  it("does not warn about symlinks pointing inside the directory", async () => {
    writeFileSync(join(dir, "apple.webp"), "data");
    symlinkSync(join(dir, "apple.webp"), join(dir, "alias.webp"));
    const result = await surveyPack(dir);
    expect(result.count).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("warns about broken symlinks", async () => {
    symlinkSync("/tmp/nonexistent-target-xyz.webp", join(dir, "broken.webp"));
    const result = await surveyPack(dir);
    expect(result.count).toBe(1); // still counted as .webp
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("broken.webp");
    expect(result.warnings[0]).toContain("could not be resolved");
  });
});
