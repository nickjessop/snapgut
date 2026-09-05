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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// prettier-ignore
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { GENERATED_FILES, marketingBuild, marketingInputs, referencedAssets, robotsTxt, sitemapXml, stripComments } from "../vite/marketing.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import {
  APP_PREFIX,
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
    emit("privacy.html", "<!doctype html><html lang=\"en\"><h1>Privacy</h1></html>");
    run();
    expect(readFileSync(path.join(outDir, "privacy.html"), "utf8")).toContain("<h1>Privacy</h1>");
  });

  it("fails when the build did not emit a document the Route_Table names", () => {
    rmSync(path.join(outDir, "marketing", "privacy.html"));
    expect(run).toThrow(/did not emit marketing\/privacy\.html/);
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
        '<a href="/privacy">Privacy</a>',
        '<a href="/login">Open the app</a>',
        '<link rel="canonical" href="https://example.com/">',
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
  it("is restrictive by default (Disallow: /) when no origin is provided", () => {
    const text = robotsTxt() as string;
    expect(text).toContain("User-agent: *");
    expect(text).toContain("Disallow: /");
  });

  it("allows Marketing_Pages and disallows non-indexable classes when origin is set", () => {
    const origin = "https://example.com";
    const lines = (robotsTxt({ origin }) as string).split("\n");

    expect(lines).toContain("User-agent: *");
    for (const p of indexable) expect(lines).toContain(`Allow: ${p}`);
    expect(lines).toContain(`Disallow: ${LOGIN_PATH}`);
    expect(lines).toContain(`Disallow: ${APP_PREFIX}`);
    expect(lines).toContain("Disallow: /api/");
  });

  it("references the sitemap by absolute URL when origin is set", () => {
    const origin = "https://example.com";
    expect(robotsTxt({ origin }) as string).toContain(`Sitemap: ${origin}/sitemap.xml`);
  });

  it("is written to the Build_Output root", () => {
    run();
    expect(generated(GENERATED_FILES.robots)).toBe(robotsTxt());
  });
});

describe("sitemap.xml", () => {
  it("is empty by default when no origin is provided", () => {
    const xml = sitemapXml() as string;
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<loc>");
  });

  it("lists exactly the indexable paths as absolute URLs when origin is set", () => {
    const origin = "https://example.com";
    const locs = [...(sitemapXml({ origin }) as string).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(indexable.map((p) => `${origin}${p}`));
  });

  it("lists no App_Route, no /api/ path when origin is set", () => {
    const origin = "https://example.com";
    const locs = [...(sitemapXml({ origin }) as string).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    for (const loc of locs) {
      const { pathname } = new URL(loc);
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


