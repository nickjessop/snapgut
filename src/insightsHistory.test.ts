// Batch B: persisted insights, and the trigger reference copy.
//
// The history store is deliberately defensive — it is read from a `meta` row that a
// future version, a partial write, or a hand-edited database could leave in any
// shape, and a malformed row must degrade to "no history" rather than throw inside
// the Patterns view. Most of these cases are about that.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRIGGER_LABELS, IS_FODMAP, type TriggerGroup } from "./fodmap";
import { groupForLabel, infoForLabel, TRIGGER_INFO } from "./triggerInfo";

const store = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("./db", () => ({
  getMeta: async () => store.value,
  setMeta: async (_key: string, value: unknown) => {
    store.value = value;
  },
}));

const {
  listInsights,
  recordInsight,
  clearInsights,
  isStale,
  MAX_HISTORY,
  REFRESH_AFTER_MS,
} = await import("./insightHistory");

beforeEach(() => {
  store.value = undefined;
});

describe("recording insights", () => {
  it("keeps a generated insight", async () => {
    const list = await recordInsight(
      { headline: "Dairy shows up often", body: "Two paragraphs." },
      1_000
    );

    // The behaviour the feature exists for: leaving the tab no longer discards it.
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ at: 1_000, headline: "Dairy shows up often" });
    expect(await listInsights()).toHaveLength(1);
  });

  it("returns newest first regardless of write order", async () => {
    await recordInsight({ headline: "older", body: "b" }, 1_000);
    await recordInsight({ headline: "newer", body: "b" }, 5_000);

    expect((await listInsights()).map((p) => p.headline)).toEqual(["newer", "older"]);
  });

  it("carries the evidence behind the insight", async () => {
    await recordInsight(
      { headline: "h", body: "b", mealCount: 42, dayCount: 14 },
      1_000
    );

    // Without this an old narrative cannot be judged on what it had to work with.
    const [p] = await listInsights();
    expect(p.mealCount).toBe(42);
    expect(p.dayCount).toBe(14);
  });

  it("keeps a red flag when there is one", async () => {
    await recordInsight({ headline: "h", body: "b", redFlag: "See a clinician" }, 1);
    expect((await listInsights())[0].redFlag).toBe("See a clinician");
  });

  it("treats an identical insight seconds later as the same one", async () => {
    await recordInsight({ headline: "same", body: "same" }, 1_000);
    await recordInsight({ headline: "same", body: "same" }, 1_500);

    // Pro auto-generates on entering the tab and React effects can run twice, so a
    // repeat inside the window is a duplicate rather than a new observation.
    expect(await listInsights()).toHaveLength(1);
  });

  it("treats the same text much later as a new observation", async () => {
    await recordInsight({ headline: "same", body: "same" }, 1_000);
    await recordInsight({ headline: "same", body: "same" }, 1_000 + 5 * 60_000);

    // The same read a week later is a real data point: it says the pattern held.
    expect(await listInsights()).toHaveLength(2);
  });

  it("caps the history and drops the oldest", async () => {
    for (let i = 0; i < MAX_HISTORY + 8; i++) {
      await recordInsight({ headline: `h${i}`, body: "b" }, (i + 1) * 120_000);
    }

    const list = await listInsights();
    expect(list).toHaveLength(MAX_HISTORY);
    // Newest kept, oldest gone — a bounded convenience record, not an archive.
    expect(list[0].headline).toBe(`h${MAX_HISTORY + 7}`);
    expect(list.some((p) => p.headline === "h0")).toBe(false);
  });

  it("clears on request", async () => {
    await recordInsight({ headline: "h", body: "b" }, 1);
    await clearInsights();
    expect(await listInsights()).toEqual([]);
  });
});

