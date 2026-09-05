// @vitest-environment node
//
// Tests for resolveSessionSecret from server/secret.js:
// - Generates on first run (file doesn't exist) → creates file, returns source: "generated"
// - Reuses on restart (file exists) → reads file, returns source: "file"
// - Refuses <32 chars from env → throws
// - Refuses <32 chars from file → throws
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.14

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore -- untyped ESM JavaScript
import { resolveSessionSecret } from "../server/secret.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "secret-test-"));
}

function cleanupDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe("resolveSessionSecret", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupDir(dir);
    tempDirs.length = 0;
  });

  describe("generates on first run", () => {
    it("creates a secret file and returns source: 'generated'", () => {
      const dataDir = makeTempDir();
      tempDirs.push(dataDir);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = resolveSessionSecret({ sessionSecret: null, dataDir });

      expect(result.source).toBe("generated");
      expect(result.secret.length).toBeGreaterThanOrEqual(32);
      expect(result.path).toBe(join(dataDir, "session-secret"));

      // File was actually created
      const fileContents = readFileSync(result.path!, "utf8");
      expect(fileContents).toBe(result.secret);

      // File has restrictive permissions (owner-only: 0o600)
      const stat = statSync(result.path!);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);

      // Logged the path, not the value
      expect(consoleSpy).toHaveBeenCalled();
      const loggedMessage = consoleSpy.mock.calls[0][0] as string;
      expect(loggedMessage).toContain(result.path!);
      expect(loggedMessage).not.toContain(result.secret);

      consoleSpy.mockRestore();
    });

    it("two fresh installs produce different secrets", () => {
      const dir1 = makeTempDir();
      const dir2 = makeTempDir();
      tempDirs.push(dir1, dir2);

      vi.spyOn(console, "log").mockImplementation(() => {});

      const r1 = resolveSessionSecret({ sessionSecret: null, dataDir: dir1 });
      const r2 = resolveSessionSecret({ sessionSecret: null, dataDir: dir2 });

      expect(r1.secret).not.toBe(r2.secret);

      vi.restoreAllMocks();
    });
  });

  describe("reuses on restart", () => {
    it("reads existing secret file and returns source: 'file'", () => {
      const dataDir = makeTempDir();
      tempDirs.push(dataDir);

      // Simulate first run
      const existingSecret = "a-valid-secret-that-is-at-least-32-characters-long";
      const secretPath = join(dataDir, "session-secret");
      writeFileSync(secretPath, existingSecret, { mode: 0o600 });

      const result = resolveSessionSecret({ sessionSecret: null, dataDir });

      expect(result.source).toBe("file");
      expect(result.secret).toBe(existingSecret);
      expect(result.path).toBe(secretPath);
    });

    it("previously issued tokens remain valid after restart", () => {
      const dataDir = makeTempDir();
      tempDirs.push(dataDir);

      vi.spyOn(console, "log").mockImplementation(() => {});

      // First run: generates
      const first = resolveSessionSecret({ sessionSecret: null, dataDir });
      expect(first.source).toBe("generated");

      vi.restoreAllMocks();

      // Second run: reuses the same secret
      const second = resolveSessionSecret({ sessionSecret: null, dataDir });
      expect(second.source).toBe("file");
      expect(second.secret).toBe(first.secret);
    });
  });

  describe("refuses <32 chars from env", () => {
    it("throws when SESSION_SECRET is set but too short", () => {
      expect(() =>
        resolveSessionSecret({ sessionSecret: "short", dataDir: "/unused" })
      ).toThrow();
    });

    it("throws with a descriptive message for 31-char secret", () => {
      expect(() =>
        resolveSessionSecret({ sessionSecret: "a".repeat(31), dataDir: "/unused" })
      ).toThrow(/too short/i);
    });

    it("accepts exactly 32 chars", () => {
      const result = resolveSessionSecret({
        sessionSecret: "a".repeat(32),
        dataDir: "/unused",
      });
      expect(result.source).toBe("env");
      expect(result.secret).toBe("a".repeat(32));
      expect(result.path).toBeNull();
    });
  });

  describe("refuses <32 chars from file", () => {
    it("throws when persisted secret is too short", () => {
      const dataDir = makeTempDir();
      tempDirs.push(dataDir);

      const secretPath = join(dataDir, "session-secret");
      writeFileSync(secretPath, "too-short", { mode: 0o600 });

      expect(() =>
        resolveSessionSecret({ sessionSecret: null, dataDir })
      ).toThrow(/too short/i);
    });
  });

  describe("refuses values from .env.example or the repo", () => {
    it("a generated secret is not a known placeholder", () => {
      const dataDir = makeTempDir();
      tempDirs.push(dataDir);

      vi.spyOn(console, "log").mockImplementation(() => {});

      const result = resolveSessionSecret({ sessionSecret: null, dataDir });

      // The generated secret must not be any common placeholder
      const knownPlaceholders = [
        "",
        "change-me",
        "dev-insecure-secret-change-me",
        "test-secret-for-vitest-only-do-not-use-in-production",
        "your-session-secret-here",
        "placeholder",
      ];

      for (const placeholder of knownPlaceholders) {
        expect(result.secret).not.toBe(placeholder);
      }

      // Must be cryptographically random (hex-encoded 32 bytes = 64 chars)
      expect(result.secret.length).toBe(64);
      expect(result.secret).toMatch(/^[0-9a-f]+$/);

      vi.restoreAllMocks();
    });
  });
});
