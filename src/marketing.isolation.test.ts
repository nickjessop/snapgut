// The no-JavaScript and isolation guarantees of the built Marketing_Site.
//
// Validates: Requirements 1.6, 1.7, 7.7, 11.3, 11.6
//
// Four separate promises, all asserted against `dist/` — the documents and
// chunks that actually ship, after partial injection, bundling, and flattening:
//
//   - R11.3 no inline `<script>` on a Marketing_Page beyond an
//     `application/ld+json` block whose hash the server will send in
//     `script-src` (R11.4), so the strict CSP of R11.2 stays sufficient.
//   - R11.6 nothing — script, stylesheet, image, font, or frame — is loaded
//     from a third-party origin.
//   - R7.7  the Marketing_Pages load no JavaScript module from the SnapGut_App
//     bundle, and the App_Shell loads no Marketing_Site stylesheet.
//   - R1.6 / R1.7 rendering a Marketing_Page requests no `/api/*` path and
//     touches neither IndexedDB nor `localStorage`.
//
// ## The `modulepreload-polyfill` chunk, and why it is not a 7.7 violation
//
// Vite's default `build.modulePreload.polyfill` emits one shared chunk that
// both entry documents statically import, so the home page and the App_Shell do
// reference the same `.js` file. Read literally, that is a module the marketing
// page shares with the app's output.
//
// It carries no application code. It is a Vite build shim: it feature-detects
// `link[rel=modulepreload]` support, returns immediately where the browser has
// it, and otherwise `fetch`es the hrefs of the preload links already in the
// document and any added later. It imports nothing, is well under a kilobyte,
// and contains no app source — no React, no IndexedDB, no `/api/` path, no
// Workbox.
//
// So the reading taken here is that R7.7 forbids shipping *app logic* to a
// marketing page, and a build shim the bundler emits for both documents is not
// that. The test below does not simply tolerate the overlap: it
// pins it. Every module shared between the two graphs must pass
// `describeShim` — right chunk name, no imports, under the size ceiling, and
// free of every app marker — and the App_Shell's own entry chunk must appear in
// no marketing graph at all. Anything else shared, or a shim that grows app
// code, fails.
//
// Setting `build.modulePreload: { polyfill: false }` would remove the overlap
// outright, at the cost of the preload optimisation on browsers without
// `modulepreload` support. That is a `vite.config.ts` decision, recorded here
// rather than taken here.
//
// ## Reading the markup
//
// The `/api/*` and third-party checks look only at positions that cause a
// fetch — URL-bearing attributes, and the text of the same-origin scripts and
// stylesheets the pages pull in. An `<a href>` is the one exception: following it
// is a navigation the reader chooses, not a subresource the page loads, so an
// off-origin anchor does not put a third party in the page's rendering path.
// R11.6 therefore does not reach anchors — but they are not simply waved
// through: the off-origin destinations they may name are pinned to a list below,
// so adding one is an edit here. Today that list holds the repository link the
// footer carries, which is the source offer AGPL section 13 expects. The privacy and terms pages both name `/api/*`
// paths in HTML source comments that cite where a claim comes from, and the
// privacy copy describes what is transmitted; prose and comments issue no
// request, so they are out of scope for R1.6. Comment-stripped markup is
// checked all the same, which keeps a stray `<a href>` or form action from
// hiding in copy.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { MARKETING_PAGES, NOT_FOUND_FILE } from "../shared/site.js";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { APP_SHELL_DOCUMENT } from "../vite/pwa.js";

type Page = { path: string; file: string };

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

const pages = MARKETING_PAGES as readonly Page[];
const appShellFile = APP_SHELL_DOCUMENT as string;

/** Every public marketing document, per the Route_Table, plus the not-found page. */
const DOCUMENTS: readonly string[] = [...pages.map((page) => page.file), NOT_FOUND_FILE as string];

/**
 * A shared build shim may not exceed this. The polyfill is ~0.7 kB; a chunk
 * that grew past this is carrying something other than preload plumbing.
 */
