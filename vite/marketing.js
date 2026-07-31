/**
 * The Marketing_Site half of the multi-page build.
 *
 * Three jobs, all driven by the Route_Table in `shared/site.js`:
 *
 *   1. **Inputs.** `marketingInputs()` produces the `rollupOptions.input` map —
 *      the App_Shell plus one entry per Marketing_Page plus the not-found
 *      document — so adding a page is one Route_Table entry and nothing else
 *      (Requirements 7.1, 7.8, 16.2).
 *
 *   2. **Flattening and the asset check.** Rollup emits an HTML document at the
 *      path of its input, so the pages land in `dist/marketing/`. A `writeBundle`
 *      step moves each one to the `file` name its Route_Table entry declares —
 *      `dist/index.html`, `dist/pricing.html`, … — which is where the
 *      Origin_Server looks for it. The same step then walks every emitted
 *      document and fails the build if it references an asset that is not in the
 *      Build_Output (Requirement 7.4).
 *
 *   3. **The generated artifacts.** Once the documents are flat and verified, the
 *      same step writes the four files nothing else in the repo can derive:
 *
 *        dist/robots.txt        allow the Marketing_Pages, disallow the
 *                               Login_Route, the App_Route prefix, and `/api/`,
 *                               and point at the absolute sitemap URL (R8.7)
 *        dist/sitemap.xml       exactly `indexablePaths()` as absolute
 *                               Canonical_Host URLs, nothing else (R7.9, R8.8)
 *        dist/csp-hashes.json   `{ "<path>": ["sha256-…"] }`, one entry per
 *                               Marketing_Page, holding the hash of each
 *                               `application/ld+json` block on that page. The
 *                               server loads this at boot and merges that page's
 *                               values into its `script-src`, adding the quotes
 *                               CSP's hash-source grammar requires (R11.4)
 *        dist/size-report.json  `{ "<path>": { html, css, js } }` in gzip bytes,
 *                               which the budget test reads to enforce the
 *                               150 KB home-page ceiling (R15.5)
 *
 * Asset references survive the move because Vite rewrites them to absolute
 * `/assets/…` paths, not paths relative to the document.
 *
 * Plain ESM JavaScript, matching `server/` and `shared/`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  APP_PREFIX,
  CANONICAL_ORIGIN,
  GENERATED_FILES,
  indexablePaths,
  LOGIN_PATH,
  MARKETING_PAGES,
  NOT_FOUND_FILE,
} from "../shared/site.js";

/** Where the Marketing_Page sources live, relative to the project root. */
const SOURCE_DIR = "marketing";

/**
 * Rollup input names are only chunk-naming hints, but readable ones make the
 * build log legible. `index.html` would collide with the App_Shell's basename,
 * hence the explicit map.
 */
const INPUT_NAMES = { "index.html": "home", "404.html": "notFound" };

const inputName = (file) =>
  INPUT_NAMES[file] ?? file.replace(/\.html$/, "").replace(/[^a-z0-9]+/gi, "-");

/** Every document the build emits: the Marketing_Pages plus the not-found page. */
const marketingDocuments = () => [
  ...MARKETING_PAGES.map((page) => page.file),
  NOT_FOUND_FILE,
];

/**
 * The `rollupOptions.input` map for the whole site.
 *
 * @param {{ appShell?: string, dir?: string }} [options]
 * @returns {Record<string, string>}
 */
export function marketingInputs({ appShell = "app/index.html", dir = SOURCE_DIR } = {}) {
  /** @type {Record<string, string>} */
  const inputs = { app: appShell };
  for (const file of marketingDocuments()) {
    inputs[inputName(file)] = `${dir}/${file}`;
  }
  return inputs;
}

/**
 * Files another plugin generates after this one runs, so their absence during
 * the asset check is expected rather than a broken reference. `vite-plugin-pwa`
 * writes the service worker and its registration shim in `closeBundle`.
 */
const GENERATED_LATER = [/^sw\.js$/, /^registerSW\.js$/, /^workbox-[\w-]+\.js$/, /^manifest\.webmanifest$/];

