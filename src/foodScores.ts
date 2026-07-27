// Per-food intolerance scoring. Reuses the lag-window idea from insights.ts but
// at the individual-ingredient level: for each food you've eaten, how often was
// it followed by symptoms within the window? Ranks foods avoid → agrees-with-you.

import { confidentNames, type LogEvent, type MealEvent, type LoggedSymptom } from "./db";
import { getSymptom } from "./symptoms";

const LAG_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_EATEN = 3; // need this many exposures before we rank with confidence

export type FoodRank = "avoid" | "reduce" | "neutral" | "agrees" | "insufficient";

export interface FoodScore {
  name: string; // display name (first-seen casing)
  eaten: number; // # meals containing it
  withSymptom: number; // # of those followed by a symptom in the window
  symptomRate: number; // 0..1
  rank: FoodRank;
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

  interface Acc {
    display: string;
    eaten: number;
    withSymptom: number;
    symptomCounts: Map<string, number>;
  }
  const byFood = new Map<string, Acc>();

  for (const meal of meals) {
    // symptom labels within (mealTime, mealTime + window]
    const labels = new Set<string>();
    for (const m of moments) {
      const dt = m.time - meal.createdAt;
      if (dt > 0 && dt <= LAG_WINDOW_MS) {
        for (const s of m.symptoms) if (isNegative(s.id)) labels.add(getSymptom(s.id)?.label ?? s.id);
      }
    }
    const followed = labels.size > 0;

    // de-dupe foods within a single meal
    const seen = new Set<string>();
    for (const raw of confidentNames(meal)) {
      const key = raw.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const acc = byFood.get(key) ?? {
        display: raw.trim(),
        eaten: 0,
        withSymptom: 0,
        symptomCounts: new Map<string, number>(),
      };
      acc.eaten += 1;
      if (followed) {
        acc.withSymptom += 1;
        for (const label of labels) acc.symptomCounts.set(label, (acc.symptomCounts.get(label) ?? 0) + 1);
      }
      byFood.set(key, acc);
    }
  }

  const scores: FoodScore[] = [...byFood.values()].map((a) => {
    const symptomRate = a.eaten ? +(a.withSymptom / a.eaten).toFixed(2) : 0;
    const topSymptoms = [...a.symptomCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 3);
    return {
      name: a.display,
      eaten: a.eaten,
      withSymptom: a.withSymptom,
      symptomRate,
      rank: rankFor(a.eaten, symptomRate),
      topSymptoms,
    };
  });

  // sort: worst first within the overall list; the UI groups by rank anyway
  return scores.sort((a, b) => b.symptomRate - a.symptomRate || b.eaten - a.eaten);
}

function rankFor(eaten: number, rate: number): FoodRank {
  if (eaten < MIN_EATEN) return "insufficient";
  if (rate >= 0.6) return "avoid";
  if (rate >= 0.35) return "reduce";
  if (rate <= 0.2) return "agrees";
  return "neutral";
}

export const RANK_META: Record<
  FoodRank,
  { label: string; blurb: string; color: string }
> = {
  avoid: { label: "Avoid", blurb: "Frequently followed by symptoms", color: "#c0392b" },
  reduce: { label: "Reduce", blurb: "Sometimes followed by symptoms", color: "#ed9c1b" },
  neutral: { label: "Neutral", blurb: "Mixed / unclear so far", color: "#8a8a8e" },
  agrees: { label: "Agrees with you", blurb: "Rarely followed by symptoms", color: "#2e7d32" },
  insufficient: { label: "Need more data", blurb: "Eat & log a few more times to rank", color: "#5a5a5e" },
};

export const RANK_ORDER: FoodRank[] = ["avoid", "reduce", "neutral", "agrees", "insufficient"];