const SHIM_CEILING_BYTES = 4 * 1024;

/**
 * Markers of application code. None of these may appear in a module a
 * Marketing_Page loads, which covers R1.6 and R1.7 for the pages' own scripts
 * as well as the shared-chunk question of R7.7.
 */
const APP_MARKERS = [
  "indexedDB",
  "localStorage",
  "sessionStorage",
  "/api/",
  "workbox",
  "react",
  "snapgut",
];

// ---------------------------------------------------------------------------
// Staleness guard
// ---------------------------------------------------------------------------

/**
 * What the emitted documents and the module graphs are derived from.
 *
 * `src/` is deliberately absent. A change under `src/` alters the app chunk's
 * contents but cannot make a chunk shared with a marketing page — that takes a
 * marketing entry importing it, which is a `marketing/` change. Rebuilding on
 * every `src/` edit would make this test the slowest thing in the suite for no
 * assertion it could not otherwise make.
 */
const SOURCE_DIRS = ["marketing", "vite", "shared"];
const SOURCE_FILES = ["vite.config.ts", `${appShellFile}`];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

/**
 * Build only in a clean or stale checkout, mirroring `src/pwa.offline.test.ts`:
 * a normal `npm test` after a build pays nothing, and a fresh clone gets a
 * truthful run rather than a missing-file error.
 */
const buildIfStale = () => {
  const emitted = [...DOCUMENTS, appShellFile].map((file) =>
    path.join(distDir, file),
  );
  if (emitted.every(existsSync)) {
    const oldestOutput = Math.min(...emitted.map((file) => statSync(file).mtimeMs));
    const newestSource = Math.max(
      ...SOURCE_FILES.map((file) => statSync(path.join(repoRoot, file)).mtimeMs),
      ...SOURCE_DIRS.flatMap((dir) =>
        filesUnder(path.join(repoRoot, dir)).map((file) => statSync(file).mtimeMs),
      ),
    );
    if (oldestOutput > newestSource) return;
  }
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
};

// ---------------------------------------------------------------------------
// Loading the Build_Output
// ---------------------------------------------------------------------------

const source = new Map<string, string>();
const parsed = new Map<string, Document>();

const html = (file: string): string => {
  const found = source.get(file);
  if (found === undefined) throw new Error(`${file} was not read`);
  return found;
};

const doc = (file: string): Document => {
  const found = parsed.get(file);
  if (!found) throw new Error(`${file} was not parsed`);
  return found;
};

/** Markup with HTML comments removed: everything the browser acts on. */
const withoutComments = (file: string) => html(file).replace(/<!--[\s\S]*?-->/g, "");

