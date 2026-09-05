/**
 * D2: the HTML partial-injection plugin.
 *
 * The Marketing_Pages share a head scaffold, a header, and a footer. Rather than
 * copy that markup into every page, each page carries include markers and
 * per-page placeholders:
 *
 *     <!--#include head-->                 → marketing/partials/head.html
 *     <title>{{title}}</title>             → the Route_Table entry's title
 *     <meta name="description" …>          → …its description
 *     {{#canonical}}…{{/canonical}}        → conditional on PUBLIC_ORIGIN
 *
 * Substituted values come from the page's own Route_Table entry in
 * `shared/site.js`, matched by output filename. The canonical URL is only
 * generated when the `PUBLIC_ORIGIN` environment variable is set.
 *
 * `transformIndexHtml` runs in both `vite` and `vite build`, so the same markup
 * is produced in development and in the Build_Output.
 *
 * Anything outside `marketing/` — the App_Shell above all — passes through
 * untouched.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MARKETING_PAGES, NOT_FOUND_FILE } from "../shared/site.js";

/** `<!--#include head-->`, naming a file in `marketing/partials/`. */
const INCLUDE = /<!--#include\s+([\w-]+)\s*-->/g;

/** `{{title}}` and friends. Anything else is left alone. */
const PLACEHOLDER = /\{\{\s*(title|description|canonical|path)\s*\}\}/g;

/** `{{#key}}…{{/key}}` conditional blocks — rendered only when key is truthy. */
const CONDITIONAL_BLOCK = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

/** A partial that includes itself would otherwise expand forever. */
const MAX_INCLUDE_DEPTH = 5;

/**
 * The not-found document has no Route_Table entry — it is not indexable and has
 * no canonical URL — but it uses the same shell, so it gets its metadata here.
 */
const NOT_FOUND_META = {
  path: null,
  file: NOT_FOUND_FILE,
  title: "Page not found — SnapGut",
  description: "That page does not exist. Head back to the home page or open the app.",
};

/** Values land in attributes and in text, so escape both cases the same way. */
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * @param {{ root?: string, dir?: string }} [options]
 * @returns {import("vite").Plugin}
 */
export function marketingPartials({ root = process.cwd(), dir = "marketing" } = {}) {
  const marketingDir = path.resolve(root, dir);
  const partialsDir = path.join(marketingDir, "partials");

  // PUBLIC_ORIGIN drives canonical/og:url generation. If not set, those tags
  // are omitted entirely.
  const publicOrigin = process.env.PUBLIC_ORIGIN?.trim() || null;

  /** The Route_Table entry for a document, or null if it is not a Marketing_Page. */
  const pageForFile = (filename) => {
    if (!filename) return null;
    const absolute = path.resolve(root, filename);
    if (path.dirname(absolute) !== marketingDir) return null;
    const file = path.basename(absolute);
    return (
      MARKETING_PAGES.find((page) => page.file === file) ??
      (file === NOT_FOUND_FILE ? NOT_FOUND_META : null)
    );
  };

  /** Fallback for a dev request identified by URL path rather than by file. */
  const pageForPath = (urlPath) => {
    if (!urlPath) return null;
    const clean = urlPath.split("?")[0].split("#")[0];
    return MARKETING_PAGES.find((page) => page.path === clean) ?? null;
  };

  const expandIncludes = (html, depth) =>
    html.replace(INCLUDE, (marker, name) => {
      if (depth >= MAX_INCLUDE_DEPTH) {
        throw new Error(`vite/partials: include depth exceeded at ${marker} — a partial includes itself`);
      }
      const file = path.join(partialsDir, `${name}.html`);
      if (!existsSync(file)) {
        throw new Error(
          `vite/partials: ${marker} references a missing partial (${path.relative(root, file)})`
        );
      }
      return expandIncludes(readFileSync(file, "utf8"), depth + 1);
    });

  return {
    name: "snapgut-marketing-partials",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = pageForFile(ctx?.filename) ?? pageForPath(ctx?.path);
        if (!page) return; // the App_Shell and anything else: unchanged

        const canonical = page.path && publicOrigin
          ? new URL(page.path, publicOrigin).href
          : "";

        const values = {
          title: page.title,
          description: page.description,
          path: page.path ?? "",
          canonical,
        };

        // Includes first, so placeholders inside a partial are substituted too.
        let result = expandIncludes(html, 0);

        // Conditional blocks: {{#key}}…{{/key}} — render contents only when key is truthy.
        result = result.replace(CONDITIONAL_BLOCK, (_match, key, content) => {
          return values[key] ? content : "";
        });

        // Simple placeholders.
        result = result.replace(PLACEHOLDER, (_marker, key) =>
          escapeHtml(values[key])
        );

        return result;
      },
    },
  };
}

export default marketingPartials;
