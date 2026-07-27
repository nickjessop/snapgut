// Per-food intolerance scoring with baseline-relative attribution.
//
// Raw "symptom rate" is misleading: if you get symptoms after most meals, every
// food looks bad; and a food you often eat WITHOUT symptoms should be exonerated.
// So we compare each food's follow-rate against your BASELINE — how often meals
// *without* that food are followed by symptoms — and only flag a food when it
// meaningfully exceeds baseline AND there's enough evidence.

import { confidentNames, type LogEvent, type MealEvent, type LoggedSymptom } from "./db";
import { getSymptom } from "./symptoms";

const LAG_WINDOW_MS = 24 * 60 * 60 * 1000;

// Evidence gates — deliberately conservative before we ever say "Avoid".
const MIN_EATEN = 4; // need at least this many exposures to rank at all
const MIN_SYMPTOM_FOLLOWS = 3; // need this many symptom-follows before "Avoid"
const MIN_OTHER_MEALS = 3; // need this many meals WITHOUT the food for a baseline
const AVOID_LIFT = 1.6; // must be ≥1.6× your baseline
const REDUCE_LIFT = 1.25;

export type FoodRank = "avoid" | "reduce" | "neutral" | "agrees" | "insufficient";

export interface FoodScore {
  name: string;
  eaten: number;
  withSymptom: number;
  foodRate: number; // symptom-follow rate for this food (0..1)
  baselineRate: number; // symptom-follow rate for meals WITHOUT this food
  lift: number; // foodRate / baselineRate
  rank: FoodRank;
  confidence: "low" | "medium" | "high";
  topSymptoms: { label: string; count: number }[];
}

const isNegative = (id: string) => getSymptom(id)?.category !== "Positive";

interface SymptomMoment {
  time: number;
  symptoms: LoggedSymptom[];
}

export function computeFoodScores(events: LogEvent[]): FoodScore[] {
  const meals = events.filter((e): e is MealEvent => e.type === "meal");

  const moments: SymptomMoment[] = [];
  for (const e of events) {
    if (e.type === "symptom") moments.push({ time: e.createdAt, symptoms: e.symptoms });
    else if (e.type === "bowel" && e.symptoms?.length)
      moments.push({ time: e.createdAt, symptoms: e.symptoms });
  }

  // Precompute, per meal: did a symptom follow within the window, and which labels.
  const mealInfo = meals.map((meal) => {
    const labels = new Set<string>();
    for (const m of moments) {
      const dt = m.time - meal.createdAt;
      if (dt > 0 && dt <= LAG_WINDOW_MS) {
        for (const s of m.symptoms) if (isNegative(s.id)) labels.add(getSymptom(s.id)?.label ?? s.id);
      }
    }
    const foods = new Set(
      confidentNames(meal).map((f) => f.trim().toLowerCase()).filter(Boolean)
    );
    return { followed: labels.size > 0, labels, foods, display: meal };
  });

  const totalMeals = mealInfo.length;
  const totalFollowed = mealInfo.filter((m) => m.followed).length;

  // Accumulate per-food.
  interface Acc {
    display: string;
    eaten: number;
    withSymptom: number;
    symptomCounts: Map<string, number>;
  }
  const byFood = new Map<string, Acc>();
  for (const info of mealInfo) {
    const seen = new Set<string>();
    for (const raw of confidentNames(info.display)) {
      const key = raw.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const acc =
        byFood.get(key) ?? { display: raw.trim(), eaten: 0, withSymptom: 0, symptomCounts: new Map() };
      acc.eaten += 1;
      if (info.followed) {
        acc.withSymptom += 1;
        for (const label of info.labels)
          acc.symptomCounts.set(label, (acc.symptomCounts.get(label) ?? 0) + 1);
      }
      byFood.set(key, acc);
    }
  }

  const scores: FoodScore[] = [...byFood.values()].map((a) => {
    const foodRate = a.eaten ? a.withSymptom / a.eaten : 0;

    // baseline = symptom-follow rate for meals that did NOT contain this food
    const otherMeals = totalMeals - a.eaten;
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

    const confidence: FoodScore["confidence"] =
      a.eaten >= 8 ? "high" : a.eaten >= 5 ? "medium" : "low";

    const topSymptoms = [...a.symptomCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 3);

    return {
      name: a.display,
      eaten: a.eaten,
      withSymptom: a.withSymptom,
      foodRate: +foodRate.toFixed(2),
      baselineRate: +baselineRate.toFixed(2),
      lift: lift === Infinity ? Infinity : +lift.toFixed(2),
      rank: rankFor(a.eaten, a.withSymptom, foodRate, lift, baselineReliable),
      confidence,
      topSymptoms,
    };
  });

  // Sort worst → best (by lift, then rate, then exposures). UI groups by rank.
  return scores.sort(
    (a, b) => liftNum(b.lift) - liftNum(a.lift) || b.foodRate - a.foodRate || b.eaten - a.eaten
  );
}

const liftNum = (l: number) => (l === Infinity ? 999 : l);

function rankFor(
  eaten: number,
  withSymptom: number,
  foodRate: number,
  lift: number,
  baselineReliable: boolean
): FoodRank {
  if (eaten < MIN_EATEN) return "insufficient";

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
  insufficient: { label: "Need more data", blurb: "Eat & log a few more times to rank", color: "#5a5a5e" },
};

export const RANK_ORDER: FoodRank[] = ["avoid", "reduce", "neutral", "agrees", "insufficient"];
