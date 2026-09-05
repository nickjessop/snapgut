// @vitest-environment node
//
// The Content-Security-Policy in `server/csp.js` and `server/headers.js`.
//
// Validates: Requirements 11.1, 11.2, 11.5
//
// After origin independence (task 6.4), the CSP is a single base policy for all
// response classes. There are no per-page hashes because the JSON-LD blocks have
// been removed.

import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { CSP, cspFor } from "../server/csp.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { CLASS, classifyPath, headersFor } from "../server/headers.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { LOGIN_PATH, marketingPaths } from "../shared/site.js";

/** The `script-src` directive of a policy. */
const scriptSrc = (policy: string) =>
  policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src")) ?? "";

describe("the base policy", () => {
  it("keeps script-src free of 'unsafe-inline', 'unsafe-eval', and any third-party origin", () => {
    expect(scriptSrc(CSP)).toBe("script-src 'self'");
  });

  it("contains default-src 'self'", () => {
    expect(CSP).toContain("default-src 'self'");
  });

  it("disallows object embeds and frames", () => {
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("frame-ancestors 'none'");
  });
});

describe("cspFor returns the same policy for all classes", () => {
  it("returns the base CSP for a Marketing_Page", () => {
    expect(cspFor(CLASS.MARKETING, "/")).toBe(CSP);
    expect(cspFor(CLASS.MARKETING, "/privacy")).toBe(CSP);
  });

  it("returns the base CSP for the App_Shell (Requirement 11.5)", () => {
    for (const p of [LOGIN_PATH, "/app", "/app/logs", "/app/settings"]) {
      expect(cspFor(CLASS.APP_SHELL, p)).toBe(CSP);
      expect(cspFor(CLASS.APP_SHELL, p)).not.toContain("sha256-");
    }
  });

  it("sends a policy on every response class, with no hashes anywhere", () => {
    const cases: Array<[string, number]> = [
      ["/", 200],
      ["/privacy", 200],
      ["/login", 200],
      ["/app/logs", 200],
      ["/api/entries", 200],
      ["/assets/index-abc123.js", 200],
      ["/foods/apple.webp", 200],
      ["/robots.txt", 200],
      ["/privacy/", 301],
      ["/nonsense", 404],
    ];

    for (const [pathname, status] of cases) {
      const { csp } = headersFor({ pathname, status });
      expect(csp, pathname).toBeTruthy();
      expect(scriptSrc(csp), pathname).not.toContain("'unsafe-inline'");
      expect(scriptSrc(csp), pathname).not.toContain("'unsafe-eval'");
      expect(scriptSrc(csp), pathname).not.toMatch(/https?:\/\//);
      expect(csp, pathname).toBe(CSP);
    }
  });
});
