// Per-food intolerance scoring with baseline-relative attribution.
//
// Raw "symptom rate" is misleading: if you get symptoms after most meals, every
// food looks bad; and a food you often eat WITHOUT symptoms should be exonerated.
// So we compare each food's follow-rate against your BASELINE — how often meals
// *without* that food are followed by symptoms — and only flag a food when it
// meaningfully exceeds baseline AND there's enough evidence.

import { confidentIngredients, foodKey, type LogEvent } from "./db";
import { classifyMeals } from "./mealOutcome";

// Evidence gates — deliberately conservative before we ever say "Avoid".
const MIN_EATEN = 4; // need at least this many *settled* exposures to rank at all
const MIN_SYMPTOM_FOLLOWS = 3; // need this many symptom-follows before "Avoid"
const MIN_OTHER_MEALS = 3; // need this many meals WITHOUT the food for a baseline
const AVOID_LIFT = 1.6; // must be ≥1.6× your baseline
const REDUCE_LIFT = 1.25;

export type FoodRank = "avoid" | "reduce" | "neutral" | "agrees" | "insufficient";

export interface FoodScore {
  name: string;
  /** Canonical dictionary id, when recognition resolved one (see db.ts). */
  canonical?: string;
  /** Every time the food was eaten — what the user recognises as "eaten N×". */
  eaten: number;
  /**
   * Exposures with a settled outcome, and the denominator of `foodRate`. Lower than
   * `eaten` when some of those meals are still inside their lag window or went
   * unobserved — see mealOutcome.ts for why those cannot be counted as symptom-free.
   */
  scored: number;
  /** Settled exposures that went symptom-free. The evidence in the food's favour. */
  clear: number;
  /** Exposures whose window has not closed yet. */
  pending: number;
  /** Exposures with no symptom and no sign the user was there to report one. */
  unobserved: number;
  withSymptom: number;
  foodRate: number; // symptom-follow rate for this food (0..1)
  baselineRate: number; // symptom-follow rate for meals WITHOUT this food
  lift: number; // foodRate / baselineRate
  rank: FoodRank;
  confidence: "low" | "medium" | "high";
  topSymptoms: { label: string; count: number }[];
}

