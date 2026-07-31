// @vitest-environment node
//
// The multi-page build inputs, the flatten/strip/asset-check steps, and the
// generated artifacts in `vite/marketing.js`.
//
// Validates: Requirements 7.1, 7.3, 7.4, 7.8, 7.9, 8.7, 8.8, 11.4, 15.5
//
// The plugin is driven through the same hooks Vite calls — `configResolved` then
// `writeBundle` — against a throwaway `dist/` tree, so the flattening and the
// missing-asset failure are exercised without running a real build.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
// prettier-ignore
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { documentSizes, GENERATED_FILES, jsonLdHashes, marketingBuild, marketingInputs, referencedAssets, robotsTxt, sitemapXml, stripComments } from "../vite/marketing.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import {
  APP_PREFIX,
  CANONICAL_ORIGIN,
  indexablePaths,
  LOGIN_PATH,
  MARKETING_PAGES,
  NOT_FOUND_FILE,
} from "../shared/site.js";

type Page = { path: string; file: string };
const pages = MARKETING_PAGES as readonly Page[];
const indexable = indexablePaths() as string[];

let root = "";
let outDir = "";

/** Read one generated artifact out of the throwaway `dist/`. */
const generated = (name: string) => readFileSync(path.join(outDir, name), "utf8");
const generatedJson = <T>(name: string): T => JSON.parse(generated(name)) as T;

/** Write a nested `dist/marketing/<file>` document, as Rollup would. */
const emit = (file: string, html = "<!doctype html><html lang=\"en\"><body></body></html>") => {
  // The flattening removes the directory, so re-create it for a second pass.
  mkdirSync(path.join(outDir, "marketing"), { recursive: true });
  writeFileSync(path.join(outDir, "marketing", file), html);
};

/** Run the plugin's build hooks the way Vite does. */
const run = () => {
  const plugin = marketingBuild();
  plugin.configResolved({ root, build: { outDir: "dist" } });
  plugin.writeBundle();
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "snapgut-marketing-"));
  outDir = path.join(root, "dist");
  mkdirSync(path.join(outDir, "marketing"), { recursive: true });
  for (const page of pages) emit(page.file);
  emit(NOT_FOUND_FILE);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("marketingInputs", () => {
  it("has one input per Marketing_Page plus the App_Shell and the not-found document", () => {
    const inputs = marketingInputs() as Record<string, string>;
    const values = Object.values(inputs);

    expect(values).toContain("app/index.html");
    for (const page of pages) expect(values).toContain(`marketing/${page.file}`);
    expect(values).toContain(`marketing/${NOT_FOUND_FILE}`);
    expect(values).toHaveLength(pages.length + 2);
  });

  it("names each input uniquely, so the home page cannot collide with the App_Shell", () => {
    const inputs = marketingInputs() as Record<string, string>;
    expect(Object.keys(inputs)).toHaveLength(Object.values(inputs).length);
    expect(inputs.app).toBe("app/index.html");
    expect(inputs.home).toBe("marketing/index.html");
  });
});

describe("the flattening step", () => {
  it("moves every document to the file path its Route_Table entry names", () => {
    run();
    for (const page of pages) expect(existsSync(path.join(outDir, page.file))).toBe(true);
    expect(existsSync(path.join(outDir, NOT_FOUND_FILE))).toBe(true);
  });

  it("leaves no nested marketing directory behind", () => {
    run();
    expect(existsSync(path.join(outDir, "marketing"))).toBe(false);
  });

  it("preserves each document's contents", () => {
    emit("pricing.html", "<!doctype html><html lang=\"en\"><h1>Pricing</h1></html>");
    run();
    expect(readFileSync(path.join(outDir, "pricing.html"), "utf8")).toContain("<h1>Pricing</h1>");
  });

  it("fails when the build did not emit a document the Route_Table names", () => {
    rmSync(path.join(outDir, "marketing", "pricing.html"));
    expect(run).toThrow(/did not emit marketing\/pricing\.html/);
  });

  it("is idempotent, so a second pass over an already-flat output succeeds", () => {
    run();
    mkdirSync(path.join(outDir, "marketing"), { recursive: true });
    expect(run).not.toThrow();
  });
});

