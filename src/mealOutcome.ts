// What happened after a meal — and, just as importantly, whether we are entitled to
// say.
//
// A symptom-free meal is evidence in a food's favour, and both analyses already used
// it that way: the denominator is exposures, the numerator is symptom-follows, so a
// food you eat often without trouble earns its "Agrees with you". That part was right.
//
// What was wrong is that "no symptom logged" was read as "no symptom occurred",
// unconditionally, and that quietly conflates three different situations:
//
//  1. The window has closed and the user was demonstrably still using the app without
//     reporting anything. Their silence is about the food, and it counts.
//  2. The window has not closed yet. Nothing has been decided. Counting a meal logged
//     twenty minutes ago as symptom-free is not conservative, it is wrong — and it
//     biases the *most recent* foods most, which is exactly when someone is looking.
//  3. The window has closed but the user has not touched the app since. Maybe the meal
//     sat fine. Maybe they felt awful and lay down. Maybe they went on holiday. This is
//     an absence of data wearing the costume of good news.
//
// Only the first is evidence. The other two are excluded from rates, which costs less
// than it sounds: (3) can only ever be the tail of a logging streak, because logging
// anything at all resolves every earlier meal. For anyone using the app, almost all
// symptom-free meals land in (1) and still count in the food's favour.
//
// Presence is read from `updatedAt` rather than `createdAt` on purpose. `createdAt` is
// when the meal happened and is backdatable, so it proves nothing about when someone
// was at the app; `updatedAt` is when the device wrote the record, which is exactly the
// question being asked.

import { getSymptom } from "./symptoms";
import type { LogEvent, MealEvent, LoggedSymptom } from "./db";

/** Symptoms can lag a meal by hours. Shared by both analyses. */
export const LAG_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MealOutcome =
  /** A negative symptom was logged inside the window. */
  | "symptom"
  /** Window closed, nothing reported, and we know the user was around to report. */
  | "clear"
  /** Window still open. Undecided, not good news. */
  | "pending"
  /** Window closed, nothing reported, and no sign the user was there to report it. */
  | "unobserved";

export interface MealVerdict {
  meal: MealEvent;
  outcome: MealOutcome;
  /** Distinct negative symptom labels inside the window. */
  labels: Set<string>;
  /** Whether this meal may be counted in a rate at all. */
  counted: boolean;
}

const isNegative = (id: string) => getSymptom(id)?.category !== "Positive";

interface Moment {
  time: number;
  symptoms: LoggedSymptom[];
}

/** Symptom-bearing moments: symptom events, plus bowel entries that carry symptoms. */
export function symptomMoments(events: LogEvent[]): Moment[] {
  const out: Moment[] = [];
  for (const e of events) {
    if (e.type === "symptom") out.push({ time: e.createdAt, symptoms: e.symptoms });
    else if (e.type === "bowel" && e.symptoms?.length)
      out.push({ time: e.createdAt, symptoms: e.symptoms });
  }
  return out;
}

/**
 * The last moment we can prove the app was in use — the newest write across every
 * event. One scalar is enough: "was anything written after this meal's window closed"
 * only ever needs the maximum.
 */
function lastWriteAt(events: LogEvent[]): number {
  let max = 0;
  for (const e of events) {
    // `updatedAt` is required by the schema, but a record reconstructed from an older
    // backup or a spreadsheet row may still arrive without one.
    const at = e.updatedAt || e.createdAt;
    if (at > max) max = at;
  }
  return max;
}

export function classifyMeals(events: LogEvent[], now: number = Date.now()): MealVerdict[] {
  const moments = symptomMoments(events);
  const presence = lastWriteAt(events);

  return events
    .filter((e): e is MealEvent => e.type === "meal")
    .map((meal) => {
      const closesAt = meal.createdAt + LAG_WINDOW_MS;

      const labels = new Set<string>();
      for (const m of moments) {
        const dt = m.time - meal.createdAt;
        if (dt > 0 && dt <= LAG_WINDOW_MS) {
          for (const s of m.symptoms) {
            if (isNegative(s.id)) labels.add(getSymptom(s.id)?.label ?? s.id);
          }
        }
      }

      let outcome: MealOutcome;
      if (labels.size > 0) {
        // A reported symptom settles it even if the window is still open — the
        // evidence exists, so there is nothing to wait for.
        outcome = "symptom";
      } else if (now < closesAt) {
        outcome = "pending";
      } else if (meal.outcome === "fine") {
        // Said so directly. The strongest form of this evidence, and the only one that
        // does not depend on an inference about presence.
        outcome = "clear";
      } else if (presence > closesAt) {
        outcome = "clear";
      } else {
        outcome = "unobserved";
      }

      return {
        meal,
        outcome,
        labels,
        counted: outcome === "symptom" || outcome === "clear",
      };
    });
}

/** Meals a user could usefully confirm, newest first. */
export function unconfirmedMeals(events: LogEvent[], now: number = Date.now()): MealEvent[] {
  return classifyMeals(events, now)
    .filter((v) => v.outcome === "unobserved")
    .map((v) => v.meal)
    .sort((a, b) => b.createdAt - a.createdAt);
}
