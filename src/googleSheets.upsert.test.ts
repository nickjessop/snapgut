import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeUpsertPlan } from "./googleSheets";
import type { LogEvent } from "./db";

// Feature: google-sheets-integration, Property 2: Sync upserts by event id (each id appears exactly once)
//
// For any set of existing sheet ids and any list of LogEvents, the plan produced
// by computeUpsertPlan assigns every event whose id is already present in the
// sheet to an update of that id's existing row (never an append), assigns every
// event whose id is absent to exactly one append, and results in each distinct
// event id being represented by exactly one row — never a duplicate.
//
// Validates: Requirements 4.1, 4.2, 4.3

// --- id pool ---
// Draw ids from a SMALL pool so collisions between existingIds and event ids
// happen frequently, exercising both the update and append branches.
const ID_POOL: string[] = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
const arbId = fc.constantFrom(...ID_POOL);

// --- lightweight LogEvent generators ---
// Only the `id` field matters for upsert planning, but each event must be a
// structurally valid LogEvent. Type-specific fields are filled with minimal
// valid values so the generated values are real LogEvents.
const arbMeal = (id: string): fc.Arbitrary<LogEvent> =>
  fc.record({
    type: fc.constant("meal" as const),
    id: fc.constant(id),
    createdAt: fc.integer({ min: 0, max: 4102444800000 }),
    dish: fc.string(),
    ingredients: fc.constant([]),
  });

const arbSymptom = (id: string): fc.Arbitrary<LogEvent> =>
  fc.record({
    type: fc.constant("symptom" as const),
    id: fc.constant(id),
    createdAt: fc.integer({ min: 0, max: 4102444800000 }),
    symptoms: fc.constant([]),
  });

const arbBowel = (id: string): fc.Arbitrary<LogEvent> =>
  fc.record({
    type: fc.constant("bowel" as const),
    id: fc.constant(id),
    createdAt: fc.integer({ min: 0, max: 4102444800000 }),
    bristol: fc.integer({ min: 1, max: 7 }),
  });

const arbCheckin = (id: string): fc.Arbitrary<LogEvent> =>
  fc.record({
    type: fc.constant("checkin" as const),
    id: fc.constant(id),
    createdAt: fc.integer({ min: 0, max: 4102444800000 }),
  });

// Any of the four event types, with its id drawn from the shared pool.
const arbLogEvent: fc.Arbitrary<LogEvent> = arbId.chain((id) =>
  fc.oneof(arbMeal(id), arbSymptom(id), arbBowel(id), arbCheckin(id)),
);

// existingIds: ids drawn from the pool, possibly with duplicates (simulates a
// sheet whose id column may repeat).
const arbExistingIds = fc.array(arbId, { maxLength: 12 });

// events: LogEvents whose ids overlap the existingIds pool.
const arbEvents = fc.array(arbLogEvent, { maxLength: 12 });

describe("computeUpsertPlan (Property 2: upsert by event id, each id appears exactly once)", () => {
  it("updates present ids at their first row, appends absent ids, and represents each id exactly once", () => {
    fc.assert(
      fc.property(arbExistingIds, arbEvents, (existingIds, events) => {
        const { updates, appends } = computeUpsertPlan(existingIds, events);

        // First-occurrence row index for each existing id (mirrors the oracle).
        const firstRowById = new Map<string, number>();
        existingIds.forEach((id, i) => {
          if (!firstRowById.has(id)) firstRowById.set(id, i);
        });

        const existingSet = new Set(existingIds);
        const distinctEventIds = new Set(events.map((e) => e.id));

        // (1) Every event whose id ∈ existingIds appears in updates (not appends),
        //     targeting the FIRST index of that id in existingIds.
        for (const id of distinctEventIds) {
          if (existingSet.has(id)) {
            const update = updates.find((u) => u.event.id === id);
            expect(update).toBeDefined();
            expect(update!.rowIndex).toBe(firstRowById.get(id));
            expect(appends.some((e) => e.id === id)).toBe(false);
          }
        }

        // (2) Every event whose id ∉ existingIds appears in appends.
        for (const id of distinctEventIds) {
          if (!existingSet.has(id)) {
            expect(appends.some((e) => e.id === id)).toBe(true);
            expect(updates.some((u) => u.event.id === id)).toBe(false);
          }
        }

        // (3) Each distinct event id appears exactly once across (updates ∪ appends):
        //     no id in both, no id duplicated, total equals the distinct id count.
        const updateIds = updates.map((u) => u.event.id);
        const appendIds = appends.map((e) => e.id);
        const allIds = [...updateIds, ...appendIds];
        expect(new Set(allIds).size).toBe(allIds.length); // no duplicates
        expect(allIds.length).toBe(distinctEventIds.size); // exactly the distinct ids

        // (4) No update targets an id not in existingIds; no append has an id in existingIds.
        for (const u of updates) {
          expect(existingSet.has(u.event.id)).toBe(true);
        }
        for (const e of appends) {
          expect(existingSet.has(e.id)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
