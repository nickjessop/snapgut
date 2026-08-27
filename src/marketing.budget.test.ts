// @vitest-environment node
//
// The Marketing_Site performance budget and the image loading contract.
//
// Validates: Requirements 15.1, 15.3, 15.4
//
// Everything here reads the real Build_Output: the emitted documents in `dist/`
// and the assets they pull in. Sizes are computed directly from the files.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { referencedAssets } from "../vite/marketing.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { MARKETING_PAGES, NOT_FOUND_FILE } from "../shared/site.js";

type Page = { path: string; file: string };
type Sizes = { html: number; css: number; js: number };

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

const pages = MARKETING_PAGES as readonly Page[];
const homePage = pages.find((page) => page.path === "/")!;

/** Every emitted document that carries the marketing shell, per the Route_Table. */
const documents = [...pages.map((page) => page.file), NOT_FOUND_FILE as string];

/** Requirement 15.1: compressed HTML + CSS + JavaScript, images excluded. */
const BUDGET_BYTES = 150 * 1024;

/**
 * A tripwire well under the requirement's ceiling.
 */
const TRIPWIRE_BYTES = 32 * 1024;

const kb = (bytes: number) => `${(bytes / 1024).toFixed(2)} kB`;
const total = (sizes: Sizes) => sizes.html + sizes.css + sizes.js;
const breakdown = (sizes: Sizes) =>
  `${kb(sizes.html)} HTML + ${kb(sizes.css)} CSS + ${kb(sizes.js)} JS = ${kb(total(sizes))} gzip`;

/** Everything the emitted documents are derived from. */
const CONFIG_SOURCES = ["vite.config.ts", "vite/marketing.js", "shared/site.js"];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

const buildIfStale = () => {
  const emitted = documents.map((file) => path.join(distDir, file));
  if (!emitted.every(existsSync)) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    return;
  }
  const oldestOutput = Math.min(...emitted.map((f) => statSync(f).mtimeMs));
  const newestSource = Math.max(
    ...CONFIG_SOURCES.map((file) => statSync(path.join(repoRoot, file)).mtimeMs),
    ...filesUnder(path.join(repoRoot, "marketing")).map((file) => statSync(file).mtimeMs),
  );
  if (oldestOutput <= newestSource) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
  }
};

/** Compute gzip sizes for a document and its referenced CSS/JS assets. */
function computeSizes(htmlContent: string): Sizes {
  const htmlGzip = gzipSync(Buffer.from(htmlContent, "utf8")).length;
  let cssGzip = 0;
  let jsGzip = 0;
  const seen = new Set<string>();

  for (const ref of referencedAssets(htmlContent) as string[]) {
    if (!ref.startsWith("/") || ref.startsWith("//")) continue;
    const rel = ref.slice(1).split("?")[0].split("#")[0];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const filePath = path.join(distDir, rel);
    if (!existsSync(filePath)) continue;
    if (rel.endsWith(".css")) {
      cssGzip += gzipSync(readFileSync(filePath)).length;
    } else if (rel.endsWith(".js")) {
      jsGzip += gzipSync(readFileSync(filePath)).length;
    }
  }

  return { html: htmlGzip, css: cssGzip, js: jsGzip };
}

/** Emitted document contents, keyed by output file. */
const html: Record<string, string> = {};
const report: Record<string, Sizes> = {};

beforeAll(() => {
  buildIfStale();
  for (const file of documents) {
    html[file] = readFileSync(path.join(distDir, file), "utf8");
  }
  for (const page of pages) {
    report[page.path] = computeSizes(html[page.file]);
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMG_ELEMENT = /<img\b[^>]*>/gi;
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];

/** Every `<img>` on a page, in source order. */
const images = (file: string) => (html[file].match(IMG_ELEMENT) ?? []).map((tag) => ({
  tag,
  width: attr(tag, "width"),
  height: attr(tag, "height"),
  loading: attr(tag, "loading"),
  src: attr(tag, "src") ?? "",
}));

// ---------------------------------------------------------------------------

describe("the home page fits the compressed budget (R15.1)", () => {
  it("transfers no more than 150 KB of HTML, CSS, and JavaScript combined", () => {
    const sizes = report[homePage.path];
    expect(
      total(sizes),
      `home page is ${breakdown(sizes)}, over the ${kb(BUDGET_BYTES)} budget of R15.1`,
    ).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("stays far inside the ceiling (tripwire, not the requirement's gate)", () => {
    const sizes = report[homePage.path];
    expect(
      total(sizes),
      `home page is ${breakdown(sizes)}, past the ${kb(TRIPWIRE_BYTES)} tripwire. ` +
        `The R15.1 gate is ${kb(BUDGET_BYTES)} and is not breached — this is an early warning. ` +
        `Raise TRIPWIRE_BYTES deliberately if the page needs the room.`,
    ).toBeLessThanOrEqual(TRIPWIRE_BYTES);
  });

  it.each(pages.filter((page) => page.path !== homePage.path).map((page) => page.path))(
    "%s is within the same ceiling",
    (pagePath) => {
      const sizes = report[pagePath];
      expect(total(sizes), `${pagePath} is ${breakdown(sizes)}`).toBeLessThanOrEqual(BUDGET_BYTES);
    },
  );
});

describe("every image declares its intrinsic dimensions (R15.3)", () => {
  it("the home page has images to measure", () => {
    expect(images(homePage.file).length).toBeGreaterThan(0);
  });

  it.each(documents)("%s declares a positive integer width and height on each image", (file) => {
    for (const image of images(file)) {
      for (const [name, value] of [
        ["width", image.width],
        ["height", image.height],
      ] as const) {
        expect(value, `${file}: ${image.src} has no ${name}`).toBeDefined();
        expect(value, `${file}: ${image.src} ${name}="${value}"`).toMatch(/^\d+$/);
        expect(Number(value), `${file}: ${image.src} ${name}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the lazy/eager loading split is real (R15.4)", () => {
  it.each(documents)("%s states loading explicitly on each image", (file) => {
    for (const image of images(file)) {
      expect(image.loading, `${file}: ${image.src} has no loading attribute`).toBeDefined();
      expect(image.loading, `${file}: ${image.src}`).toMatch(/^(lazy|eager)$/);
    }
  });

  it("the home page loads its above-the-fold image eagerly and defers a below-fold one", () => {
    const loading = images(homePage.file).map((image) => image.loading);
    expect(loading, "no eagerly loaded image — nothing is prioritized for the viewport").toContain(
      "eager",
    );
    expect(loading, "no lazily loaded image — the split is not actually in effect").toContain(
      "lazy",
    );
  });

  it.each(documents)("%s defers no image ahead of its first eager one", (file) => {
    const loading = images(file).map((image) => image.loading);
    const firstEager = loading.indexOf("eager");
    const deferredEarly = loading
      .slice(0, firstEager === -1 ? loading.length : firstEager)
      .filter((value) => value === "lazy");
    expect(deferredEarly, `${file}: a lazy image precedes every eager one`).toEqual([]);
  });
});
