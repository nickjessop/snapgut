// @vitest-environment jsdom
//
// The `robots.txt` and `sitemap.xml` the build actually shipped into `dist/`.
//
// Validates: Requirements 8.7, 8.8
//
// `src/marketing.build.test.ts` already covers the pure emitters — it calls
// `robotsTxt()` / `sitemapXml()` and drives the plugin over a throwaway `dist/`,
// so line contents and "the file is written" are settled there. This file adds
// what only the real artifact can settle:
//
//   - the shipped `dist/sitemap.xml` is well-formed XML that a conforming parser
//     accepts, in the sitemaps 0.9 namespace, rather than a string that happens
//     to contain the right substrings;
//   - the `<loc>` set read back out of that parse is exactly `indexablePaths()`
//     on the Canonical_Host, with no App_Route, no `/api/` path, and nothing
//     absent from the Route_Table (R8.8);
//   - the shipped `dist/robots.txt` resolves, under the longest-match rule a
//     crawler applies, to *allow* for every Marketing_Page and *disallow* for the
//     Login_Route, the App_Route prefix, and `/api/` (R8.7) — a property of the
//     rule set as a whole, which a per-line assertion cannot see;
//   - the `Sitemap:` reference is an absolute URL on the Canonical_Host that
//     names a file the same build emitted.
//
// The assertions read `dist/`, so a stale or absent Build_Output would make them
// meaningless; the staleness guard below rebuilds only in that case, matching
// `src/pwa.offline.test.ts`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import {
  APP_PREFIX,
  CANONICAL_ORIGIN,
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
const indexable = indexablePaths() as string[];

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

/**
 * Whether a crawler would fetch `target`: the longest matching rule wins, and an
 * `Allow` wins a tie, per the robots rule-precedence convention. An empty
 * `Disallow` value matches nothing.
 */
const isAllowed = (rules: Rule[], target: string) => {
  let winner: Rule | null = null;
  for (const rule of rules) {
    if (!rule.value || !target.startsWith(rule.value)) continue;
    if (!winner || rule.value.length > winner.value.length) winner = rule;
    else if (rule.value.length === winner.value.length && rule.allow) winner = rule;
  }
  return winner ? winner.allow : true;
};

beforeAll(() => {
  buildIfStale();
  robots = readFileSync(robotsPath, "utf8");
  sitemap = readFileSync(sitemapPath, "utf8");
  sitemapDoc = parseXml(sitemap);
}, 120_000);

describe("the shipped dist/sitemap.xml", () => {
  it("is XML a conforming parser accepts, rooted at a sitemaps 0.9 urlset", () => {
    expect(parseError(sitemapDoc)).toBe(false);
    expect(sitemapDoc.documentElement.localName).toBe("urlset");
    expect(sitemapDoc.documentElement.namespaceURI).toBe(SITEMAP_NS);
  });

  it("would have failed that parse on a malformed document", () => {
    // Without this, the check above passes for any input the parser tolerates.
    expect(parseError(parseXml(sitemap.replace("</urlset>", "")))).toBe(true);
  });

  it("gives every <url> entry exactly one <loc>", () => {
    const urls = [...sitemapDoc.getElementsByTagNameNS(SITEMAP_NS, "url")];
    expect(urls).toHaveLength(indexable.length);
    for (const url of urls) {
      expect(url.getElementsByTagNameNS(SITEMAP_NS, "loc")).toHaveLength(1);
    }
  });

  it("lists exactly indexablePaths() as absolute Canonical_Host URLs (R8.8)", () => {
    expect(locs()).toEqual(indexable.map((p) => `${CANONICAL_ORIGIN}${p}`));
    expect(new Set(locs()).size).toBe(locs().length);
  });

  it("lists no App_Route, no /api/ path, and nothing outside the Route_Table (R8.8)", () => {
    for (const loc of locs()) {
      const url = new URL(loc);
      expect(url.origin).toBe(CANONICAL_ORIGIN);
      expect(url.protocol).toBe("https:");
      expect(url.pathname.startsWith(APP_PREFIX as string)).toBe(false);
      expect(url.pathname.startsWith("/api/")).toBe(false);
      expect(indexable).toContain(url.pathname);
    }
  });
});

describe("the shipped dist/robots.txt", () => {
  it("resolves to allow for every Marketing_Page (R8.7)", () => {
    const rules = wildcardRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const page of indexable) expect(isAllowed(rules, page)).toBe(true);
  });

  it("resolves to disallow for the Login_Route, the App_Routes, and /api/ (R8.7)", () => {
    const rules = wildcardRules();
    for (const blocked of [
      LOGIN_PATH as string,
      APP_PREFIX as string,
      `${APP_PREFIX}/logs`,
      `${APP_PREFIX}/settings`,
      "/api/",
      "/api/billing/plans",
    ]) {
      expect(isAllowed(rules, blocked)).toBe(false);
    }
  });

  it("references the sitemap by absolute URL naming a file this build emitted", () => {
    const reference = robots
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().startsWith("sitemap:"));
    expect(reference).toBeDefined();

    const url = new URL(reference!.slice("sitemap:".length).trim());
    expect(url.origin).toBe(CANONICAL_ORIGIN);
    expect(url.pathname).toBe(`/${GENERATED_FILES.sitemap}`);
    expect(existsSync(path.join(distDir, url.pathname.slice(1)))).toBe(true);
  });
});
