// @vitest-environment node
//
// The JSON-LD hash merge and the per-class Content-Security-Policy selection in
// `server/csp.js` and `server/headers.js` (Decision D3).
//
// Validates: Requirements 11.1, 11.2, 11.4, 11.5
//
// Focused on the policy choice itself: which classes get hashes, what the merge
// does to the rest of the policy, and what happens when the build's manifest is
// missing. The full route/header suite (task 7.5) drives real requests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// prettier-ignore
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { CSP, cspForMarketingPath, loadCspHashes, normalizeHashSource, withScriptHashes } from "../server/csp.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { CLASS, classifyPath, cspFor, headersFor } from "../server/headers.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { GENERATED_FILES, LOGIN_PATH, marketingPaths } from "../shared/site.js";

const HOME_HASH = "sha256-Vj7iZ0mQ0uK1x2n8p1rQ7bYy3mF9wDq0sT4uV6xX8aA=";
const OTHER_HASH = "sha256-AbC1dEf2GhI3jKl4MnO5pQr6StU7vWx8YzA9bCd0eFg=";

/** The `script-src` directive of a policy. */
const scriptSrc = (policy: string) =>
  policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src")) ?? "";

let root = "";

/** Write a `dist/csp-hashes.json` fixture and return its root. */
const manifestFixture = (contents: string) => {
  const outDir = path.join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, GENERATED_FILES.cspHashes), contents);
  return outDir;
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "snapgut-csp-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the base policy", () => {
  it("keeps script-src free of 'unsafe-inline', 'unsafe-eval', and any third-party origin", () => {
    expect(scriptSrc(CSP)).toBe("script-src 'self'");
  });
});

describe("withScriptHashes", () => {
  it("adds each hash to script-src as a quoted hash-source", () => {
    const merged = withScriptHashes(CSP, [HOME_HASH, OTHER_HASH]);
    expect(scriptSrc(merged)).toBe(`script-src 'self' '${HOME_HASH}' '${OTHER_HASH}'`);
  });

  it("leaves every other directive byte-identical", () => {
    const merged = withScriptHashes(CSP, [HOME_HASH]);
    const others = (policy: string) =>
      policy
        .split(";")
        .map((d) => d.trim())
        .filter((d) => !d.startsWith("script-src"));
    expect(others(merged)).toEqual(others(CSP));
  });

  it("returns the policy unchanged when there is nothing to add", () => {
    expect(withScriptHashes(CSP, [])).toBe(CSP);
    expect(withScriptHashes(CSP, undefined)).toBe(CSP);
  });

  it("does not repeat a hash it already carries", () => {
    const once = withScriptHashes(CSP, [HOME_HASH]);
    expect(withScriptHashes(once, [HOME_HASH, HOME_HASH])).toBe(once);
  });

  it("refuses anything that is not a hash-source, so the manifest cannot weaken the policy", () => {
    const hostile = [
      "'unsafe-inline'",
      "'unsafe-eval'",
      "https://evil.example",
      "sha256-not/valid base64",
      "sha256-abc'; script-src *",
      "*",
      "",
    ];
    for (const value of hostile) expect(normalizeHashSource(value)).toBeNull();
    expect(withScriptHashes(CSP, hostile)).toBe(CSP);
  });

  it("accepts a value the build already quoted, without double-quoting it", () => {
    expect(withScriptHashes(CSP, [`'${HOME_HASH}'`])).toBe(withScriptHashes(CSP, [HOME_HASH]));
  });
});

describe("loadCspHashes", () => {
  it("reads the build's manifest, keeping only well-formed hash sources", () => {
    const outDir = manifestFixture(
      JSON.stringify({ "/": [HOME_HASH, "'unsafe-inline'"], "/pricing": [] })
    );
    expect(loadCspHashes({ root: outDir })).toEqual({ "/": [`'${HOME_HASH}'`], "/pricing": [] });
  });

  it("falls back to an empty manifest when the file is missing or malformed", () => {
    expect(loadCspHashes({ root: path.join(root, "nope") })).toEqual({});
    expect(loadCspHashes({ root: manifestFixture("{ not json") })).toEqual({});
    expect(loadCspHashes({ root: manifestFixture('["/"]') })).toEqual({});
  });

  it("sends the base policy when the manifest is missing, weakening nothing", () => {
    const manifest = loadCspHashes({ root: path.join(root, "nope") });
    for (const p of marketingPaths() as string[]) {
      expect(cspForMarketingPath(p, manifest)).toBe(CSP);
    }
  });
});

describe("the per-class policy", () => {
  const manifest = { "/": [HOME_HASH], "/pricing": [] };

  it("adds a Marketing_Page's own hashes and no other page's", () => {
    expect(scriptSrc(cspFor(CLASS.MARKETING, "/", manifest))).toBe(
      `script-src 'self' '${HOME_HASH}'`
    );
    expect(cspFor(CLASS.MARKETING, "/pricing", manifest)).toBe(CSP);
  });

  it("leaves the App_Shell policy hash-free (Requirement 11.5)", () => {
    for (const p of [LOGIN_PATH, "/app", "/app/logs", "/app/settings"]) {
      const { class: cls, csp } = headersFor({ pathname: p, host: "snapgut.com", hashes: manifest });
      expect(cls).toBe(CLASS.APP_SHELL);
      expect(csp).toBe(CSP);
      expect(csp).not.toContain("sha256-");
    }
  });

  it("sends a policy on every response class, and never a hash outside the marketing class", () => {
    const cases: Array<[string, number]> = [
      ["/", 200],
      ["/pricing", 200],
      ["/login", 200],
      ["/app/logs", 200],
      ["/api/entries", 200],
      ["/assets/index-abc123.js", 200],
      ["/foods/apple.webp", 200],
      ["/robots.txt", 200],
      ["/pricing/", 301],
      ["/nonsense", 404],
    ];

    for (const [pathname, status] of cases) {
      const { csp } = headersFor({ pathname, host: "snapgut.com", status, hashes: manifest });
      expect(csp, pathname).toBeTruthy();
      expect(scriptSrc(csp), pathname).not.toContain("'unsafe-inline'");
      expect(scriptSrc(csp), pathname).not.toContain("'unsafe-eval'");
      if (classifyPath(pathname, status) !== CLASS.MARKETING) {
        expect(csp, pathname).toBe(CSP);
      }
    }
  });
});
