import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeUpsertPlan, rowFromEvent } from "./googleSheets";
import type { LogEvent } from "./db";
import { SYMPTOMS, getSymptom } from "./symptoms";

// Feature: google-sheets-integration, Property 4: Sync is idempotent
//
// For any list of LogEvents, applying the upsert plan to an empty sheet and then
// computing the plan again against the resulting sheet produces zero appends and
// updates that leave every row byte-for-byte identical, so the sheet contents
// after the second sync equal the contents after the first.
//
// Validates: Requirements 4.7

// --- label mapping from the real SYMPTOMS registry ---
// rowFromEvent renders logged symptoms as `label (severity)` using labelFor.
const labelFor = (id: string): string => getSymptom(id)?.label ?? id;

// --- generators ---

const arbSeverity = fc.constantFrom("mild" as const, "moderate" as const, "severe" as const);
const arbSymptomId = fc.constantFrom(...SYMPTOMS.map((s) => s.id));
const arbLoggedSymptom = fc.record({ id: arbSymptomId, severity: arbSeverity });

const arbText: fc.Arbitrary<string> = fc
  .array(fc.oneof(fc.string(), fc.constantFrom(",", '"', "\n", ";", "'", " ", "😃")))
  .map((parts) => parts.join(""));

const arbIngredient = fc.record({
  name: arbText,
  confidence: fc.constantFrom("confident" as const, "maybe" as const),
});

const arbCreatedAt = fc.integer({ min: 0, max: 4102444800000 });

// Draw ids from a small pool so events frequently share ids within a list. This
// exercises the dedup path (last payload wins) that computeUpsertPlan performs,
// which is exactly the scenario idempotence must survive.
const arbId = fc.constantFrom("id-a", "id-b", "id-c", "id-d", "id-e");

const arbMeal: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("meal" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  dish: arbText,
  ingredients: fc.array(arbIngredient),
});

const arbSymptom: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("symptom" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  symptoms: fc.array(arbLoggedSymptom),
});

const arbBowel: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("bowel" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  bristol: fc.integer({ min: 1, max: 7 }),
  symptoms: fc.option(fc.array(arbLoggedSymptom), { nil: undefined }),
});

const arbCheckin: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("checkin" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  stress: fc.option(fc.constantFrom("low" as const, "medium" as const, "high" as const), {
    nil: undefined,
  }),
  sleep: fc.option(fc.constantFrom("poor" as const, "ok" as const, "good" as const), {
    nil: undefined,
  }),
});

const arbLogEvent: fc.Arbitrary<LogEvent> = fc.oneof(arbMeal, arbSymptom, arbBowel, arbCheckin);

// --- sheet model ---
// A sheet is modeled as an array of rows; each row is rowFromEvent(event, labelFor)
// and its id is the last cell (index 10). "Applying a plan" starts from the given
// rows, applies updates in place at rowIndex, then appends new rows in order.

function applyPlan(
  rows: string[][],
  plan: ReturnType<typeof computeUpsertPlan>,
): string[][] {
  const result = rows.map((r) => [...r]);
  for (const { rowIndex, event } of plan.updates) {
    result[rowIndex] = rowFromEvent(event, labelFor);
  }
  for (const event of plan.appends) {
    result.push(rowFromEvent(event, labelFor));
  }
  return result;
}

describe("computeUpsertPlan (Property 4: sync is idempotent)", () => {
  it("a second sync appends nothing and leaves every row byte-for-byte identical", () => {
    fc.assert(
      fc.property(fc.array(arbLogEvent), (events) => {
        // First sync: empty sheet → all appends (one per distinct id).
        const plan1 = computeUpsertPlan([], events);
        expect(plan1.updates.length).toBe(0);
        const sheetAfter1 = applyPlan([], plan1);

        // The sheet has exactly one row per distinct event id.
        const distinctIds = new Set(events.map((e) => e.id));
        expect(sheetAfter1.length).toBe(distinctIds.size);

        // Second sync against the resulting sheet.
        const existingIds1 = sheetAfter1.map((row) => row[10]);
        const plan2 = computeUpsertPlan(existingIds1, events);

        // No new rows on the second sync.
        expect(plan2.appends.length).toBe(0);

        // Applying plan2 (updates only) reproduces a byte-for-byte identical sheet.
        const sheetAfter2 = applyPlan(sheetAfter1, plan2);
        expect(sheetAfter2).toEqual(sheetAfter1);
      }),
      { numRuns: 100 },
    );
  });
});
