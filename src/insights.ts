// On-device analytics. Computes a compact "evidence summary" from the user's
// logs. The summary (not raw logs) is what we send to the AI to narrate, keeping
// cost low and grounding the model. See docs/research-and-insights.md.

import type { Entry } from "./db";
import { getSymptom, type Severity } from "./symptoms";
import { tagFood, TRIGGER_LABELS, IS_FODMAP, type TriggerGroup } from "./fodmap";

const SEV_SCORE: Record<Severity, number> = { mild: 1, moderate: 2, severe: 3 };

// Systemic symptoms that point more toward histamine than classic FODMAP gas.
const HISTAMINE_HINT = new Set(["skin", "flushing", "palpitations", "headache"]);

export type Focus =
  | "insufficient-data"
  | "fodmap-suspect"
  | "histamine-suspect"
  | "meal-timing"
  | "gut-brain";

export interface Association {
  trigger: string; // trigger group label or food name
  symptom: string; // symptom label
  count: number; // co-occurrences
  confidence: number; // 0..1 (share of trigger occurrences that had this symptom)
}

export interface EvidenceSummary {
  entryCount: number;
  dayCount: number;
  symptomEntryCount: number;
  topSymptoms: { label: string; count: number; avgSeverity: number }[];
  topTriggerGroups: { group: string; count: number; symptomRate: number }[];
  associations: Association[];
  lateNightSymptomRate: number | null; // symptoms after eating past 20:00
  focus: Focus;
}

const isNegative = (id: string) => getSymptom(id)?.category !== "Positive";

export function computeEvidence(entries: Entry[]): EvidenceSummary {
  const days = new Set(entries.map((e) => new Date(e.createdAt).toDateString()));
  const symptomEntries = entries.filter((e) =>
    e.symptoms.some((s) => isNegative(s.id))
  );

  // --- top symptoms ---
  const symMap = new Map<string, { count: number; sevSum: number }>();
  for (const e of entries) {
    for (const s of e.symptoms) {
      if (!isNegative(s.id)) continue;
      const label = getSymptom(s.id)?.label ?? s.id;
      const cur = symMap.get(label) ?? { count: 0, sevSum: 0 };
      cur.count += 1;
      cur.sevSum += SEV_SCORE[s.severity];
      symMap.set(label, cur);
    }
  }
  const topSymptoms = [...symMap.entries()]
    .map(([label, v]) => ({
      label,
      count: v.count,
      avgSeverity: +(v.sevSum / v.count).toFixed(1),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // --- trigger-group load + symptom rate ---
  const groupTotals = new Map<TriggerGroup, { total: number; withSym: number }>();
  for (const e of entries) {
    const groups = new Set<TriggerGroup>();
    e.foods.forEach((f) => tagFood(f).forEach((g) => groups.add(g)));
    const hasSym = e.symptoms.some((s) => isNegative(s.id));
    for (const g of groups) {
      const cur = groupTotals.get(g) ?? { total: 0, withSym: 0 };
      cur.total += 1;
      if (hasSym) cur.withSym += 1;
      groupTotals.set(g, cur);
    }
  }
  const topTriggerGroups = [...groupTotals.entries()]
    .map(([g, v]) => ({
      group: TRIGGER_LABELS[g],
      count: v.total,
      symptomRate: +(v.withSym / v.total).toFixed(2),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // --- associations: trigger group ↔ symptom (same-entry co-occurrence) ---
  const pairMap = new Map<string, number>();
  const groupOccur = new Map<TriggerGroup, number>();
  for (const e of entries) {
    const groups = new Set<TriggerGroup>();
    e.foods.forEach((f) => tagFood(f).forEach((g) => groups.add(g)));
    groups.forEach((g) => groupOccur.set(g, (groupOccur.get(g) ?? 0) + 1));
    const negSyms = e.symptoms.filter((s) => isNegative(s.id));
    for (const g of groups) {
      for (const s of negSyms) {
        const label = getSymptom(s.id)?.label ?? s.id;
        const key = `${g}\u0000${label}`;
        pairMap.set(key, (pairMap.get(key) ?? 0) + 1);
      }
    }
  }
  const associations: Association[] = [...pairMap.entries()]
    .map(([key, count]) => {
      const [g, symptom] = key.split("\u0000");
      const occ = groupOccur.get(g as TriggerGroup) ?? count;
      return {
        trigger: TRIGGER_LABELS[g as TriggerGroup],
        symptom,
        count,
        confidence: +(count / occ).toFixed(2),
      };
    })
    .filter((a) => a.count >= 2) // need repetition to matter
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence)
    .slice(0, 6);

  // --- late-night eating signal ---
  const lateEntries = entries.filter((e) => new Date(e.createdAt).getHours() >= 20);
  const lateNightSymptomRate = lateEntries.length
    ? +(
        lateEntries.filter((e) => e.symptoms.some((s) => isNegative(s.id))).length /
        lateEntries.length
      ).toFixed(2)
    : null;

  const focus = route({
    entryCount: entries.length,
    symptomEntries,
    topTriggerGroups,
    associations,
    lateNightSymptomRate,
  });

  return {
    entryCount: entries.length,
    dayCount: days.size,
    symptomEntryCount: symptomEntries.length,
    topSymptoms,
    topTriggerGroups,
    associations,
    lateNightSymptomRate,
    focus,
  };
}

function route(x: {
  entryCount: number;
  symptomEntries: Entry[];
  topTriggerGroups: { group: string; count: number; symptomRate: number }[];
  associations: Association[];
  lateNightSymptomRate: number | null;
}): Focus {
  if (x.entryCount < 5 || x.symptomEntries.length < 2) return "insufficient-data";

  const systemicShare =
    x.symptomEntries.filter((e) =>
      e.symptoms.some((s) => HISTAMINE_HINT.has(s.id))
    ).length / Math.max(1, x.symptomEntries.length);
  if (systemicShare >= 0.4) return "histamine-suspect";

  const fodmapGroups = x.topTriggerGroups.filter((g) =>
    Object.entries(IS_FODMAP).some(
      ([k, v]) => v && TRIGGER_LABELS[k as TriggerGroup] === g.group
    )
  );
  const strongFodmap = fodmapGroups.some((g) => g.count >= 3 && g.symptomRate >= 0.5);
  if (strongFodmap || x.associations.length > 0) return "fodmap-suspect";

  if ((x.lateNightSymptomRate ?? 0) >= 0.5) return "meal-timing";

  return "gut-brain";
}

/** Small headline stats for the top of the Insights tab. */
export function quickStats(entries: Entry[]) {
  const ev = computeEvidence(entries);
  return {
    meals: ev.entryCount,
    days: ev.dayCount,
    symptomDays: ev.symptomEntryCount,
    topSymptom: ev.topSymptoms[0]?.label ?? "—",
  };
}
