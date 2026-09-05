// The built documents' crawlability metadata.
//
// _Requirements: 8.1, 8.2, 8.3, 8.5, 8.11_
//
// Requirement 8.11 is the reason this file reads `dist/` rather than
// `marketing/`: every value under test here is produced by the partial
// injection in `vite/partials.js`, so asserting against the templates would
// only re-state the placeholders. What a crawler receives is the flattened
// document, and that is what is parsed below.
//
// The page set comes from `MARKETING_PAGES`, so a page added to the Route_Table
// is covered by every assertion here without touching this file — which is what
// makes Requirement 8.1's "unique within the Marketing_Site" hold as the site
// grows rather than at the moment it was written.
//
// `dist/404.html` is deliberately not one of those pages. It answers every
// unknown path, so it carries no canonical URL and no `og:url` and declares
// `noindex`; its absences are asserted rather than treated as omissions.
//
// After origin independence, canonical and og:url are conditional on
// PUBLIC_ORIGIN. Since the build sets no PUBLIC_ORIGIN, those fields are absent.
// og:image is root-relative (/og.png) so it works at any origin.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MARKETING_PAGES,
  NOT_FOUND_FILE,
} from "../shared/site.js";

type MarketingPage = { path: string; file: string; title: string; description: string };

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

const pages = MARKETING_PAGES as readonly MarketingPage[];
const notFoundFile = NOT_FOUND_FILE as string;

/** Everything the emitted documents' metadata is derived from. */
const SOURCE_DIRS = ["marketing", "public", "vite"];
const SOURCE_FILES = ["vite.config.ts", "shared/site.js"];
/** The Build_Output files these assertions read. */
const OUTPUTS = [...pages.map((page) => page.file), notFoundFile];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });

const newestMtime = (files: string[]) => Math.max(...files.map((f) => statSync(f).mtimeMs));

/**
 * Build only when an output is missing or older than the sources it is derived
 * from, so these assertions never run against a stale `dist/` and a normal
 * `npm test` after a build pays nothing. Same guard as `src/pwa.offline.test.ts`
 * and `src/serverRoutes.test.ts`.
 */
const buildIfStale = () => {
  const outputs = OUTPUTS.map((file) => path.join(distDir, file));
  if (!outputs.every(existsSync)) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    return;
  }
  const sources = [
    ...SOURCE_DIRS.flatMap((dir) => filesUnder(path.join(repoRoot, dir))),
    ...SOURCE_FILES.map((file) => path.join(repoRoot, file)),
  ];
  if (newestMtime(outputs) <= newestMtime(sources)) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
  }
};

const parsed = new Map<string, Document>();

/** The built document for a Build_Output filename, parsed once. */
const documentFor = (file: string): Document => {
  const doc = parsed.get(file);
  if (!doc) throw new Error(`${file} was not read from dist/`);
  return doc;
};

const attr = (doc: Document, selector: string, name: string): string | null =>
  doc.querySelector(selector)?.getAttribute(name) ?? null;

const metaContent = (doc: Document, name: string) =>
  attr(doc, `meta[name="${name}"]`, "content");

const ogContent = (doc: Document, property: string) =>
  attr(doc, `meta[property="${property}"]`, "content");

const canonicalOf = (doc: Document) => attr(doc, 'link[rel="canonical"]', "href");

beforeAll(() => {
  buildIfStale();
  for (const file of OUTPUTS) {
    const html = readFileSync(path.join(distDir, file), "utf8");
    parsed.set(file, new DOMParser().parseFromString(html, "text/html"));
  }
}, 60_000);