export function computeFoodScores(events: LogEvent[], now: number = Date.now()): FoodScore[] {
  const mealInfo = classifyMeals(events, now);

  // Only settled meals reach a rate. A meal still inside its lag window, or one the
  // user was never around to report on, is not evidence of a symptom-free exposure —
  // counting it as one used to flatter every food, and flatter the most recent ones
  // hardest. See mealOutcome.ts.
  const settled = mealInfo.filter((m) => m.counted);
  const totalMeals = settled.length;
  const totalFollowed = settled.filter((m) => m.outcome === "symptom").length;

  // Accumulate per-food.
  interface Acc {
    display: string;
    canonical?: string;
    eaten: number;
    scored: number;
    clear: number;
    pending: number;
    unobserved: number;
    withSymptom: number;
    symptomCounts: Map<string, number>;
  }
  const byFood = new Map<string, Acc>();
  for (const info of mealInfo) {
    const seen = new Set<string>();
    for (const ing of confidentIngredients(info.meal)) {
      const key = foodKey(ing);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const acc =
        byFood.get(key) ??
        {
          display: ing.name.trim(),
          canonical: ing.canonical,
          eaten: 0,
          scored: 0,
          clear: 0,
          pending: 0,
          unobserved: 0,
          withSymptom: 0,
          symptomCounts: new Map(),
        };
      // Every exposure, settled or not — this is the count the user sees.
      acc.eaten += 1;
      if (info.counted) acc.scored += 1;
      switch (info.outcome) {
        case "symptom":
          acc.withSymptom += 1;
          for (const label of info.labels)
            acc.symptomCounts.set(label, (acc.symptomCounts.get(label) ?? 0) + 1);
          break;
        case "clear":
          acc.clear += 1;
          break;
        case "pending":
          acc.pending += 1;
          break;
        case "unobserved":
          acc.unobserved += 1;
          break;
      }
      byFood.set(key, acc);
    }
  }

  const scores: FoodScore[] = [...byFood.values()].map((a) => {
    const foodRate = a.scored ? a.withSymptom / a.scored : 0;

    // baseline = symptom-follow rate for settled meals that did NOT contain this food
    const otherMeals = totalMeals - a.scored;
    const otherFollowed = totalFollowed - a.withSymptom;
    const baselineRate = otherMeals > 0 ? otherFollowed / otherMeals : 0;
    const baselineReliable = otherMeals >= MIN_OTHER_MEALS;

    // lift = how much more often symptoms follow this food vs your baseline
    const lift =
      baselineRate > 0
        ? foodRate / baselineRate
        : foodRate > 0
        ? Infinity // symptoms only ever follow this food
        : 0;

    // Confidence follows settled exposures, not total ones: ten meals of which nine
    // are unresolved is not high confidence in anything.
    const confidence: FoodScore["confidence"] =
      a.scored >= 8 ? "high" : a.scored >= 5 ? "medium" : "low";

    const topSymptoms = [...a.symptomCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 3);

    return {
      name: a.display,
      canonical: a.canonical,
      eaten: a.eaten,
      scored: a.scored,
      clear: a.clear,
      pending: a.pending,
      unobserved: a.unobserved,
      withSymptom: a.withSymptom,
      foodRate: +foodRate.toFixed(2),
      baselineRate: +baselineRate.toFixed(2),
      lift: lift === Infinity ? Infinity : +lift.toFixed(2),
      rank: rankFor(a.scored, a.withSymptom, foodRate, lift, baselineReliable),
      confidence,
      topSymptoms,
    };
  });

  // Sort worst → best (by lift, then rate, then exposures). UI groups by rank.
  return scores.sort(
    (a, b) => liftNum(b.lift) - liftNum(a.lift) || b.foodRate - a.foodRate || b.eaten - a.eaten
  );
}

/** Renamed from `eaten` at the call site: the gate is settled exposures. */

const liftNum = (l: number) => (l === Infinity ? 999 : l);

function rankFor(
  scored: number,
  withSymptom: number,
  foodRate: number,
  lift: number,
  baselineReliable: boolean
): FoodRank {
  if (scored < MIN_EATEN) return "insufficient";

  // Avoid/Reduce require a trustworthy baseline (enough meals without this food);
  // a food present in nearly every meal can't be isolated.
  if (baselineReliable) {
    // Avoid: strong, repeated, and clearly above your baseline.
    if (withSymptom >= MIN_SYMPTOM_FOLLOWS && foodRate >= 0.6 && lift >= AVOID_LIFT) return "avoid";

    // Reduce: elevated above baseline with some repetition.
    if (withSymptom >= 2 && foodRate >= 0.4 && lift >= REDUCE_LIFT) return "reduce";
  }

  // Agrees: eaten enough, symptoms rarely follow, and at/below your baseline.
  if (foodRate <= 0.25 && lift <= 0.9) return "agrees";

  // Everything else (incl. foods whose rate just matches your overall baseline).
  return "neutral";
}

export const RANK_META: Record<FoodRank, { label: string; blurb: string; color: string }> = {
  avoid: { label: "Avoid", blurb: "Symptoms follow far more than your baseline", color: "#c0392b" },
  reduce: { label: "Reduce", blurb: "Somewhat above your baseline", color: "#ed9c1b" },
  neutral: { label: "Neutral", blurb: "About the same as your average meal", color: "#8a8a8e" },
  agrees: { label: "Agrees with you", blurb: "Rarely followed by symptoms", color: "#2e7d32" },
  insufficient: { label: "Need more data", blurb: "A few more settled meals to rank", color: "#5a5a5e" },
};

export const RANK_ORDER: FoodRank[] = ["avoid", "reduce", "neutral", "agrees", "insufficient"];
