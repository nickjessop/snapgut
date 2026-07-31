/**
 * The Plan_Catalog: the authoritative definition of the SnapGut Pro plans.
 *
 * One entitlement, sold three ways. Prices are in cents. This module is the
 * single definition read by both the Origin_Server (`/api/billing/plans` and
 * `/api/billing/checkout`) and the build that renders the pricing page, so a
 * price can never differ between the two (Requirements 7.6, 9.3, 9.8).
 *
 * Plain ESM JavaScript so `server/`, `vite/`, and `src/` can all import it;
 * `shared/plans.d.ts` carries the types for the TypeScript side.
 */

const DAY = 86_400_000;

/** The Plan_Catalog, keyed by plan id. `durationMs` of `null` never expires. */
export const PLANS = {
  annual: {
    price: 2999,
    label: "Annual",
    caption: "billed yearly",
    per: "$2.50/mo",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_ANNUAL",
    durationMs: 365 * DAY,
  },
  monthly: {
    price: 499,
    label: "Monthly",
    caption: "billed monthly",
    per: "$4.99/mo",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_MONTHLY",
    durationMs: 31 * DAY,
  },
  lifetime: {
    price: 7999,
    label: "Lifetime",
    caption: "one-time — yours forever",
    per: "best value",
    mode: "payment",
    priceEnv: "STRIPE_PRICE_LIFETIME",
    durationMs: null, // never expires
  },
};