describe.each(pages.map((page) => [page.path, page] as const))(
  "%s carries the metadata a crawler needs (R8.1, 8.2, 8.3, 8.5)",
  (_path, page) => {
    it("declares a language on <html> (R8.5)", () => {
      const lang = documentFor(page.file).documentElement.getAttribute("lang");
      expect(lang?.trim()).toBeTruthy();
    });

    it("carries exactly one non-empty h1 (R8.5)", () => {
      const headings = documentFor(page.file).querySelectorAll("h1");
      expect(headings).toHaveLength(1);
      expect(headings[0].textContent?.trim()).toBeTruthy();
    });

    it("carries the Route_Table title and description (R8.1)", () => {
      const doc = documentFor(page.file);
      expect(doc.title).toBe(page.title);
      expect(metaContent(doc, "description")).toBe(page.description);
    });

    it("carries no canonical URL when PUBLIC_ORIGIN is unset at build time (R8.2)", () => {
      expect(canonicalOf(documentFor(page.file))).toBeNull();
    });

    it("carries the full Open Graph set (R8.3)", () => {
      const doc = documentFor(page.file);
      expect(ogContent(doc, "og:title")).toBe(page.title);
      expect(ogContent(doc, "og:description")).toBe(page.description);
      expect(ogContent(doc, "og:type")).toBe("website");
      // og:url is absent when no PUBLIC_ORIGIN
      expect(ogContent(doc, "og:image")?.trim()).toBeTruthy();
    });

    it("declares a summary_large_image Twitter card (R8.3)", () => {
      const doc = documentFor(page.file);
      expect(metaContent(doc, "twitter:card")).toBe("summary_large_image");
      expect(metaContent(doc, "twitter:title")).toBe(page.title);
      expect(metaContent(doc, "twitter:description")).toBe(page.description);
      expect(metaContent(doc, "twitter:image")?.trim()).toBeTruthy();
    });

    it("left no partial placeholder unsubstituted", () => {
      // A missed substitution would otherwise pass every assertion above as a
      // literal `{{title}}`, unique and present but useless to a crawler.
      const html = readFileSync(path.join(distDir, page.file), "utf8");
      expect(html).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    });
  },
);

describe("the titles and descriptions are unique within the Marketing_Site (R8.1)", () => {
  it("uses each title once", () => {
    const titles = pages.map((page) => documentFor(page.file).title);
    expect(new Set(titles).size).toBe(pages.length);
  });

  it("uses each description once", () => {
    const descriptions = pages.map((page) => metaContent(documentFor(page.file), "description"));
    expect(new Set(descriptions).size).toBe(pages.length);
  });
});

describe("the og:image is a root-relative asset in the Build_Output (R8.4)", () => {
  it.each(pages.map((page) => [page.path, page] as const))(
    "%s uses a root-relative og:image path",
    (_path, page) => {
      const image = ogContent(documentFor(page.file), "og:image") ?? "";
      expect(image.startsWith("/")).toBe(true);
    },
  );

  it("resolves to a file the Build_Output contains", () => {
    for (const page of pages) {
      const image = ogContent(documentFor(page.file), "og:image") ?? "";
      expect(existsSync(path.join(distDir, image.slice(1)))).toBe(true);
    }
  });

  it("is the same image on every page, and the Twitter card uses it too", () => {
    const images = pages.flatMap((page) => {
      const doc = documentFor(page.file);
      return [ogContent(doc, "og:image"), metaContent(doc, "twitter:image")];
    });
    expect(new Set(images).size).toBe(1);
  });
});

describe("the not-found document is metadata-complete but not indexable", () => {
  it("declares a language and exactly one h1 (R8.5)", () => {
    const doc = documentFor(notFoundFile);
    expect(doc.documentElement.getAttribute("lang")?.trim()).toBeTruthy();
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
  });

  it("carries its own title and description, distinct from every page's", () => {
    const doc = documentFor(notFoundFile);
    expect(doc.title.trim()).toBeTruthy();
    expect(metaContent(doc, "description")?.trim()).toBeTruthy();
    expect(pages.map((page) => page.title)).not.toContain(doc.title);
    expect(pages.map((page) => page.description)).not.toContain(
      metaContent(doc, "description"),
    );
  });

  it("carries no canonical URL and no og:url", () => {
    const doc = documentFor(notFoundFile);
    expect(canonicalOf(doc)).toBeNull();
    expect(ogContent(doc, "og:url")).toBeNull();
  });

  it("declares noindex in the document itself", () => {
    expect(metaContent(documentFor(notFoundFile), "robots")).toBe("noindex");
  });

  it("still carries the shared OG and Twitter image", () => {
    const doc = documentFor(notFoundFile);
    expect(ogContent(doc, "og:title")).toBe(doc.title);
    expect(metaContent(doc, "twitter:card")).toBe("summary_large_image");
    const image = ogContent(doc, "og:image") ?? "";
    expect(image.startsWith("/")).toBe(true);
  });
});
