// @vitest-environment node
//
// The pricing-table renderer in `vite/pricing.js`.
//
// Validates: Requirements 7.6, 9.3, 9.8
//
// The plugin is exercised through its `transformIndexHtml` handler — the same
// entry point Vite calls in dev and in build — against the real Plan_Catalog,
// and through the renderer directly against a substitute catalog, which is how
// the "a catalog change needs no copy edit" guarantee gets tested without
// editing `shared/plans.js`.

import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { formatPrice, pricingPlans, renderPlans } from "../vite/pricing.js";
import { PLANS, type Plan, type PlanId } from "../shared/plans.js";

const root = path.resolve(__dirname, "..");
const PRICING = path.join(root, "marketing", "pricing.html");

/** The plugin's transform, called the way Vite calls it. */
const transform = (
  html: string,
  filename = PRICING,
  plans?: Record<string, Plan>
): string | undefined =>
  pricingPlans({ root, ...(plans ? { plans } : {}) }).transformIndexHtml.handler(html, {
    filename,
    path: "/" + path.relative(root, filename),
  });

const ids = Object.keys(PLANS) as PlanId[];

describe("formatPrice", () => {
  it("renders whole cents as a two-decimal currency figure", () => {
    expect(formatPrice(2999)).toBe("$29.99");
    expect(formatPrice(499)).toBe("$4.99");
    expect(formatPrice(7999)).toBe("$79.99");
    expect(formatPrice(3000)).toBe("$30.00");
    expect(formatPrice(5)).toBe("$0.05");
    expect(formatPrice(299900)).toBe("$2,999.00");
  });

  it("refuses a value that is not whole, non-negative cents", () => {
    expect(() => formatPrice(29.99)).toThrow(/whole/);
    expect(() => formatPrice(-100)).toThrow(/whole/);
  });
});

describe("renderPlans", () => {
  it("renders every catalog entry's price, label, and caption, and nothing else", () => {
    const html = renderPlans();
    for (const id of ids) {
      const plan = PLANS[id];
      expect(html).toContain(`data-plan="${id}"`);
      expect(html).toContain(`<h3>${plan.label}</h3>`);
      expect(html).toContain(formatPrice(plan.price));
      expect(html).toContain(plan.caption);
    }
    // One card per plan, so no plan outside the catalog can appear (R9.3).
    expect(html.match(/data-plan=/g)).toHaveLength(ids.length);
  });

  it("reflects a changed catalog with no change to the markup around it", () => {
    const html = renderPlans({
      weekly: {
        price: 199,
        label: "Weekly",
        caption: "billed weekly",
        per: "$0.99/wk",
        mode: "subscription",
        priceEnv: "STRIPE_PRICE_WEEKLY",
        durationMs: 7 * 86_400_000,
      },
    } as Record<string, Plan>);
    expect(html).toContain("$1.99");
    expect(html).toContain("<h3>Weekly</h3>");
    expect(html).toContain("billed weekly");
    for (const id of ids) expect(html).not.toContain(`data-plan="${id}"`);
  });

  it("fails rather than rendering a table with no plans in it", () => {
    expect(() => renderPlans({})).toThrow(/empty/);
  });
});

describe("pricingPlans", () => {
  it("replaces the marker on the pricing document", () => {
    const out = transform("<main><!--#plans--></main>")!;
    expect(out).not.toContain("#plans");
    expect(out).toContain(formatPrice(PLANS.annual.price));
    expect(out).toContain(`<h3>${PLANS.lifetime.label}</h3>`);
  });

  it("leaves every other document untouched, marker or not", () => {
    expect(transform("<!--#plans-->", path.join(root, "marketing", "index.html"))).toBeUndefined();
    expect(transform("<!--#plans-->", path.join(root, "app", "index.html"))).toBeUndefined();
  });

  it("fails the build when the pricing page loses its marker", () => {
    expect(() => transform("<main><h1>Pricing</h1></main>")).toThrow(/no <!--#plans--> marker/);
  });

  it("escapes catalog text so a value cannot break out of the markup", () => {
    const out = transform("<!--#plans-->", PRICING, {
      odd: { ...PLANS.annual, label: '<script>x</script>"' },
    } as Record<string, Plan>)!;
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("keeps the shipped pricing page's own copy free of every catalog figure", async () => {
    // Requirement 9.8: the only copy that names a price is the copy this plugin
    // generates, so the source template must contain none of it.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(PRICING, "utf8");
    expect(source).toContain("<!--#plans-->");
    for (const id of ids) {
      expect(source).not.toContain(formatPrice(PLANS[id].price));
      expect(source).not.toContain(PLANS[id].caption);
      expect(source).not.toContain(PLANS[id].per);
    }
  });
});
