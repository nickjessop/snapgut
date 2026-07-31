import { describe, it, expect } from "vitest";
import { PLANS, type PlanId } from "../shared/plans.js";

const DAY = 86_400_000;

describe("Plan_Catalog", () => {
  it("keeps the three plans and their values as the server has always served them", () => {
    expect(Object.keys(PLANS)).toEqual(["annual", "monthly", "lifetime"]);
    expect(PLANS.annual).toEqual({
      price: 2999,
      label: "Annual",
      caption: "billed yearly",
      per: "$2.50/mo",
      mode: "subscription",
      priceEnv: "STRIPE_PRICE_ANNUAL",
      durationMs: 365 * DAY,
    });
    expect(PLANS.monthly).toEqual({
      price: 499,
      label: "Monthly",
      caption: "billed monthly",
      per: "$4.99/mo",
      mode: "subscription",
      priceEnv: "STRIPE_PRICE_MONTHLY",
      durationMs: 31 * DAY,
    });
    expect(PLANS.lifetime).toEqual({
      price: 7999,
      label: "Lifetime",
      caption: "one-time — yours forever",
      per: "best value",
      mode: "payment",
      priceEnv: "STRIPE_PRICE_LIFETIME",
      durationMs: null,
    });
  });

  it("gives every entry a whole-cent price, a Stripe mode, and a price env var", () => {
    for (const id of Object.keys(PLANS) as PlanId[]) {
      const p = PLANS[id];
      expect(Number.isInteger(p.price)).toBe(true);
      expect(p.price).toBeGreaterThan(0);
      expect(["subscription", "payment"]).toContain(p.mode);
      expect(p.priceEnv).toMatch(/^STRIPE_PRICE_[A-Z]+$/);
      // A one-off purchase never expires; a subscription always has a length.
      expect(p.durationMs === null).toBe(p.mode === "payment");
    }
  });
});
