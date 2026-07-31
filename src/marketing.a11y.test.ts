// Accessibility of the built Marketing_Site documents — the automatable half.
//
// Validates: Requirements 10.2, 10.3, 10.4, 10.9
//
// Requirement 10.9 splits Requirement 10 in two. Landmarks with exactly one
// `main` (10.2), heading levels with no skipped level (10.3), and an `alt` on
// every image (10.4) are decidable from the markup, so they are asserted here
// against `dist/` — the documents that actually ship, after partial injection
// and flattening, not the templates. The rest of Requirement 10 — the skip
// control's behavior (10.1), keyboard operability and visible focus (10.5),
// contrast (10.6), 320 CSS px reflow (10.7), and `prefers-reduced-motion`
// (10.8) — needs a browser and assistive technology, and lives on
// `docs/launch-accessibility-checklist.md`.
//
// Two things automation deliberately does not claim here:
//   - Whether an image is decorative. Requirement 10.4 wants an empty `alt` on
//     a decorative image and a description on a meaningful one; only a person
//     can tell which is which, so this asserts the attribute is present and
//     leaves the judgement to the checklist's screen-reader pass.
//   - That a passing run means WCAG conformance. It means these three
//     structural criteria hold on every built document.
//
// The page set comes from the Route_Table, so adding a Marketing_Page brings it
// under these assertions with no edit here (Requirement 2.1). `404.html` is
// included: it is the document served for the outcome of Requirement 2.5 and is
// as public as the other four.
//
// The default jsdom environment is used rather than the `node` one the other
// `dist/` tests take, because these assertions are about parsed structure —
// `DOMParser` builds the same tree a browser would from the same bytes, which
// is a stronger reading of "heading order" and "every image" than a regex over
// the source text.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { MARKETING_PAGES, NOT_FOUND_FILE } from "../shared/site.js";

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

/** Every public document the build emits, in Route_Table order. */
const DOCUMENTS: readonly string[] = [
  ...(MARKETING_PAGES as readonly { file: string }[]).map((page) => page.file),
  NOT_FOUND_FILE as string,
];

/**
 * Everything a built document's structure is derived from. If any of it is
 * newer than the emitted HTML, the HTML is stale and the assertions below would
 * be describing a document nobody ships.
 */
const SOURCES = [
  "shared/site.js",
  "shared/plans.js",
  "vite.config.ts",
  "vite/partials.js",
  "vite/marketing.js",
  "marketing/partials/head.html",
  "marketing/partials/head-notfound.html",
  "marketing/partials/meta.html",
  "marketing/partials/header.html",
  "marketing/partials/footer.html",
  ...DOCUMENTS.map((file) => `marketing/${file}`),
];

/**
 * Build only in a clean or stale checkout, matching `src/pwa.offline.test.ts`:
 * a normal `npm test` after a build pays nothing, and a fresh clone still gets
 * a truthful run instead of a missing-file error.
 */
const buildIfStale = () => {
  const emitted = DOCUMENTS.map((file) => path.join(distDir, file));
  if (!emitted.every(existsSync)) {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    return;
  }
  const oldestOutput = Math.min(...emitted.map((file) => statSync(file).mtimeMs));
  const newestSource = Math.max(
    ...SOURCES.map((file) => statSync(path.join(repoRoot, file)).mtimeMs),
  );
  if (oldestOutput > newestSource) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
};

const parsed = new Map<string, Document>();

const doc = (file: string): Document => {
  const found = parsed.get(file);
  if (!found) throw new Error(`${file} was not parsed`);
  return found;
};

