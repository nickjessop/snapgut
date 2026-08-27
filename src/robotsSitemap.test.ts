// @vitest-environment jsdom
//
// The `robots.txt` and `sitemap.xml` the build actually shipped into `dist/`.
//
// Validates: Requirements 8.7, 8.8
//
// After origin independence (task 6.4), the build emits restrictive defaults:
//   - robots.txt: Disallow: / (no PUBLIC_ORIGIN at build time)
//   - sitemap.xml: empty urlset (no PUBLIC_ORIGIN at build time)
//
// These tests validate the shipped artifacts reflect the no-origin default.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import {
  APP_PREFIX,
  GENERATED_FILES,
  indexablePaths,
  LOGIN_PATH,
} from "../shared/site.js";

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");
const robotsPath = path.join(distDir, GENERATED_FILES.robots as string);
const sitemapPath = path.join(distDir, GENERATED_FILES.sitemap as string);

/** Everything the two artifacts are derived from. */
const CONFIG_SOURCES = ["vite.config.ts", "vite/marketing.js", "shared/site.js"];

/** Build only when an artifact is missing or older than the config behind it. */
const buildIfStale = () => {
  const artifactAge = Math.min(
    ...[robotsPath, sitemapPath].map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0)),
  );
  const newestSource = Math.max(
    ...CONFIG_SOURCES.map((file) => statSync(path.join(repoRoot, file)).mtimeMs),
  );
  if (artifactAge > newestSource) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
};

const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

let robots = "";
let sitemap = "";
let sitemapDoc: Document;

/** Parse as XML the way a crawler would, surfacing a parse failure as an element. */
const parseXml = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");
const parseError = (doc: Document) => doc.getElementsByTagName("parsererror").length > 0;

/** The `<loc>` values, read out of the parsed tree rather than out of the text. */
const locs = () =>
  [...sitemapDoc.getElementsByTagNameNS(SITEMAP_NS, "loc")].map((el) => el.textContent ?? "");

type Rule = { allow: boolean; value: string };

/** The `User-agent: *` group's rules, in file order, comments and blanks dropped. */
const wildcardRules = (): Rule[] => {
  const rules: Rule[] = [];
  let inGroup = false;
  for (const raw of robots.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const name = field.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (name === "user-agent") {
      inGroup = value === "*";
      continue;
    }
    if (!inGroup) continue;
    if (name === "allow" || name === "disallow") rules.push({ allow: name === "allow", value });
  }
  return rules;
};

beforeAll(() => {
  buildIfStale();
  robots = readFileSync(robotsPath, "utf8");
  sitemap = readFileSync(sitemapPath, "utf8");
  sitemapDoc = parseXml(sitemap);
}, 120_000);

describe("the shipped dist/sitemap.xml (no PUBLIC_ORIGIN at build time)", () => {
  it("is XML a conforming parser accepts, rooted at a sitemaps 0.9 urlset", () => {
    expect(parseError(sitemapDoc)).toBe(false);
    expect(sitemapDoc.documentElement.localName).toBe("urlset");
    expect(sitemapDoc.documentElement.namespaceURI).toBe(SITEMAP_NS);
  });

  it("would have failed that parse on a malformed document", () => {
    expect(parseError(parseXml(sitemap.replace("</urlset>", "")))).toBe(true);
  });

  it("is empty (no <url> entries) when no PUBLIC_ORIGIN is set at build time", () => {
    const urls = [...sitemapDoc.getElementsByTagNameNS(SITEMAP_NS, "url")];
    expect(urls).toHaveLength(0);
    expect(locs()).toEqual([]);
  });
});

describe("the shipped dist/robots.txt (no PUBLIC_ORIGIN at build time)", () => {
  it("is restrictive by default: Disallow: /", () => {
    const rules = wildcardRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => !r.allow && r.value === "/")).toBe(true);
  });

  it("does not reference a sitemap when PUBLIC_ORIGIN is unset", () => {
    const sitemapLine = robots
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().startsWith("sitemap:"));
    expect(sitemapLine).toBeUndefined();
  });
});