beforeAll(() => {
  buildIfStale();
  const parser = new DOMParser();
  for (const file of [...DOCUMENTS, appShellFile]) {
    const text = readFileSync(path.join(distDir, file), "utf8");
    source.set(file, text);
    parsed.set(file, parser.parseFromString(text, "text/html"));
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Fetch-causing references
// ---------------------------------------------------------------------------

/** Attributes whose value the browser resolves and fetches. */
const URL_ATTRIBUTES = ["src", "href", "srcset", "poster", "data", "action", "formaction"];

/** Every URL a document asks the browser to fetch, with the element that asked. */
const fetchedUrls = (file: string) =>
  [...doc(file).querySelectorAll("*")].flatMap((el) =>
    URL_ATTRIBUTES.filter((name) => el.hasAttribute(name)).flatMap((name) =>
      // `srcset` is a candidate list; the rest are single URLs.
      (name === "srcset" ? el.getAttribute(name)!.split(",") : [el.getAttribute(name)!])
        .map((value) => value.trim().split(/\s+/)[0])
        .filter((value) => value !== "")
        .map((value) => ({
          el,
          name,
          value,
          where: `${file}: <${el.tagName.toLowerCase()} ${name}>`,
        })),
    ),
  );

/** True where a URL points at this origin: a path or a fragment. */
const sameOrigin = (value: string) =>
  value.startsWith("#") ||
  (value.startsWith("/") && !value.startsWith("//"));

/** Same-origin absolute paths only — what can be resolved to a file in `dist/`. */
const localPath = (value: string) => value;

const stylesheetsOf = (file: string) =>
  [...doc(file).querySelectorAll('link[rel~="stylesheet"]')]
    .map((el) => localPath(el.getAttribute("href") ?? ""))
    .filter((href) => href.startsWith("/"));

// ---------------------------------------------------------------------------
// Module graphs
// ---------------------------------------------------------------------------

/** Static and dynamic import specifiers, and re-exports, in emitted chunk code. */
const IMPORT_SPECIFIER =
  /(?:\bimport\s*\(\s*|\bimport\s*|\bfrom\s*|\bexport\s*\*\s*from\s*)["']([^"']+)["']/g;

const chunk = (module: string) => readFileSync(path.join(distDir, module), "utf8");

/** The modules a document executes as an entry point: its `<script type=module>` set. */
const entryScripts = (file: string) =>
  [...doc(file).querySelectorAll("script[src]")]
    .filter((el) => (el.getAttribute("type") ?? "").toLowerCase() === "module")
    .map((el) => localPath(el.getAttribute("src") ?? ""))
    .filter((url) => url.startsWith("/") && url.endsWith(".js"));

/** The modules a document loads directly: module scripts and preload links. */
const entryModules = (file: string) => {
  const scripts = entryScripts(file);
  const preloads = [...doc(file).querySelectorAll('link[rel="modulepreload"], link[rel="preload"]')]
    .filter((el) => {
      const rel = el.getAttribute("rel");
      return rel === "modulepreload" || el.getAttribute("as") === "script";
    })
    .map((el) => localPath(el.getAttribute("href") ?? ""));
  return [...scripts, ...preloads].filter((url) => url.startsWith("/") && url.endsWith(".js"));
};

/**
 * Every module a document can end up executing: its entry modules and
 * everything they import, statically or dynamically, resolved against `dist/`.
 * Paths are returned relative to the Build_Output root.
 */
const moduleGraph = (file: string): string[] => {
  const seen = new Set<string>();
  const queue = entryModules(file).map((url) => url.slice(1));
  while (queue.length > 0) {
    const module = queue.pop()!;
    if (seen.has(module)) continue;
    seen.add(module);
    const onDisk = path.join(distDir, module);
    if (!existsSync(onDisk)) throw new Error(`${file} loads ${module}, which is not in dist/`);
    for (const [, specifier] of chunk(module).matchAll(IMPORT_SPECIFIER)) {
      if (!specifier.startsWith(".")) continue;
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(module), specifier)));
    }
  }
  return [...seen].sort();
};

/**
 * Why a module is or is not an app-code-free build shim. Returns the reasons it
 * fails, so a failure message names them rather than just saying "false".
 */
const describeShim = (module: string) => {
  const code = chunk(module);
  const reasons: string[] = [];
  if (!/^modulepreload-polyfill-[\w-]+\.js$/.test(path.posix.basename(module))) {
    reasons.push("is not the Vite modulepreload polyfill chunk");
  }
  const imports = [...code.matchAll(IMPORT_SPECIFIER)].map(([, specifier]) => specifier);
  if (imports.length > 0) reasons.push(`imports ${imports.join(", ")}`);
  if (Buffer.byteLength(code) > SHIM_CEILING_BYTES) {
    reasons.push(`is ${Buffer.byteLength(code)} bytes, over the ${SHIM_CEILING_BYTES} ceiling`);
  }
  for (const marker of APP_MARKERS) {
    if (code.includes(marker)) reasons.push(`contains "${marker}"`);
  }
  if (!code.includes("modulepreload")) reasons.push("does not mention modulepreload");
  return reasons;
};

// ---------------------------------------------------------------------------
// Requirement 11.3 — no inline script beyond hashed JSON-LD
// ---------------------------------------------------------------------------

describe("Marketing_Pages carry no inline script beyond hashed JSON-LD (R11.3)", () => {
  it.each(DOCUMENTS)("%s has no inline script that is not application/ld+json", (file) => {
    const offenders = [...doc(file).querySelectorAll("script")]
      .filter((el) => !el.hasAttribute("src"))
      .filter((el) => (el.getAttribute("type") ?? "").toLowerCase() !== "application/ld+json")
      .map((el) => `type=${el.getAttribute("type") ?? "(none)"}: ${el.textContent?.slice(0, 60)}`);
    expect(offenders).toEqual([]);
  });

  it.each(DOCUMENTS)("%s carries no inline event-handler attribute", (file) => {
    // An `onclick` is inline script in substance, and a CSP without
    // `'unsafe-inline'` refuses to run it — a page that needed one would be
    // silently broken rather than loudly wrong.
    const offenders = [...doc(file).querySelectorAll("*")].flatMap((el) =>
      [...el.attributes]
        .filter((attr) => attr.name.toLowerCase().startsWith("on"))
        .map((attr) => `${file}: <${el.tagName.toLowerCase()} ${attr.name}>`),
    );
    expect(offenders).toEqual([]);
  });

  it.each(DOCUMENTS)("%s uses no javascript: URL", (file) => {
    const offenders = fetchedUrls(file)
      .filter(({ value }) => value.trim().toLowerCase().startsWith("javascript:"))
      .map(({ where }) => where);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 11.6 — nothing from a third-party origin
// ---------------------------------------------------------------------------

/**
 * An `<a href>` (or `<area href>`) the reader may follow. It issues no request
 * while the page renders, so R11.6 does not reach it — see the note at the top
 * of this file. Every other URL-bearing attribute is a load.
 */
const isNavigation = ({ el, name }: { el: Element; name: string }) =>
  name === "href" && (el.tagName === "A" || el.tagName === "AREA");

/**
 * The off-origin destinations a Marketing_Page is allowed to link to, pinned so
 * a new one is a deliberate edit here rather than a silent addition. The source
 * link the footer carries is what AGPL section 13 expects a network user to be
 * offered, and it has to point at the upstream repository to serve that purpose.
 */
const ALLOWED_LINK_ORIGINS = ["https://github.com/nickjessop/snap-gut"];

describe("Marketing_Pages load nothing from a third-party origin (R11.6)", () => {
  it.each(DOCUMENTS)("%s fetches only same-origin URLs", (file) => {
    const offenders = fetchedUrls(file)
      .filter((ref) => !sameOrigin(ref.value) && !isNavigation(ref))
      .map(({ where, value }) => `${where} ${value}`);
    expect(offenders).toEqual([]);
  });

  it.each(DOCUMENTS)("%s links off-origin only to a pinned destination", (file) => {
    const offenders = fetchedUrls(file)
      .filter((ref) => isNavigation(ref) && !sameOrigin(ref.value))
      .filter(({ value }) => !ALLOWED_LINK_ORIGINS.some((allowed) => value.startsWith(allowed)))
      .map(({ where, value }) => `${where} ${value}`);
    expect(offenders).toEqual([]);
  });

  it.each(DOCUMENTS)("%s embeds no frame or plugin object", (file) => {
    // None today. A frame is the one element class R11.6 names that the page
    // set has no use for, so its absence is the simplest way to hold the line.
    const embedded = [...doc(file).querySelectorAll("iframe, frame, object, embed")].map((el) =>
      el.tagName.toLowerCase(),
    );
    expect(embedded).toEqual([]);
  });

  it.each(DOCUMENTS)("%s pulls its stylesheets from this origin, and they exist", (file) => {
    const sheets = stylesheetsOf(file);
    expect(sheets.length, `${file} references no stylesheet`).toBeGreaterThan(0);
    for (const href of sheets) {
      expect(existsSync(path.join(distDir, href.slice(1))), `${file}: ${href}`).toBe(true);
    }
  });

  it("loads no font or image from a third-party origin through CSS", () => {
    // A stylesheet is the other place a third-party fetch hides: `@import` and
    // any absolute `url()`, including a hosted webfont.
    const offenders: string[] = [];
    for (const file of DOCUMENTS) {
      for (const href of stylesheetsOf(file)) {
        const css = readFileSync(path.join(distDir, href.slice(1)), "utf8");
        for (const [, target] of css.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/g)) {
          offenders.push(`${href}: @import ${target}`);
        }
        for (const [, target] of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
          if (!sameOrigin(target) && !target.startsWith("data:")) {
            offenders.push(`${href}: url(${target})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.7 — bundle and stylesheet isolation
// ---------------------------------------------------------------------------

describe("Marketing_Pages load no module from the SnapGut_App bundle (R7.7)", () => {
  it("resolves an App_Shell module graph to compare against", () => {
    const appGraph = moduleGraph(appShellFile);
    // If this ever came back empty the comparisons below would pass vacuously.
    expect(appGraph.length).toBeGreaterThan(0);
    expect(entryScripts(appShellFile).length).toBeGreaterThan(0);
  });

  it.each(DOCUMENTS)("%s does not load the App_Shell's entry module", (file) => {
    // The App_Shell's own `<script type=module>` — the chunk that boots the
    // SnapGut_App, and the thing R7.7 is really about.
    const appEntries = entryScripts(appShellFile).map((url) => url.slice(1));
    const graph = moduleGraph(file);
    expect(graph.filter((module) => appEntries.includes(module))).toEqual([]);
  });

  it.each(DOCUMENTS)("%s shares only app-code-free build shims with the App_Shell", (file) => {
    const appGraph = new Set(moduleGraph(appShellFile));
    const shared = moduleGraph(file).filter((module) => appGraph.has(module));
    const notShims = shared
      .filter((module) => describeShim(module).length > 0)
      .map((module) => `${module} — ${describeShim(module).join("; ")}`);
    // The documented exception, pinned: the modulepreload polyfill and nothing
    // else. Anything carrying app logic lands here.
    expect(notShims).toEqual([]);
  });

  it("pins the shared modulepreload polyfill as the only overlap there is", () => {
    // Belt and braces on the check above: name the overlap so a second shared
    // chunk appearing is visible in the diff even if it happened to pass
    // `describeShim`.
    const appGraph = new Set(moduleGraph(appShellFile));
    const shared = [...new Set(DOCUMENTS.flatMap(moduleGraph))].filter((module) =>
      appGraph.has(module),
    );
    expect(shared, `shared modules: ${shared.join(", ")}`).toHaveLength(1);
    expect(path.posix.basename(shared[0])).toMatch(/^modulepreload-polyfill-[\w-]+\.js$/);
  });

  it("detects application code where it certainly exists (control)", () => {
    // A marker list is only as good as its ability to fire. The App_Shell's own
    // entry chunk is app code by definition, so it must trip both detectors —
    // otherwise the four assertions around this one pass for the wrong reason.
    const appEntry = entryScripts(appShellFile)[0].slice(1);
    const code = chunk(appEntry);
    expect(APP_MARKERS.filter((marker) => code.includes(marker)).length).toBeGreaterThan(0);
    expect(describeShim(appEntry).length).toBeGreaterThan(0);
  });

  it.each(DOCUMENTS)("%s loads no module carrying application code", (file) => {
    const offenders = moduleGraph(file).flatMap((module) => {
      const code = chunk(module);
      return APP_MARKERS.filter((marker) => code.includes(marker)).map(
        (marker) => `${module} contains "${marker}"`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps every Marketing_Site stylesheet out of the App_Shell (R7.7, R11.6)", () => {
    const marketingSheets = new Set(DOCUMENTS.flatMap(stylesheetsOf));
    expect(marketingSheets.size).toBeGreaterThan(0);
    const appSheets = stylesheetsOf(appShellFile);
    expect(appSheets.length, "the App_Shell references no stylesheet").toBeGreaterThan(0);
    expect(appSheets.filter((href) => marketingSheets.has(href))).toEqual([]);
  });

  it("keeps the App_Shell's stylesheet off every Marketing_Page", () => {
    const appSheets = new Set(stylesheetsOf(appShellFile));
    for (const file of DOCUMENTS) {
      expect(stylesheetsOf(file).filter((href) => appSheets.has(href)), file).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirements 1.6 and 1.7 — no API calls, no client storage
// ---------------------------------------------------------------------------

describe("rendering a Marketing_Page requests no /api/* path (R1.6)", () => {
  it.each(DOCUMENTS)("%s has no URL attribute resolving under /api/", (file) => {
    const offenders = fetchedUrls(file)
      .filter(({ value }) => localPath(value).startsWith("/api/"))
      .map(({ where, value }) => `${where} ${value}`);
    expect(offenders).toEqual([]);
  });

  it.each(DOCUMENTS)("%s names no /api/ path in markup the browser acts on", (file) => {
    // Comments are stripped first: the privacy and terms sources cite `/api/*`
    // handlers to show where a claim comes from, which issues no request.
    const found = [...withoutComments(file).matchAll(/\/api\/[\w*./-]*/g)].map((m) => m[0]);
    expect(found).toEqual([]);
  });

  it.each(DOCUMENTS)("%s loads no script or stylesheet that names an /api/ path", (file) => {
    const assets = [...moduleGraph(file), ...stylesheetsOf(file).map((href) => href.slice(1))];
    const offenders = assets.filter((asset) =>
      readFileSync(path.join(distDir, asset), "utf8").includes("/api/"),
    );
    expect(offenders).toEqual([]);
  });

  it.each(DOCUMENTS)("%s declares no form that could post to the origin", (file) => {
    // The page set is read-only. A form is how an `/api/*` request would most
    // plausibly arrive on a page with no app code.
    expect([...doc(file).querySelectorAll("form")].length).toBe(0);
  });
});

describe("Marketing_Pages read and write no client storage (R1.7)", () => {
  const STORAGE_APIS = ["indexedDB", "localStorage", "sessionStorage", "openDB", "idb"];

  it.each(DOCUMENTS)("%s loads no script touching IndexedDB or localStorage", (file) => {
    const offenders = moduleGraph(file).flatMap((module) => {
      const code = chunk(module);
      return STORAGE_APIS.filter((api) => code.includes(api)).map(
        (api) => `${module} references ${api}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("detects storage access where it certainly exists (control)", () => {
    // `src/db.ts` is an IndexedDB store, so the app bundle must trip this scan.
    const appCode = moduleGraph(appShellFile).map(chunk).join("\n");
    expect(STORAGE_APIS.filter((api) => appCode.includes(api)).length).toBeGreaterThan(0);
  });

  it("keeps the home page's Standalone_Launch check to a display-mode test (R6.5)", () => {
    // The one script a Marketing_Page loads. It decides on `matchMedia` and
    // `navigator.standalone` and reads no stored value, which is the concrete
    // form R1.7 takes here.
    const home = pages.find((page) => page.path === "/")!;
    const modules = moduleGraph(home.file);
    expect(modules.length).toBeGreaterThan(0);
    const code = modules.map(chunk).join("\n");
    expect(code).toContain("display-mode: standalone");
    for (const api of STORAGE_APIS) expect(code, api).not.toContain(api);
    expect(code).not.toContain("document.cookie");
  });

  it.each(DOCUMENTS.filter((file) => file !== pages[0].file))(
    "%s loads no JavaScript at all",
    (file) => {
      // Only the home page needs a script (the Legacy_Install redirect of
      // R6.4). Every other page is pure markup, which is the strongest form of
      // both R1.4 and R1.7.
      expect(moduleGraph(file)).toEqual([]);
      const scripts = [...doc(file).querySelectorAll("script[src]")].map((el) =>
        el.getAttribute("src"),
      );
      expect(scripts).toEqual([]);
    },
  );
});
