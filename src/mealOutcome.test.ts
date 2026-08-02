import { describe, it, expect } from "vitest";
import { classifyMeals, unconfirmedMeals, LAG_WINDOW_MS } from "./mealOutcome";
import { computeFoodScores } from "./foodScores";
import { computeEvidence } from "./insights";
import type { LogEvent, MealEvent, SymptomEvent } from "./db";

/**
 * A symptom-free meal counting in a food's favour is the whole reason the app can say
 * "agrees with you", so these pin down when we are entitled to say it. The subtle case
 * is that "no symptom logged" is not one situation but three, and only one of them is
 * evidence — see the note at the top of mealOutcome.ts.
 */

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function meal(at: number, foods: string[], extra: Partial<MealEvent> = {}): MealEvent {
  return {
    id: `m${at}-${foods.join("-")}`,
    type: "meal",
    createdAt: at,
    // Written when it happened unless a test says otherwise. `updatedAt` is what proves
    // the app was in use, so it is the interesting knob here.
    updatedAt: at,
    dish: foods.join(" & "),
    ingredients: foods.map((name) => ({ name, confidence: "confident" as const })),
    ...extra,
  };
}

function symptom(at: number, id = "bloating"): SymptomEvent {
  return {
    id: `s${at}`,
    type: "symptom",
    createdAt: at,
    updatedAt: at,
    symptoms: [{ id, severity: "moderate" }],
  };
}

const outcomes = (events: LogEvent[], now = NOW) =>
  classifyMeals(events, now).map((v) => v.outcome);

describe("meal outcome classification", () => {
  it("reads a symptom in the window as a symptom-follow", () => {
    const events = [meal(NOW - 40 * HOUR, ["oats"]), symptom(NOW - 36 * HOUR)];
    expect(outcomes(events)).toEqual(["symptom"]);
  });

  it("ignores a symptom logged before the meal", () => {
    // Reflux at noon says nothing about dinner. Only a strictly positive lag counts.
    const events = [symptom(NOW - 41 * HOUR), meal(NOW - 40 * HOUR, ["oats"])];
    expect(outcomes(events)).toEqual(["unobserved"]);
  });

  it("ignores a symptom logged after the window closes", () => {
    const events = [
      meal(NOW - 80 * HOUR, ["oats"]),
      symptom(NOW - 80 * HOUR + LAG_WINDOW_MS + HOUR),
    ];
    // Later activity proves the user was around, so the silence within the window
    // itself is meaningful.
    expect(outcomes(events)).toEqual(["clear"]);
  });

  it("holds a meal whose window is still open as pending, not as good news", () => {
    // The bug this exists to prevent: a meal logged an hour ago used to count as a
    // clean exposure, which flattered exactly the foods someone just ate.
    expect(outcomes([meal(NOW - HOUR, ["oats"])])).toEqual(["pending"]);
  });

  it("settles a symptom-follow immediately, without waiting out the window", () => {
    const events = [meal(NOW - HOUR, ["oats"]), symptom(NOW - 30 * 60 * 1000)];
    expect(outcomes(events)).toEqual(["symptom"]);
  });

  it("counts silence once the user has come back and said nothing", () => {
    const first = NOW - 80 * HOUR;
    // A later write is proof of presence: they returned, and did not report anything
    // for the earlier window — including by backdating, which the app supports.
    //
    // The second meal stays unobserved in the same breath, and that asymmetry is the
    // point: evidence about a meal arrives from what happens *after* it, so the newest
    // meal in any streak is always the one we know least about.
    const events = [meal(first, ["oats"]), meal(first + LAG_WINDOW_MS + HOUR, ["rice"])];
    expect(outcomes(events)).toEqual(["clear", "unobserved"]);
  });

  it("will not read silence as good news when nobody was there to break it", () => {
    // Logged, then the app was never opened again. The meal may have sat fine or may
    // have been followed by a miserable night. This is absent data, not evidence.
    expect(outcomes([meal(NOW - 80 * HOUR, ["oats"])])).toEqual(["unobserved"]);
  });

  it("takes the user's word for it when they say a meal sat fine", () => {
    const events = [meal(NOW - 80 * HOUR, ["oats"], { outcome: "fine" })];
    expect(outcomes(events)).toEqual(["clear"]);
  });

  it("does not let a confirmation override a symptom that was actually logged", () => {
    const events = [
      meal(NOW - 40 * HOUR, ["oats"], { outcome: "fine" }),
      symptom(NOW - 36 * HOUR),
    ];
    expect(outcomes(events)).toEqual(["symptom"]);
  });

  it("reads presence from the write time, not the backdated event time", () => {
    const first = NOW - 80 * HOUR;
    // A meal backdated to before the first one: its `createdAt` is early, but it was
    // written now, which is what proves someone was present.
    const backdated = meal(first - 50 * HOUR, ["rice"]);
    backdated.updatedAt = NOW;
    const [oats] = classifyMeals([meal(first, ["oats"]), backdated], NOW);
    expect(oats.outcome).toBe("clear");
  });

  it("offers only unobserved meals for confirmation", () => {
    const events = [
      meal(NOW - 80 * HOUR, ["oats"]), // clear: later writes exist
      // Unobserved: its window closed half an hour ago, which is *after* the newest
      // write, so nothing has been recorded since there was anything to report.
      meal(NOW - LAG_WINDOW_MS - 0.5 * HOUR, ["rice"]),
      meal(NOW - HOUR, ["kale"]), // pending
    ];
    expect(unconfirmedMeals(events, NOW).map((m) => m.dish)).toEqual(["rice"]);
  });

  it("resolves an earlier unobserved meal as soon as anything else is logged", () => {
    // Worth stating outright, because it is why so little data is lost: logging
    // anything settles every meal whose window has already closed. Only the tail of a
    // streak can stay unobserved.
    const stale = meal(NOW - 30 * HOUR, ["oats"]);
    expect(outcomes([stale])).toEqual(["unobserved"]);
    expect(outcomes([stale, meal(NOW - HOUR, ["rice"])])).toEqual(["clear", "pending"]);
  });
});

