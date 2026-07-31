/**
 * Types for `shared/plans.js`, so `src/` and the build get the Plan_Catalog
 * typed without turning on `allowJs`.
 */

/** How Stripe charges for a plan: recurring or one-off. */
export type PlanMode = "subscription" | "payment";

export interface Plan {
  /** Price in cents. */
  readonly price: number;
  /** Display name, e.g. `Annual`. */
  readonly label: string;
  /** Billing caption, e.g. `billed yearly`. */
  readonly caption: string;
  /** Secondary figure, e.g. `$2.50/mo`. */
  readonly per: string;
  readonly mode: PlanMode;
  /** Name of the env var holding the Stripe price id. */
  readonly priceEnv: string;
  /** Entitlement length in milliseconds; `null` never expires. */
  readonly durationMs: number | null;
}

/** The plan ids of the Plan_Catalog. */
export type PlanId = "annual" | "monthly" | "lifetime";

export declare const PLANS: Readonly<Record<PlanId, Plan>>;