/** Tag/attribute pairs that name an asset the browser must be able to fetch. */
const ASSET_REFS = [
  { tag: "script", attr: "src" },
  { tag: "link", attr: "href" },
  { tag: "img", attr: "src" },
  { tag: "source", attr: "src" },
  { tag: "video", attr: "poster" },
];

/** `srcset` holds a comma-separated candidate list, each with an optional descriptor. */
const SRCSET_REFS = [
  { tag: "img", attr: "srcset" },
  { tag: "source", attr: "srcset" },
];

/** Social images are declared in `content`, not in an asset attribute. */
const META_IMAGE = /<meta\b[^>]*?(?:property|name)\s*=\s*["'](?:og:image|twitter:image)(?::secure_url|:url)?["'][^>]*?>/gi;
const CONTENT_ATTR = /\bcontent\s*=\s*["']([^"']*)["']/i;

const tagPattern = (tag, attr) =>
  new RegExp(`<${tag}\\b[^>]*?\\b${attr}\\s*=\\s*["']([^"']*)["'][^>]*>`, "gi");

const matchAll = (html, pattern) => {
  /** @type {string[]} */
  const found = [];
  for (const match of html.matchAll(pattern)) found.push(match[1]);
  return found;
};

/**
 * Every asset URL a document references. Anchors are deliberately excluded: an
 * `<a href="/pricing">` names a route, not a file, and the route table already
 * covers those.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function referencedAssets(html) {
  const refs = [];
  for (const { tag, attr } of ASSET_REFS) refs.push(...matchAll(html, tagPattern(tag, attr)));
  for (const { tag, attr } of SRCSET_REFS) {
    for (const value of matchAll(html, tagPattern(tag, attr))) {
      refs.push(...value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]));
    }
  }
  for (const tag of html.match(META_IMAGE) ?? []) {
    const content = tag.match(CONTENT_ATTR);
    if (content) refs.push(content[1]);
  }
  return refs;
}

/**
 * True for a reference that names a file inside the Build_Output. Absolute URLs,
 * protocol-relative URLs, `data:`/`mailto:` and friends, and in-page fragments
 * all point somewhere the build does not own.
 *
 * @param {string} ref
 */
const isLocalAsset = (ref) => {
  const value = ref.trim();
  if (!value) return false;
  if (value.startsWith("#") || value.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return true;
};

/** Strip the query and fragment, and make the path relative to the output root. */
const toOutputPath = (ref) => ref.trim().split("#")[0].split("?")[0].replace(/^\/+/, "");

/**
 * Move each emitted marketing document from `dist/marketing/` to the flat `file`
 * name its Route_Table entry declares, then drop the now-empty directory.
 *
 * @param {string} outDir absolute path of the Build_Output root
 * @param {string} dir the source directory name, which Rollup mirrors in the output
 * @returns {string[]} the flattened documents, relative to `outDir`
 */
function flattenDocuments(outDir, dir) {
  const nested = path.join(outDir, dir);
  /** @type {string[]} */
  const emitted = [];

  for (const file of marketingDocuments()) {
    const from = path.join(nested, file);
    const to = path.join(outDir, file);
    if (!existsSync(from)) {
      // Either the input was missing (Rollup would already have failed) or the
      // document has been flattened by a previous run of this hook.
      if (existsSync(to)) {
        emitted.push(file);
        continue;
      }
      throw new Error(
        `vite/marketing: the build did not emit ${dir}/${file} — is it in rollupOptions.input?`
      );
    }
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    emitted.push(file);
  }

  // Only remove it if the flattening emptied it; anything left is a file we do
  // not know about and silently deleting it would be worse than leaving it.
  if (existsSync(nested) && readdirSync(nested).length === 0) rmdirSync(nested);

  return emitted;
}

/**
 * Requirement 7.4: a page that references an asset the Build_Output does not
 * contain fails the build rather than shipping a broken reference.
 *
 * @param {string} outDir absolute path of the Build_Output root
 * @param {string[]} documents document paths relative to `outDir`
 */
function assertAssetsExist(outDir, documents) {
  /** @type {string[]} */
  const problems = [];

  for (const document of documents) {
    const html = readFileSync(path.join(outDir, document), "utf8");
    for (const ref of referencedAssets(html)) {
      if (!isLocalAsset(ref)) continue;
      const target = toOutputPath(ref);
      if (!target) continue;
      if (existsSync(path.join(outDir, target))) continue;
      if (GENERATED_LATER.some((pattern) => pattern.test(target))) continue;
      problems.push(`${document} references ${ref}, which the build did not emit`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`vite/marketing: missing asset${problems.length > 1 ? "s" : ""}\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * The generated artifacts, by their fixed names in the Build_Output root.
 *
 * Defined in `shared/site.js` and re-exported here: the Origin_Server reads
 * `csp-hashes.json` at boot and cannot import from `vite/`, so the names have to
 * live somewhere both sides can reach (Requirement 11.4).
 */
export { GENERATED_FILES };

/**
 * The paths crawlers are told to stay out of: the Login_Route, everything under
 * the App_Route prefix, and the API surface. Derived from the Route_Table so a
 * prefix change lands here too (Requirement 8.7).
 */
const disallowedPaths = () => [LOGIN_PATH, APP_PREFIX, "/api/"];

/**
 * `robots.txt`: allow every Marketing_Page, disallow the non-indexable classes,
 * and reference the sitemap by absolute URL on the Canonical_Host.
 *
 * `Allow:` lines are redundant against a permissive default, but they make the
 * indexable set explicit in the artifact the test asserts against, and the more
 * specific `Disallow:` rules still win under longest-match.
 *
 * @param {{ origin?: string, paths?: string[] }} [options]
 * @returns {string}
 */
export function robotsTxt({ origin = CANONICAL_ORIGIN, paths = indexablePaths() } = {}) {
  const lines = [
    "# Generated by vite/marketing.js from the Route_Table in shared/site.js.",
    "User-agent: *",
    ...paths.map((p) => `Allow: ${p}`),
    ...disallowedPaths().map((p) => `Disallow: ${p}`),
    "",
    `Sitemap: ${origin}/${GENERATED_FILES.sitemap}`,
    "",
  ];
  return lines.join("\n");
}

/** The five characters that cannot appear literally in XML character data. */
const escapeXml = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * `sitemap.xml`: exactly the indexable paths as absolute Canonical_Host URLs.
 *
 * No `lastmod`: the Route_Table carries no modification date, and synthesizing
 * one from the build clock would make the artifact differ between two builds of
 * identical content.
 *
 * @param {{ origin?: string, paths?: string[] }} [options]
 * @returns {string}
 */
export function sitemapXml({ origin = CANONICAL_ORIGIN, paths = indexablePaths() } = {}) {
  const urls = paths.map((p) => `  <url>\n    <loc>${escapeXml(origin + p)}</loc>\n  </url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

/** `<script>` elements with their attribute list and their exact body. */
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const IS_JSON_LD = /\btype\s*=\s*["']application\/ld\+json["']/i;

/**
 * The CSP source expressions for a document's structured-data blocks.
 *
 * A hash-source covers the element's body byte-for-byte, so the body is hashed
 * exactly as it sits in the emitted document — no trimming, no re-serializing.
 * The `sha256-<base64>` shape is the canonical one; `server/csp.js` wraps each
 * value in the single quotes CSP's hash-source grammar requires before it reaches
 * a header (Requirement 11.4).
 *
 * @param {string} html
 * @returns {string[]}
 */
export function jsonLdHashes(html) {
  /** @type {string[]} */
  const hashes = [];
  for (const [, attrs, body] of html.matchAll(SCRIPT_ELEMENT)) {
    if (!IS_JSON_LD.test(attrs)) continue;
    hashes.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
  }
  return hashes;
}

/** Stylesheets are `<link rel="stylesheet" href="…">`; preloads are not applied styles. */
const LINK_ELEMENT = /<link\b[^>]*>/gi;
const IS_STYLESHEET = /\brel\s*=\s*["'][^"']*\bstylesheet\b[^"']*["']/i;
const HREF_ATTR = /\bhref\s*=\s*["']([^"']*)["']/i;
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']*)["'][^>]*>/gi;

/** Local, in-output asset paths referenced by `refs`, deduplicated. */
const outputTargets = (refs) => {
  /** @type {string[]} */
  const targets = [];
  for (const ref of refs) {
    if (!isLocalAsset(ref)) continue;
    const target = toOutputPath(ref);
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
};

/** Gzip byte count of a file, or 0 when it is not in the Build_Output. */
const gzipFileSize = (outDir, target) => {
  const file = path.join(outDir, target);
  if (!existsSync(file)) return 0;
  return gzipSync(readFileSync(file)).length;
};

/**
 * The compressed weight of one document: its own gzipped bytes plus the gzipped
 * bytes of every stylesheet and script it pulls in. Images are excluded, which
 * is what Requirement 15.1's budget measures.
 *
 * Inline `<style>` and `<script>` content needs no separate accounting — it is
 * already inside the HTML figure.
 *
 * @param {string} html the emitted document
 * @param {string} outDir absolute path of the Build_Output root
 * @returns {{ html: number, css: number, js: number }} gzip bytes
 */
export function documentSizes(html, outDir) {
  /** @type {string[]} */
  const styles = [];
  for (const tag of html.match(LINK_ELEMENT) ?? []) {
    if (!IS_STYLESHEET.test(tag)) continue;
    const href = tag.match(HREF_ATTR);
    if (href) styles.push(href[1]);
  }

  const scripts = matchAll(html, SCRIPT_SRC);
  const sum = (refs) =>
    outputTargets(refs).reduce((bytes, target) => bytes + gzipFileSize(outDir, target), 0);

  return {
    html: gzipSync(Buffer.from(html, "utf8")).length,
    css: sum(styles),
    js: sum(scripts),
  };
}

/**
 * Write the four generated artifacts. Keyed by Marketing_Page path rather than
 * by output file, because both consumers — the server's CSP selection and the
 * budget test — think in paths.
 *
 * Every page gets a `csp-hashes.json` entry, empty array included, so the server
 * can tell "this page has no structured data" from "this build predates the
 * page" without guessing.
 *
 * @param {string} outDir absolute path of the Build_Output root
 */
function emitGeneratedFiles(outDir) {
  /** @type {Record<string, string[]>} */
  const hashes = {};
  /** @type {Record<string, { html: number, css: number, js: number }>} */
  const sizes = {};

  for (const page of MARKETING_PAGES) {
    const html = readFileSync(path.join(outDir, page.file), "utf8");
    hashes[page.path] = jsonLdHashes(html);
    sizes[page.path] = documentSizes(html, outDir);
  }

  const write = (name, contents) => writeFileSync(path.join(outDir, name), contents);
  write(GENERATED_FILES.robots, robotsTxt());
  write(GENERATED_FILES.sitemap, sitemapXml());
  write(GENERATED_FILES.cspHashes, `${JSON.stringify(hashes, null, 2)}\n`);
  write(GENERATED_FILES.sizeReport, `${JSON.stringify(sizes, null, 2)}\n`);
}

/**
 * The build-side plugin: flatten the marketing documents, check their asset
 * references, then emit the generated artifacts.
 *
 * @param {{ dir?: string }} [options]
 * @returns {import("vite").Plugin}
 */
export function marketingBuild({ dir = SOURCE_DIR } = {}) {
  let outDir = "dist";

  return {
    name: "snapgut-marketing-build",
    apply: "build",
    // Post, so the documents are flattened only once every other plugin has
    // finished rewriting their contents.
    enforce: "post",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const documents = flattenDocuments(outDir, dir);
      assertAssetsExist(outDir, documents);
      // After the check, so a build that would ship a broken page fails before
      // it produces a sitemap advertising that page.
      emitGeneratedFiles(outDir);
    },
  };
}

export default marketingBuild;
