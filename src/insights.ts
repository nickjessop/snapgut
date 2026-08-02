// On-device analytics over the event timeline. Because meals and symptoms are now
// separate timestamped events, we correlate them across a LAG WINDOW: a symptom is
// linked to meals eaten in the hours before it. The compact "evidence summary"
// (not raw logs) is what we send to the AI to narrate. See docs/research-and-insights.md.

import {
  confidentIngredients,
  type LogEvent,
  type MealEvent,
  type CheckinEvent,
} from "./db";
import { classifyMeals, symptomMoments, LAG_WINDOW_MS } from "./mealOutcome";
import { getSymptom, type Severity } from "./symptoms";
import {
  tagsForIngredient,
  TRIGGER_LABELS,
  IS_FODMAP,
  type TriggerGroup,
} from "./fodmap";

const SEV_SCORE: Record<Severity, number> = { mild: 1, moderate: 2, severe: 3 };

// Symptoms can appear immediately up to ~24h later; the literature notes lags of
// hours (and sometimes longer). We attribute a symptom to meals in this window.
// The window itself lives in mealOutcome.ts, which both analyses share so they cannot
// drift apart on what "after a meal" means.
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
  /**
   * Meals with a settled outcome — the basis of every rate below. Short of
   * `mealCount` by the meals still inside their lag window plus those nobody was
   * around to report on (mealOutcome.ts).
   */
  scoredMealCount: number;
  /** Settled meals that went symptom-free. Evidence, and the majority for most users. */
  clearMealCount: number;
  /** Meals whose lag window has not closed. */
  pendingMealCount: number;
  /** Meals with no symptom logged and no sign the user was there to log one. */
  unobservedMealCount: number;
  symptomCount: number;
  dayCount: number;
  lagWindowHours: number;
  topSymptoms: { label: string; count: number; avgSeverity: number }[];
  topTriggerGroups: { group: string; count: number; symptomRate: number }[];
  associations: Association[];
  lateNightSymptomRate: number | null;
  // Of high-stress check-ins, share followed by symptoms within the lag window.
  highStressSymptomRate: number | null;
  focus: Focus;
}

const isNegative = (id: string) => getSymptom(id)?.category !== "Positive";

type SymptomOccurrence = ReturnType<typeof symptomMoments>[number];

export function computeEvidence(events: LogEvent[], now: number = Date.now()): EvidenceSummary {
  const allMeals = events.filter((e): e is MealEvent => e.type === "meal");
  const verdicts = classifyMeals(events, now);
  // Rates are computed over settled meals only, for the reasons in mealOutcome.ts.
  const settled = verdicts.filter((v) => v.counted);

  const symptomMomentList = symptomMoments(events);

  const days = new Set(events.map((e) => new Date(e.createdAt).toDateString()));

  // --- top symptoms across all symptom moments ---
  const symMap = new Map<string, { count: number; sevSum: number }>();
  for (const m of symptomMomentList) {
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

  for (const verdict of settled) {
    const meal = verdict.meal;
    const groups = new Set<TriggerGroup>();
    confidentIngredients(meal).forEach((ing) =>
      tagsForIngredient(ing).forEach((g) => groups.add(g))
    );

    const labels = verdict.labels;
    const followed = verdict.outcome === "symptom";

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

  // --- stress → symptom signal (gut-brain axis) ---
  const highStress = events.filter(
    (e): e is CheckinEvent => e.type === "checkin" && e.stress === "high"
  );
  let highStressFollowed = 0;
  for (const c of highStress) {
    const followed = symptomMomentList.some((m) => {
      const dt = m.time - c.createdAt;
      return dt > 0 && dt <= LAG_WINDOW_MS && m.symptoms.some((s) => isNegative(s.id));
    });
    if (followed) highStressFollowed += 1;
  }
  const highStressSymptomRate = highStress.length
    ? +(highStressFollowed / highStress.length).toFixed(2)
    : null;

  const focus = route({
    // Routing reads settled meals: a narrative should not be picked on the strength of
    // meals whose outcome is still open.
    meals: settled.map((v) => v.meal),
    symptomMoments: symptomMomentList,
    topTriggerGroups,
    associations,
    lateNightSymptomRate,
    highStressSymptomRate,
  });

  return {
    mealCount: allMeals.length,
    scoredMealCount: settled.length,
    clearMealCount: verdicts.filter((v) => v.outcome === "clear").length,
    pendingMealCount: verdicts.filter((v) => v.outcome === "pending").length,
    unobservedMealCount: verdicts.filter((v) => v.outcome === "unobserved").length,
    symptomCount: symptomMomentList.length,
    dayCount: days.size,
    lagWindowHours: LAG_WINDOW_HOURS,
    topSymptoms,
    topTriggerGroups,
    associations,
    lateNightSymptomRate,
    highStressSymptomRate,
    focus,
  };
}

function route(x: {
  meals: MealEvent[];
  symptomMoments: SymptomOccurrence[];
  topTriggerGroups: { group: string; count: number; symptomRate: number }[];
  associations: Association[];
  lateNightSymptomRate: number | null;
  highStressSymptomRate: number | null;
}): Focus {
  if (x.meals.length < 4 || x.symptomMoments.length < 2) return "insufficient-data";

  // A strong stress→symptom link points to the gut-brain axis over food.
  if ((x.highStressSymptomRate ?? 0) >= 0.6 && x.associations.length === 0) return "gut-brain";

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