describe("food scores over unsettled meals", () => {
  /** n exposures to `food`, one per day, all symptom-free, oldest first. */
  function streak(n: number, food: string, spacingHours = 30): LogEvent[] {
    return Array.from({ length: n }, (_, i) =>
      meal(NOW - (n - i) * spacingHours * HOUR, [food, `filler${i}`])
    );
  }

  const scoreFor = (events: LogEvent[], food: string) =>
    computeFoodScores(events, NOW).find((s) => s.name === food);

  it("credits symptom-free exposures, which is what earns 'agrees with you'", () => {
    const oats = scoreFor(streak(6, "oats"), "oats");
    expect(oats?.clear).toBeGreaterThanOrEqual(4);
    expect(oats?.withSymptom).toBe(0);
    expect(oats?.rank).toBe("agrees");
  });

  it("keeps 'eaten' as every exposure while rating only the settled ones", () => {
    // The last meal in a streak has nothing written after it, so it cannot be counted
    // as clean — but the user still ate the food that many times.
    const events = streak(5, "oats");
    const oats = scoreFor(events, "oats");
    expect(oats?.eaten).toBe(5);
    expect(oats?.scored).toBe(4);
    expect(oats?.unobserved).toBe(1);
  });

  it("does not let a meal from minutes ago dilute a food's symptom rate", () => {
    // Four settled exposures, three of them followed by symptoms.
    const events: LogEvent[] = [];
    for (let i = 5; i >= 2; i--) {
      const at = NOW - i * 30 * HOUR;
      events.push(meal(at, ["oats"]));
      if (i > 2) events.push(symptom(at + 2 * HOUR));
    }
    // A check-in after the last meal's window closes, so all four are settled before
    // the fresh exposure is added. Without it the new meal's *write* would resolve the
    // last one, and the rate would move for that reason instead of the one under test.
    events.push({
      id: "c1",
      type: "checkin",
      createdAt: NOW - 20 * HOUR,
      updatedAt: NOW - 20 * HOUR,
      stress: "low",
    });
    const settledRate = scoreFor(events, "oats")!.foodRate;

    // Now eat it again just now. The new exposure is undecided, so the rate must not
    // move — under the old behaviour it dropped as though the meal had gone fine.
    const withFresh = [...events, meal(NOW - HOUR, ["oats"])];
    const after = scoreFor(withFresh, "oats")!;
    expect(after.foodRate).toBe(settledRate);
    expect(after.pending).toBe(1);
    expect(after.eaten).toBe(5);
  });

  it("holds back a ranking until enough exposures have settled", () => {
    // Four exposures, but all logged today, so none has resolved.
    const events = Array.from({ length: 4 }, (_, i) => meal(NOW - i * HOUR, ["oats"]));
    expect(scoreFor(events, "oats")?.rank).toBe("insufficient");
  });

  it("lets a confirmation settle exposures that silence could not", () => {
    const bare = streak(4, "oats");
    expect(scoreFor(bare, "oats")?.scored).toBe(3);

    const confirmed = bare.map((e) =>
      e.type === "meal" ? { ...e, outcome: "fine" as const } : e
    );
    const oats = scoreFor(confirmed, "oats")!;
    expect(oats.scored).toBe(4);
    expect(oats.rank).toBe("agrees");
  });
});

describe("evidence summary over unsettled meals", () => {
  it("reports total, settled, pending and unobserved meals separately", () => {
    const events: LogEvent[] = [
      meal(NOW - 80 * HOUR, ["oats"]), // clear
      meal(NOW - 50 * HOUR, ["rice"]), // clear
      // Unobserved: window closed after the newest write (the pending meal below).
      meal(NOW - LAG_WINDOW_MS - 0.5 * HOUR, ["kale"]),
      meal(NOW - HOUR, ["tofu"]), // pending
    ];
    const ev = computeEvidence(events, NOW);
    expect(ev.mealCount).toBe(4);
    expect(ev.scoredMealCount).toBe(2);
    expect(ev.clearMealCount).toBe(2);
    expect(ev.unobservedMealCount).toBe(1);
    expect(ev.pendingMealCount).toBe(1);
  });

  it("keeps an undecided meal out of the late-night rate", () => {
    // 21:00 local on the most recent day, so it lands in the late-night bucket while
    // still being inside its lag window.
    const late = new Date(NOW);
    late.setHours(21, 0, 0, 0);
    const ev = computeEvidence([meal(late.getTime(), ["cheese"])], late.getTime() + HOUR);
    expect(ev.lateNightSymptomRate).toBeNull();
  });
});
