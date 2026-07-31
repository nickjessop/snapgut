// @vitest-environment node
//
// The D2 partial-injection plugin in `vite/partials.js`.
//
// Validates: Requirements 7.2, 8.1, 8.2
//
// The plugin is exercised through its `transformIndexHtml` handler against a
// throwaway `marketing/` tree, which is the same entry point Vite calls in dev
// and in build.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { marketingPartials } from "../vite/partials.js";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { CANONICAL_ORIGIN, MARKETING_PAGES } from "../shared/site.js";

let root = "";
/** The plugin's transform, called the way Vite calls it. */
let transform: (html: string, filename: string) => string | undefined;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "snapgut-partials-"));
  mkdirSync(path.join(root, "marketing", "partials"), { recursive: true });
  mkdirSync(path.join(root, "app"), { recursive: true });

  writeFileSync(
    path.join(root, "marketing", "partials", "head.html"),
    [
      "<title>{{title}}</title>",
      '<meta name="description" content="{{description}}" />',
      '<link rel="canonical" href="{{canonical}}" />',
      '<meta property="og:url" content="{{canonical}}" />',
    ].join("\n")
  );
  writeFileSync(
    path.join(root, "marketing", "partials", "footer.html"),
    '<footer><a href="/terms" data-path="{{path}}">Terms</a></footer>'
  );

  const plugin = marketingPartials({ root });
  transform = (html, filename) =>
    plugin.transformIndexHtml.handler(html, {
      filename: path.join(root, filename),
      path: "/" + filename,
    });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const pricing = MARKETING_PAGES.find((p: { path: string }) => p.path === "/pricing")!;

describe("marketingPartials", () => {
  it("replaces an include marker with the partial's contents", () => {
    const out = transform(
      "<head><!--#include head--></head><!--#include footer-->",
      "marketing/pricing.html"
    );
    expect(out).toContain("<title>");
    expect(out).toContain("<footer>");
    expect(out).not.toContain("#include");
  });

  it("substitutes the page's own title and description from the Route_Table", () => {
    const out = transform("<!--#include head-->", "marketing/pricing.html")!;
    expect(out).toContain(`<title>${pricing.title}</title>`);
    expect(out).toContain(`content="${pricing.description}"`);
  });

  it("substitutes an absolute canonical URL on the Canonical_Host", () => {
    const out = transform("<!--#include head-->", "marketing/pricing.html")!;
    expect(out).toContain(`href="${CANONICAL_ORIGIN}/pricing"`);
    expect(out).toContain(`property="og:url" content="${CANONICAL_ORIGIN}/pricing"`);

    const home = transform("<!--#include head-->", "marketing/index.html")!;
    expect(home).toContain(`href="${CANONICAL_ORIGIN}/"`);
  });

  it("gives the not-found document metadata but no canonical URL", () => {
    const out = transform("<!--#include head-->", "marketing/404.html")!;
    expect(out).toContain("<title>Page not found");
    expect(out).toContain('rel="canonical" href=""');
  });

  it("leaves the App_Shell untouched even though it shares a basename with the home page", () => {
    expect(transform("<title>SnapGut</title>{{title}}", "app/index.html")).toBeUndefined();
  });

  it("fails loudly on a marker naming a partial that does not exist", () => {
    expect(() => transform("<!--#include nope-->", "marketing/pricing.html")).toThrow(
      /missing partial/
    );
  });

  it("escapes substituted values so a quote cannot break out of an attribute", () => {
    writeFileSync(path.join(root, "marketing", "partials", "raw.html"), 'x="{{title}}"');
    const plugin = marketingPartials({ root });
    const out = plugin.transformIndexHtml.handler("<!--#include raw-->", {
      filename: path.join(root, "marketing", "pricing.html"),
    });
    expect(out).toBe(`x="${pricing.title.replace(/&/g, "&amp;")}"`);
  });
});
