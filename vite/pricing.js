/**
 * The pricing page's plan table, rendered from the Plan_Catalog at build time.
 *
 * `marketing/pricing.html` carries a single marker where the table belongs:
 *
 *     <!--#plans-->
 *
 * This plugin replaces it with one card per entry of `PLANS` in `shared/plans.js`
 * — the same module `/api/billing/plans` and `/api/billing/checkout` read. No
 * price, plan name, or billing caption is written by hand in the template, so a
 * catalog change lands on the page with no copy edit at all (Requirements 7.6,
 * 9.3, 9.8), and a plan the catalog does not contain cannot appear.
 *
 * Kept out of `vite/marketing.js` deliberately: that plugin runs at
 * `writeBundle`, over the emitted documents, which is too late to inject markup
 * Vite still has to see. `transformIndexHtml` runs in both `vite` and
 * `vite build`, so the dev server and the Build_Output render the same table.
 *
 * A missing marker is a build failure rather than a silently price-less page —
 * that is the "by construction" half of Requirement 9.3.
 *
 * Plain ESM JavaScript, matching `server/`, `shared/`, and the rest of `vite/`.
 */

import path from "node:path";
import { PLANS } from "../shared/plans.js";

/** Where the Marketing_Page sources live, relative to the project root. */
const SOURCE_DIR = "marketing";

/** The pricing document, by its source and output filename. */
const PRICING_FILE = "pricing.html";

/** The one marker this plugin owns. Distinct from `<!--#include …-->` (D2). */
const MARKER = /<!--#plans\s*-->/g;

/** Values land in text and in attributes, so escape both cases the same way. */
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * A Plan_Catalog price, in cents, as a currency string.
 *
 * Always two decimal places: these are prices, and `$29.9` or `$30` where the
 * catalog says `2999` or `3000` reads like a typo. Thousands are grouped so a
 * hypothetical `299900` is legible. Exported so the price-parity test can format
 * the catalog the same way the page does rather than restating the format.
 *
 * @param {number} cents whole cents, as the Plan_Catalog stores them
 * @returns {string} e.g. `$29.99`
 */
export function formatPrice(cents) {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`vite/pricing: price must be whole, non-negative cents — got ${cents}`);
  }
  const dollars = Math.trunc(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const remainder = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${remainder}`;
}

/**
 * One plan card. `label`, `price`, `caption`, and `per` all come from the
 * catalog entry; the only literal text is the markup around them.
 *
 * `role="list"` on the container and the classes used here are the ones
 * `marketing/marketing.css` already defines — this plugin adds no styling of its
 * own, so a card cannot end up unstyled.
 *
 * @param {string} id the Plan_Catalog key
 * @param {import("../shared/plans.js").Plan} plan
 * @returns {string}
 */
function planCard(id, plan) {
  return [
    `      <li class="card" data-plan="${escapeHtml(id)}">`,
    `        <h3>${escapeHtml(plan.label)}</h3>`,
    `        <p class="price">${escapeHtml(formatPrice(plan.price))}`,
    `          <span class="price-per">${escapeHtml(plan.per)}</span>`,
    `        </p>`,
    `        <p class="note">${escapeHtml(plan.caption)}</p>`,
    `      </li>`,
  ].join("\n");
}

/**
 * The whole plan table: every catalog entry, in catalog order, and nothing else.
 *
 * @param {Record<string, import("../shared/plans.js").Plan>} [plans]
 * @returns {string}
 */
export function renderPlans(plans = PLANS) {
  const entries = Object.entries(plans);
  if (entries.length === 0) {
    throw new Error("vite/pricing: the Plan_Catalog is empty — the pricing page would show no plans");
  }
  return [
    '    <ul class="grid" role="list">',
    ...entries.map(([id, plan]) => planCard(id, plan)),
    "    </ul>",
  ].join("\n");
}

/**
 * @param {{ root?: string, dir?: string, file?: string, plans?: Record<string, import("../shared/plans.js").Plan> }} [options]
 * @returns {import("vite").Plugin}
 */
export function pricingPlans({
  root = process.cwd(),
  dir = SOURCE_DIR,
  file = PRICING_FILE,
  plans = PLANS,
} = {}) {
  const pricingSource = path.resolve(root, dir, file);

  /**
   * True only for the pricing document. Matched by absolute path so nothing else
   * that happens to carry the marker — a partial, the App_Shell — is rewritten.
   *
   * @param {{ filename?: string, path?: string } | undefined} ctx
   */
  const isPricingDocument = (ctx) => {
    if (ctx?.filename && path.resolve(root, ctx.filename) === pricingSource) return true;
    // Dev fallback: the dev-route middleware rewrites `/pricing` to the source
    // document, so `ctx.path` is one of these two.
    const urlPath = ctx?.path?.split("?")[0].split("#")[0];
    return urlPath === "/pricing" || urlPath === `/${dir}/${file}`;
  };

  return {
    name: "snapgut-pricing-plans",
    transformIndexHtml: {
      // Pre, so Vite still sees whatever the injected markup references. It
      // currently references nothing, but that should not be load-bearing.
      order: "pre",
      handler(html, ctx) {
        if (!isPricingDocument(ctx)) return; // every other document: unchanged

        if (!MARKER.test(html)) {
          throw new Error(
            `vite/pricing: ${dir}/${file} has no <!--#plans--> marker, so the page would ship with no prices`
          );
        }
        MARKER.lastIndex = 0; // `test` on a /g regex leaves the index behind

        const table = renderPlans(plans);
        return html.replace(MARKER, () => table);
      },
    },
  };
}

export default pricingPlans;