describe("reading a malformed history row", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "not a list"],
    ["a number", 7],
    ["an object", { headline: "h" }],
  ])("returns nothing for %s", async (_label, value) => {
    store.value = value;
    expect(await listInsights()).toEqual([]);
  });

  it("discards only the entries that are unusable", async () => {
    store.value = [
      { at: 3_000, headline: "good", body: "b" },
      { at: "nope", headline: "bad clock", body: "b" },
      { headline: "no clock", body: "b" },
      { at: 1_000, headline: "also good", body: "b" },
      { at: 2_000, body: "no headline" },
      null,
      "junk",
    ];

    // A partial row must not cost the user the entries either side of it.
    const list = await listInsights();
    expect(list.map((p) => p.headline)).toEqual(["good", "also good"]);
  });

  it("drops non-string optional fields rather than passing them through", async () => {
    store.value = [{ at: 1, headline: "h", body: "b", redFlag: 42, mealCount: "x" }];

    const [p] = await listInsights();
    expect(p.redFlag).toBeUndefined();
    expect(p.mealCount).toBeUndefined();
  });

  it("survives a store that throws", async () => {
    vi.resetModules();
    vi.doMock("./db", () => ({
      getMeta: async () => {
        throw new Error("IndexedDB unavailable");
      },
      setMeta: async () => {},
    }));
    const mod = await import("./insightHistory");

    // An unavailable database must not break the Patterns view: the current insight
    // is still generated and shown, it simply is not remembered.
    await expect(mod.listInsights()).resolves.toEqual([]);
    vi.doUnmock("./db");
  });
});

describe("when the headline insight goes stale", () => {
  const insight = (at: number) => ({ at, headline: "h", body: "b" });

  it("treats having none as stale", () => {
    // Nothing to show is the strongest case for generating something.
    expect(isStale(null)).toBe(true);
  });

  it("keeps a fresh one", () => {
    const now = Date.now();
    expect(isStale(insight(now), now)).toBe(false);
    expect(isStale(insight(now - REFRESH_AFTER_MS + 1000), now)).toBe(false);
  });

  it("expires one a week old", () => {
    const now = Date.now();
    expect(isStale(insight(now - REFRESH_AFTER_MS), now)).toBe(true);
    expect(isStale(insight(now - 30 * 86_400_000), now)).toBe(true);
  });

  it("uses a week, long enough for the answer to have changed", () => {
    // Regenerating daily would spend AI calls narrating noise; a week is also how
    // people think about a diet change.
    expect(REFRESH_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("the trigger reference", () => {
  const groups = Object.keys(TRIGGER_LABELS) as TriggerGroup[];

  it("covers every trigger group the app can display", () => {
    // A pattern row naming a group with no entry would offer a tap that opens
    // nothing, so the two vocabularies have to stay in step.
    for (const g of groups) {
      expect(TRIGGER_INFO[g], `missing reference for ${g}`).toBeTruthy();
    }
    expect(Object.keys(TRIGGER_INFO).sort()).toEqual([...groups].sort());
  });

  it("resolves a displayed label back to its group", () => {
    // `EvidenceSummary.associations` carries the human label, so the mapping back is
    // what makes the row tappable without changing the payload sent for insights.
    for (const g of groups) {
      expect(groupForLabel(TRIGGER_LABELS[g])).toBe(g);
    }
  });

  it("returns nothing for a label it does not know", () => {
    expect(groupForLabel("Gluten")).toBeNull();
    expect(infoForLabel("Gluten")).toBeNull();
  });

  it("marks the FODMAP subgroups consistently with fodmap.ts", () => {
    for (const g of groups) {
      expect(infoForLabel(TRIGGER_LABELS[g])?.isFodmap).toBe(IS_FODMAP[g]);
    }
  });

  it("says something substantive in every field", () => {
    for (const g of groups) {
      const info = TRIGGER_INFO[g];
      expect(info.summary.length, `${g} summary`).toBeGreaterThan(40);
      expect(info.found.length, `${g} found`).toBeGreaterThan(20);
      expect(info.why.length, `${g} why`).toBeGreaterThan(40);
    }
  });

  it("makes no causal or diagnostic claim", () => {
    // The same line docs/positioning.md draws for the marketing copy, for the same
    // regulatory reason — and this copy is easier to get wrong, because explaining a
    // mechanism invites causal phrasing.
    const forbidden = [
      /\bcauses\b/i,
      /\bwill cause\b/i,
      /\byou are intolerant\b/i,
      /\ballergic to\b/i,
      /\bdiagnos/i,
      /\bcures?\b/i,
      /\btreats?\b/i,
      /\byou should (?:avoid|cut|eliminate|stop)\b/i,
    ];
    for (const g of groups) {
      const text = `${TRIGGER_INFO[g].summary} ${TRIGGER_INFO[g].found} ${TRIGGER_INFO[g].why}`;
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${g} matches ${pattern}`).toBe(false);
      }
    }
  });
});