describe("the comment-stripping step", () => {
  it("removes source comments from every emitted document", () => {
    emit("index.html", '<!-- checked against server/store.js --><h1>Home</h1>');
    run();
    const html = readFileSync(path.join(outDir, "index.html"), "utf8");
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("server/store.js");
    expect(html).toContain("<h1>Home</h1>");
  });

  it("hashes structured data as it ships, after the comments are gone", () => {
    const body = '{"@type":"WebSite"}';
    emit(
      "index.html",
      `<!-- a note --><script type="application/ld+json">${body}</script>`
    );
    run();
    const hashes = generatedJson<Record<string, string[]>>(GENERATED_FILES.cspHashes);
    expect(hashes["/"]).toEqual([
      `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`,
    ]);
  });
});

describe("stripComments", () => {
  it("drops a comment but keeps the markup around it", () => {
    expect(stripComments("<p>a</p><!-- note --><p>b</p>")).toBe("<p>a</p><p>b</p>");
  });

  it("drops each of several comments rather than everything between them", () => {
    expect(stripComments("<!--a--><p>keep</p><!--b-->")).toBe("<p>keep</p>");
  });

  it("leaves script and style bodies untouched", () => {
    const html = '<script type="application/ld+json">{"note":"<!-- x -->"}</script><style>/*<!--*/</style>';
    expect(stripComments(html)).toBe(html);
  });

  it("keeps a conditional comment, which is markup rather than commentary", () => {
    const html = "<!--[if IE]><p>old</p><![endif]-->";
    expect(stripComments(html)).toBe(html);
  });

  it("is idempotent", () => {
    const once = stripComments("<!doctype html>\n<!-- note -->\n<html lang=\"en\"></html>");
    expect(stripComments(once)).toBe(once);
  });
});

describe("the asset check", () => {
  it("passes when every referenced asset is in the Build_Output", () => {
    mkdirSync(path.join(outDir, "assets"), { recursive: true });
    writeFileSync(path.join(outDir, "assets", "marketing-abc123.css"), "body{}");
    emit(
      "index.html",
      '<link rel="stylesheet" href="/assets/marketing-abc123.css">'
    );
    expect(run).not.toThrow();
  });

  it("fails the build on a stylesheet the build did not emit", () => {
    emit("index.html", '<link rel="stylesheet" href="/assets/missing.css">');
    expect(run).toThrow(/missing asset[\s\S]*\/assets\/missing\.css/);
  });

  it("fails the build on a missing image, including one named by og:image", () => {
    emit("index.html", '<img src="/assets/gone.png" alt="">');
    expect(run).toThrow(/gone\.png/);

    emit("index.html", '<meta property="og:image" content="/assets/og-gone.png">');
    expect(run).toThrow(/og-gone\.png/);
  });

  it("ignores anchors, off-origin URLs, and the service worker files emitted later", () => {
    emit(
      "index.html",
      [
        '<a href="/pricing">Pricing</a>',
        '<a href="/login">Open the app</a>',
        '<link rel="canonical" href="https://snapgut.com/">',
        '<link rel="manifest" href="/manifest.webmanifest">',
        '<script src="/registerSW.js"></script>',
      ].join("")
    );
    expect(run).not.toThrow();
  });
});

describe("referencedAssets", () => {
  it("collects asset attributes and skips route anchors", () => {
    const refs = referencedAssets(
      [
        '<link rel="stylesheet" href="/assets/a.css">',
        '<script type="module" src="/assets/b.js"></script>',
        '<img src="/assets/c.png" srcset="/assets/c.png 1x, /assets/c@2x.png 2x" alt="">',
        '<a href="/terms">Terms</a>',
      ].join("")
    ) as string[];

    expect(refs).toContain("/assets/a.css");
    expect(refs).toContain("/assets/b.js");
    expect(refs).toContain("/assets/c@2x.png");
    expect(refs).not.toContain("/terms");
  });
});

describe("robots.txt", () => {
  it("allows every Marketing_Page and disallows the non-indexable classes", () => {
    const lines = (robotsTxt() as string).split("\n");

    expect(lines).toContain("User-agent: *");
    for (const path of indexable) expect(lines).toContain(`Allow: ${path}`);
    expect(lines).toContain(`Disallow: ${LOGIN_PATH}`);
    expect(lines).toContain(`Disallow: ${APP_PREFIX}`);
    expect(lines).toContain("Disallow: /api/");
  });

  it("references the sitemap by absolute URL on the Canonical_Host", () => {
    expect(robotsTxt() as string).toContain(`Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`);
  });

  it("is written to the Build_Output root", () => {
    run();
    expect(generated(GENERATED_FILES.robots)).toBe(robotsTxt());
  });
});