const headingLevels = (file: string) =>
  [...doc(file).querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => ({
    level: Number(h.tagName.slice(1)),
    text: (h.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
  }));

beforeAll(() => {
  buildIfStale();
  const parser = new DOMParser();
  for (const file of DOCUMENTS) {
    const html = readFileSync(path.join(distDir, file), "utf8");
    parsed.set(file, parser.parseFromString(html, "text/html"));
  }
}, 60_000);

describe("every built document is covered", () => {
  it("has one entry per Route_Table page plus the not-found document", () => {
    expect(DOCUMENTS).toContain(NOT_FOUND_FILE);
    expect(DOCUMENTS.length).toBe((MARKETING_PAGES as readonly unknown[]).length + 1);
  });
});

describe.each(DOCUMENTS)("%s", (file) => {
  // --------------------------------------------------- Requirement 10.2
  describe("landmark structure (R10.2)", () => {
    it("carries a header, a nav, and a footer landmark", () => {
      expect(doc(file).querySelectorAll("header").length).toBeGreaterThanOrEqual(1);
      expect(doc(file).querySelectorAll("nav").length).toBeGreaterThanOrEqual(1);
      expect(doc(file).querySelectorAll("footer").length).toBeGreaterThanOrEqual(1);
    });

    it("carries exactly one main", () => {
      expect(doc(file).querySelectorAll("main").length).toBe(1);
    });

    it("keeps main outside the header and footer landmarks", () => {
      // A `main` nested in a `header` or `footer` is not the page's main
      // content region, so the count above would be satisfied by a document
      // that has no such region at all.
      const main = doc(file).querySelector("main");
      expect(main?.closest("header, footer")).toBeNull();
    });

    it("puts every heading and paragraph of body content inside a landmark", () => {
      // Content adrift of all four landmarks is unreachable by landmark
      // navigation, which is the point of expressing the structure at all.
      const orphans = [...doc(file).querySelectorAll("body h1, body h2, body h3, body p")].filter(
        (el) => el.closest("header, nav, main, footer") === null,
      );
      expect(orphans.map((el) => el.tagName)).toEqual([]);
    });

    it("resolves the skip control's target to that one main", () => {
      // The automatable half of Requirement 10.1: the target exists and is the
      // main region. That it is reachable by keyboard and visible on focus is
      // on the launch checklist.
      const skip = doc(file).querySelector("a.skip-link");
      expect(skip).not.toBeNull();
      const href = skip?.getAttribute("href") ?? "";
      expect(href.startsWith("#")).toBe(true);
      const target = doc(file).getElementById(href.slice(1));
      expect(target).not.toBeNull();
      expect(target?.tagName).toBe("MAIN");
    });
  });

  // --------------------------------------------------- Requirement 10.3
  describe("heading order (R10.3)", () => {
    it("starts at h1", () => {
      const levels = headingLevels(file);
      expect(levels.length).toBeGreaterThan(0);
      expect(levels[0].level).toBe(1);
    });

    it("skips no heading level", () => {
      const levels = headingLevels(file);
      const skips = levels
        .map((heading, i) => ({ heading, previous: levels[i - 1] }))
        .filter(({ heading, previous }) => previous && heading.level > previous.level + 1)
        .map(
          ({ heading, previous }) =>
            `h${previous!.level} "${previous!.text}" → h${heading.level} "${heading.text}"`,
        );
      expect(skips).toEqual([]);
    });
  });

  // --------------------------------------------------- Requirement 10.4
  describe("image text alternatives (R10.4)", () => {
    it("carries an alt attribute on every image", () => {
      // Present, possibly empty — an empty `alt` is the correct answer for a
      // decorative image and a missing one never is. `area` and
      // `input[type=image]` are covered too so a future one cannot slip in
      // under a test that only looked at `img`.
      const images = [...doc(file).querySelectorAll("img, area, input[type=image]")];
      const missing = images
        .filter((el) => !el.hasAttribute("alt"))
        .map((el) => `${el.tagName} ${el.getAttribute("src") ?? el.getAttribute("href") ?? ""}`);
      expect(missing).toEqual([]);
    });

    it("gives no image an alt that merely repeats its filename", () => {
      // A filename read aloud is worse than nothing, and it is the usual shape
      // of an `alt` added to satisfy a checker rather than a reader.
      const offenders = [...doc(file).querySelectorAll("img[alt]")]
        .filter((img) => {
          const alt = (img.getAttribute("alt") ?? "").trim();
          if (alt === "") return false;
          const src = (img.getAttribute("src") ?? "").split("/").pop() ?? "";
          return alt.toLowerCase() === src.toLowerCase();
        })
        .map((img) => img.getAttribute("src"));
      expect(offenders).toEqual([]);
    });

    it("leaves no inline svg without a role and an accessible name", () => {
      // There are none today. If one arrives, it is an image to a screen
      // reader and needs the same treatment as `img`.
      const unnamed = [...doc(file).querySelectorAll("svg")].filter((svg) => {
        if (svg.getAttribute("aria-hidden") === "true") return false;
        const named =
          svg.hasAttribute("aria-label") ||
          svg.hasAttribute("aria-labelledby") ||
          svg.querySelector("title") !== null;
        return svg.getAttribute("role") !== "img" || !named;
      });
      expect(unnamed.length).toBe(0);
    });
  });
});
