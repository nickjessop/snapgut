// @vitest-environment node
//
// The Stripe Price ids reach the revision under the names the checkout route reads.
//
// `/api/billing/checkout` looks up `process.env[PLANS[plan].priceEnv]`. `infra/service.ts`
// sets `STRIPE_PRICE_<PLAN>` from the `stripePrices` stack config, deriving the name from the
// plan id because the infra program is CommonJS and `shared/plans.js` is ESM. That derivation
// is the seam this test nails shut: a mismatch would send `price: undefined` to Stripe and
// end a real upgrade attempt as a 500, with nothing in the type system to catch it.
//
// _Requirements: 18.1, 18.6_

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PLANS } from "../shared/plans.js";

const stackConfig = readFileSync(new URL("../infra/Pulumi.prod.yaml", import.meta.url), "utf8");

/** The `stripePrices` map as declared in the prod stack config. */
function configuredPrices(): Record<string, string> {
  const block = stackConfig.match(/^ {2}snapgut-infra:stripePrices:\n((?: {4}\S+: \S+\n)+)/m);
  if (!block) throw new Error("no stripePrices block in infra/Pulumi.prod.yaml");
  return Object.fromEntries(
    block[1]
      .trim()
      .split("\n")
      .map((line) => line.trim().split(": ") as [string, string])
  );
}

describe("Stripe price configuration", () => {
  it("names every plan's price variable STRIPE_PRICE_<PLAN>", () => {
    for (const [id, plan] of Object.entries(PLANS)) {
      expect(plan.priceEnv).toBe(`STRIPE_PRICE_${id.toUpperCase()}`);
    }
  });

  it("configures a live price id for every plan in the catalog", () => {
    const configured = configuredPrices();

    expect(Object.keys(configured).sort()).toEqual(Object.keys(PLANS).sort());
    for (const id of Object.keys(configured)) {
      expect(configured[id]).toMatch(/^price_[A-Za-z0-9]+$/);
    }
  });
});
