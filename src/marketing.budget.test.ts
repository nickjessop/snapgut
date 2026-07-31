// @vitest-environment node
//
// The Marketing_Site performance budget and the image loading contract.
//
// Validates: Requirements 15.1, 15.3, 15.4, 15.5
//
// Everything here reads the real Build_Output, not the templates: the emitted
// documents in `dist/`, the assets they pull in, and `dist/size-report.json`,
// which the build writes for exactly this purpose (R15.5).
//
// Two things are worth being explicit about.
//
// First, the report is treated as evidence, not as truth. A stale or wrong
// report would otherwise be able to hide a budget breach, so every figure in it
// is recomputed from the document and the assets on disk with the same function
// the emitter used, and the two must agree. The staleness guard below covers the
// other half of that: a clean checkout, or a `marketing/` edit that has not been
// rebuilt, builds before asserting.
//
// Second, the 150 KB ceiling of R15.1 is currently about sixteen times the home
// page's actual weight, which makes a bare "under the ceiling" assertion close
// to vacuous. The ceiling is still the gate — that is the requirement — and a
// much tighter tripwire sits next to it to catch a regression while it is still
// a regression rather than a breach. Both failure messages print the measured
// figures so a failure says what the page now weighs, not just that it is too
// big.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { documentSizes, GENERATED_FILES } from "../vite/marketing.js";
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
 * A tripwire well under the requirement's ceiling. Not a requirement — a guard
 * against the ceiling's slack, since the home page currently lands near 9 kB and
 * anything approaching this number is a change worth looking at deliberately.
 * Raise it on purpose if the page genuinely needs the room.
 */
const TRIPWIRE_BYTES = 32 * 1024;

const kb = (bytes: number) => `${(bytes / 1024).toFixed(2)} kB`;
const total = (sizes: Sizes) => sizes.html + sizes.css + sizes.js;
const breakdown = (sizes: Sizes) =>
  `${kb(sizes.html)} HTML + ${kb(sizes.css)} CSS + ${kb(sizes.js)} JS = ${kb(total(sizes))} gzip`;

/** Everything the emitted documents and the report are derived from. */
const CONFIG_SOURCES = ["vite.config.ts", "vite/marketing.js", "vite/partials.js", "shared/site.js"];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

/**
 * Build only when the report is missing or older than the sources it derives
 * from, so a clean checkout works and a normal `npm test` after a build pays
 * nothing. Mirrors the guard in `src/pwa.offline.test.ts`.
 */
const buildIfStale = () => {
  const report = path.join(distDir, GENERATED_FILES.sizeReport as string);
  const reportAge = existsSync(report) ? statSync(report).mtimeMs : 0;
  const newestSource = Math.max(
    ...CONFIG_SOURCES.map((file) => statSync(path.join(repoRoot, file)).mtimeMs),
    ...filesUnder(path.join(repoRoot, "marketing")).map((file) => statSync(file).mtimeMs),
  );
  const emitted = documents.every((file) => existsSync(path.join(distDir, file)));
  if (emitted && reportAge > newestSource) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
};

let report: Record<string, Sizes>;
/** Emitted document contents, keyed by output file. */
const html: Record<string, string> = {};

beforeAll(() => {
  buildIfStale();
  report = JSON.parse(
    readFileSync(path.join(distDir, GENERATED_FILES.sizeReport as string), "utf8"),
  ) as Record<string, Sizes>;
  for (const file of documents) html[file] = readFileSync(path.join(distDir, file), "utf8");
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

describe("the build reports each Marketing_Page's compressed weight (R15.5)", () => {
  it("has an entry per Marketing_Page, with byte counts for the three classes", () => {
    expect(Object.keys(report).sort()).toEqual(pages.map((page) => page.path).sort());
    for (const page of pages) {
      const sizes = report[page.path];
      for (const key of ["html", "css", "js"] as const) {
        expect(Number.isInteger(sizes[key]), `${page.path} ${key}: ${sizes[key]}`).toBe(true);
        expect(sizes[key]).toBeGreaterThanOrEqual(0);
      }
      // A document and a stylesheet are always there; a zero would mean the
      // measurement missed them rather than that the page is weightless.
      expect(sizes.html, `${page.path} HTML`).toBeGreaterThan(0);
      expect(sizes.css, `${page.path} CSS`).toBeGreaterThan(0);
    }
  });

  it.each(pages.map((page) => [page.path, page.file] as const))(
    "%s matches the emitted document and its assets on disk",
    (pagePath, file) => {
      // Recomputed with the emitter's own function, so a stale or hand-edited
      // report cannot mask a breach of the budget asserted below.
      expect(documentSizes(html[file], distDir)).toEqual(report[pagePath]);
    },
  );
});

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
    // Source order is the only above-the-fold signal available without a
    // browser: markup before the first eagerly loaded image is the top of the
    // document, and nothing there may be deferred.
    const loading = images(file).map((image) => image.loading);
    const firstEager = loading.indexOf("eager");
    const deferredEarly = loading
      .slice(0, firstEager === -1 ? loading.length : firstEager)
      .filter((value) => value === "lazy");
    expect(deferredEarly, `${file}: a lazy image precedes every eager one`).toEqual([]);
  });
});