describe("sitemap.xml", () => {
  const locs = () => [...(sitemapXml() as string).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

  it("lists exactly the indexable paths as absolute Canonical_Host URLs", () => {
    expect(locs()).toEqual(indexable.map((p) => `${CANONICAL_ORIGIN}${p}`));
  });

  it("lists no App_Route, no /api/ path, and nothing outside the Route_Table", () => {
    for (const loc of locs()) {
      const { pathname, origin } = new URL(loc);
      expect(origin).toBe(CANONICAL_ORIGIN);
      expect(pathname.startsWith(APP_PREFIX)).toBe(false);
      expect(pathname.startsWith("/api/")).toBe(false);
      expect(indexable).toContain(pathname);
    }
  });

  it("is written to the Build_Output root as well-formed XML", () => {
    run();
    const xml = generated(GENERATED_FILES.sitemap);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });
});

describe("csp-hashes.json", () => {
  const jsonLd = '{"@context":"https://schema.org","@type":"WebSite"}';

  it("hashes each structured-data block in the form script-src takes verbatim", () => {
    const hashes = jsonLdHashes(
      `<script type="application/ld+json">${jsonLd}</script>`
    ) as string[];

    const expected =
      "sha256-" + createHash("sha256").update(jsonLd, "utf8").digest("base64");
    expect(hashes).toEqual([expected]);
    expect(hashes[0]).toMatch(/^sha256-[A-Za-z0-9+/]+={0,2}$/);
  });

  it("ignores module scripts and inline scripts of other types", () => {
    const hashes = jsonLdHashes(
      [
        '<script type="module" src="/assets/a.js"></script>',
        "<script>console.log(1)</script>",
      ].join("")
    ) as string[];
    expect(hashes).toEqual([]);
  });

  it("has one entry per Marketing_Page, holding that page's hashes", () => {
    emit("index.html", `<html lang="en"><script type="application/ld+json">${jsonLd}</script></html>`);
    run();

    const report = generatedJson<Record<string, string[]>>(GENERATED_FILES.cspHashes);
    expect(Object.keys(report).sort()).toEqual([...indexable].sort());
    expect(report["/"]).toEqual(jsonLdHashes(`<script type="application/ld+json">${jsonLd}</script>`));
    expect(report["/pricing"]).toEqual([]);
  });
});

describe("size-report.json", () => {
  it("reports gzip bytes for the document and the assets it pulls in", () => {
    const css = "body{color:#111}".repeat(20);
    const js = "console.log('hi');".repeat(20);
    mkdirSync(path.join(outDir, "assets"), { recursive: true });
    writeFileSync(path.join(outDir, "assets", "marketing-abc123.css"), css);
    writeFileSync(path.join(outDir, "assets", "standalone-abc123.js"), js);

    const html = [
      '<!doctype html><html lang="en"><head>',
      '<link rel="stylesheet" href="/assets/marketing-abc123.css">',
      '<script type="module" src="/assets/standalone-abc123.js"></script>',
      "</head><body></body></html>",
    ].join("");
    emit("index.html", html);
    run();

    const report = generatedJson<Record<string, { html: number; css: number; js: number }>>(
      GENERATED_FILES.sizeReport
    );
    expect(Object.keys(report).sort()).toEqual([...indexable].sort());
    expect(report["/"].html).toBe(gzipSync(Buffer.from(html, "utf8")).length);
    expect(report["/"].css).toBe(gzipSync(Buffer.from(css)).length);
    expect(report["/"].js).toBe(gzipSync(Buffer.from(js)).length);
  });

  it("counts an asset referenced twice once, and excludes images", () => {
    mkdirSync(path.join(outDir, "assets"), { recursive: true });
    writeFileSync(path.join(outDir, "assets", "a.css"), "body{}");
    writeFileSync(path.join(outDir, "assets", "og.png"), Buffer.alloc(4096, 7));

    const sizes = documentSizes(
      [
        '<link rel="stylesheet" href="/assets/a.css">',
        '<link rel="stylesheet" href="/assets/a.css">',
        '<img src="/assets/og.png" alt="">',
      ].join(""),
      outDir
    ) as { css: number; js: number };

    expect(sizes.css).toBe(gzipSync(Buffer.from("body{}")).length);
    expect(sizes.js).toBe(0);
  });

  it("gives the budget check a total it can compare against 150 KB", () => {
    run();
    const report = generatedJson<Record<string, { html: number; css: number; js: number }>>(
      GENERATED_FILES.sizeReport
    );
    const home = report["/"];
    expect(home.html + home.css + home.js).toBeLessThan(150 * 1024);
  });
});
