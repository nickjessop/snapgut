// On-device analytics over the event timeline. Because meals and symptoms are now
// separate timestamped events, we correlate them across a LAG WINDOW: a symptom is
// linked to meals eaten in the hours before it. The compact "evidence summary"
// (not raw logs) is what we send to the AI to narrate. See docs/research-and-insights.md.

import {
  confidentNames,
  type LogEvent,
  type MealEvent,
  type LoggedSymptom,
} from "./db";
import { getSymptom, type Severity } from "./symptoms";
import { tagFood, TRIGGER_LABELS, IS_FODMAP, type TriggerGroup } from "./fodmap";

const SEV_SCORE: Record<Severity, number> = { mild: 1, moderate: 2, severe: 3 };

// Symptoms can appear immediately up to ~24h later; the literature notes lags of
// hours (and sometimes longer). We attribute a symptom to meals in this window.
const LAG_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LAG_WINDOW_HOURS = 24;

// Systemic symptoms that point more toward histamine than classic FODMAP gas.
const HISTAMINE_HINT = new Set(["skin", "flushing", "palpitations", "headache"]);

export type Focus =
  | "insufficient-data"
  | "fodmap-suspect"
  | "histamine-suspect"
  | "meal-timing"
  | "gut-brain";

export interface Association {
  trigger: string;
  symptom: string;
  count: number;
  confidence: number; // share of meals-with-trigger followed by this symptom
}

export interface EvidenceSummary {
  mealCount: number;
  symptomCount: number;
  dayCount: number;
  lagWindowHours: number;
  topSymptoms: { label: string; count: number; avgSeverity: number }[];
  topTriggerGroups: { group: string; count: number; symptomRate: number }[];
  associations: Association[];
  lateNightSymptomRate: number | null;
  focus: Focus;
}

const isNegative = (id: string) => getSymptom(id)?.category !== "Positive";

interface SymptomOccurrence {
  time: number;
  symptoms: LoggedSymptom[];
}

export function computeEvidence(events: LogEvent[]): EvidenceSummary {
  const meals = events.filter((e): e is MealEvent => e.type === "meal");

  // All symptom-bearing moments (symptom events + bowel events with symptoms).
  const symptomMoments: SymptomOccurrence[] = [];
  for (const e of events) {
    if (e.type === "symptom") symptomMoments.push({ time: e.createdAt, symptoms: e.symptoms });
    else if (e.type === "bowel" && e.symptoms?.length)
      symptomMoments.push({ time: e.createdAt, symptoms: e.symptoms });
  }

  const days = new Set(events.map((e) => new Date(e.createdAt).toDateString()));

  // --- top symptoms across all symptom moments ---
  const symMap = new Map<string, { count: number; sevSum: number }>();
  for (const m of symptomMoments) {
    for (const s of m.symptoms) {
      if (!isNegative(s.id)) continue;
      const label = getSymptom(s.id)?.label ?? s.id;
      const cur = symMap.get(label) ?? { count: 0, sevSum: 0 };
      cur.count += 1;
      cur.sevSum += SEV_SCORE[s.severity];
      symMap.set(label, cur);
    }
  }
  const topSymptoms = [...symMap.entries()]
    .map(([label, v]) => ({ label, count: v.count, avgSeverity: +(v.sevSum / v.count).toFixed(1) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // --- lag-window correlation ---
  const mealsWithGroup = new Map<TriggerGroup, number>();
  const mealsGroupSymptom = new Map<TriggerGroup, number>(); // meal w/ group followed by any symptom
  const pairCount = new Map<string, number>(); // `${group}\0${label}`
  let lateMeals = 0;
  let lateMealsWithSymptom = 0;

  for (const meal of meals) {
    const groups = new Set<TriggerGroup>();
    confidentNames(meal).forEach((f) => tagFood(f).forEach((g) => groups.add(g)));

    // symptom labels occurring within (mealTime, mealTime + LAG_WINDOW]
    const labels = new Set<string>();
    for (const m of symptomMoments) {
      const dt = m.time - meal.createdAt;
      if (dt > 0 && dt <= LAG_WINDOW_MS) {
        for (const s of m.symptoms) if (isNegative(s.id)) labels.add(getSymptom(s.id)?.label ?? s.id);
      }
    }
    const followed = labels.size > 0;

    for (const g of groups) {
      mealsWithGroup.set(g, (mealsWithGroup.get(g) ?? 0) + 1);
      if (followed) mealsGroupSymptom.set(g, (mealsGroupSymptom.get(g) ?? 0) + 1);
      for (const label of labels) {
        const key = `${g}\u0000${label}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }

    if (new Date(meal.createdAt).getHours() >= 20) {
      lateMeals += 1;
      if (followed) lateMealsWithSymptom += 1;
    }
  }

  const topTriggerGroups = [...mealsWithGroup.entries()]
    .map(([g, total]) => ({
      group: TRIGGER_LABELS[g],
      count: total,
      symptomRate: +((mealsGroupSymptom.get(g) ?? 0) / total).toFixed(2),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const associations: Association[] = [...pairCount.entries()]
    .map(([key, count]) => {
      const [g, symptom] = key.split("\u0000");
      const denom = mealsWithGroup.get(g as TriggerGroup) ?? count;
      return {
        trigger: TRIGGER_LABELS[g as TriggerGroup],
        symptom,
        count,
        confidence: +(count / denom).toFixed(2),
      };
    })
    .filter((a) => a.count >= 2)
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence)
    .slice(0, 6);

  const lateNightSymptomRate = lateMeals ? +(lateMealsWithSymptom / lateMeals).toFixed(2) : null;

  const focus = route({ meals, symptomMoments, topTriggerGroups, associations, lateNightSymptomRate });

  return {
    mealCount: meals.length,
    symptomCount: symptomMoments.length,
    dayCount: days.size,
    lagWindowHours: LAG_WINDOW_HOURS,
    topSymptoms,
    topTriggerGroups,
    associations,
    lateNightSymptomRate,
    focus,
  };
}

function route(x: {
  meals: MealEvent[];
  symptomMoments: SymptomOccurrence[];
  topTriggerGroups: { group: string; count: number; symptomRate: number }[];
  associations: Association[];
  lateNightSymptomRate: number | null;
}): Focus {
  if (x.meals.length < 4 || x.symptomMoments.length < 2) return "insufficient-data";

  const systemicShare =
    x.symptomMoments.filter((m) => m.symptoms.some((s) => HISTAMINE_HINT.has(s.id))).length /
    Math.max(1, x.symptomMoments.length);
  if (systemicShare >= 0.4) return "histamine-suspect";

  const fodmapGroups = x.topTriggerGroups.filter((g) =>
    Object.entries(IS_FODMAP).some(([k, v]) => v && TRIGGER_LABELS[k as TriggerGroup] === g.group)
  );
  const strongFodmap = fodmapGroups.some((g) => g.count >= 3 && g.symptomRate >= 0.5);
  if (strongFodmap || x.associations.length > 0) return "fodmap-suspect";

  if ((x.lateNightSymptomRate ?? 0) >= 0.5) return "meal-timing";

  return "gut-brain";
}
