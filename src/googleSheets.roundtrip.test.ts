import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { rowFromEvent, eventFromRow } from "./googleSheets";
// A spreadsheet row carries no Revision_Time, so these fixtures and the row
// mapping work over `DraftEvent` — a log event without the `updatedAt` that
// `putEvent` assigns on the way into the Local_Store.
import type { DraftEvent } from "./db";
import { SYMPTOMS, getSymptom } from "./symptoms";

// Feature: google-sheets-integration, Property 5: Sync → re-import round-trip preserves non-photo fields
//
// For any DraftEvent, eventFromRow(rowFromEvent(e, labelFor), symptomIdFor)
// reconstructs an event deeply equal to `e` on all non-photo fields (id,
// createdAt, type, and every type-specific field), where labelFor/symptomIdFor
// are inverse label mappings from the SYMPTOMS registry.
//
// Validates: Requirements 9.1, 9.4

// --- inverse label maps from the real SYMPTOMS registry ---
// rowFromEvent renders logged symptoms as `label (severity)` using labelFor;
// eventFromRow parses that back using symptomIdFor. Symptom labels are unique in
// the registry (see design.md), so the label → id inverse is well-defined.
const labelFor = (id: string): string => getSymptom(id)?.label ?? id;
const byLabel = new Map(SYMPTOMS.map((s) => [s.label, s.id]));
const symptomIdFor = (label: string): string | undefined => byLabel.get(label);

// --- generators ---

// Free text that frequently injects hostile characters. rowFromEvent /
// eventFromRow operate on raw (unescaped) cell values, so commas, quotes, and
// newlines round-trip verbatim; the only sequence with special meaning is the
// list separator "; " (handled per-field below).
const arbHostileParts: fc.Arbitrary<string> = fc
  .array(fc.oneof(fc.string(), fc.constantFrom(",", '"', "\n", "\r", ";", "'", " ", "😃")))
  .map((parts) => parts.join(""));

// A note must be either absent or a NON-EMPTY string: rowFromEvent maps
// undefined → "" and eventFromRow maps "" → undefined, so undefined round-trips
// to undefined, but an empty-string note would collapse to undefined and break
// exact equality. Whitespace-only notes are fine (non-empty).
const arbNoteText: fc.Arbitrary<string> = arbHostileParts.filter((s) => s.length > 0);
const arbOptionalNote = fc.option(arbNoteText, { nil: undefined });

// dish is stored as a single cell (row[2]) and read back verbatim, so any
// content — including "; " — round-trips. Empty dish round-trips to "".
const arbDish: fc.Arbitrary<string> = arbHostileParts;

// Ingredient names are joined with "; " into one cell and split back on "; ".
// For an exact round-trip a name must be non-empty (empty names are filtered by
// splitList) and must NOT contain the exact "; " separator (which would be
// mis-split into extra names). Single semicolons, commas, quotes, and newlines
// are all fine.
const arbIngredientName: fc.Arbitrary<string> = arbHostileParts.filter(
  (s) => s.length > 0 && !s.includes("; "),
);

const arbSeverity = fc.constantFrom("mild" as const, "moderate" as const, "severe" as const);
const arbSymptomId = fc.constantFrom(...SYMPTOMS.map((s) => s.id));
const arbLoggedSymptom = fc.record({ id: arbSymptomId, severity: arbSeverity });

// Ingredients must be grouped confident-first then maybe, because eventFromRow
// reconstructs them as [...confident, ...maybe]. Build each group independently
// and concatenate so the reconstructed order matches the original array.
const arbIngredients = fc
  .tuple(
    fc.array(fc.record({ name: arbIngredientName, confidence: fc.constant("confident" as const) })),
    fc.array(fc.record({ name: arbIngredientName, confidence: fc.constant("maybe" as const) })),
  )
  .map(([confident, maybe]) => [...confident, ...maybe]);

// createdAt: a valid epoch-ms integer so new Date(ms).toISOString() round-trips
// exactly back to the same ms via new Date(iso).getTime().
const arbCreatedAt = fc.integer({ min: 0, max: 4102444800000 });
const arbId = fc.uuid();

const arbMeal: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("meal" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  dish: arbDish,
  ingredients: arbIngredients,
  // Optional dummy on-device photo Blob — never written to a row and never
  // reconstructed, so it is excluded from the round-trip comparison.
  photo: fc.option(
    fc.constant(null).map(() => new Blob(["x"])),
    { nil: undefined },
  ),
});

const arbSymptom: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("symptom" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  // symptoms is required for symptom events; an empty array round-trips to []
  // (parseSymptoms returns []), so an empty array is allowed here.
  symptoms: fc.array(arbLoggedSymptom),
});

const arbBowel: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("bowel" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  bristol: fc.integer({ min: 1, max: 7 }),
  // For bowel events, symptoms is optional and an empty array collapses to an
  // absent key on reconstruction, so generate either undefined or a NON-EMPTY
  // array to keep the round-trip exact.
  symptoms: fc.option(fc.array(arbLoggedSymptom, { minLength: 1 }), { nil: undefined }),
});

const arbCheckin: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("checkin" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  // Only defined enum values or undefined — an empty-string value would collapse
  // to undefined and could not round-trip exactly.
  stress: fc.option(fc.constantFrom("low" as const, "medium" as const, "high" as const), {
    nil: undefined,
  }),
  sleep: fc.option(fc.constantFrom("poor" as const, "ok" as const, "good" as const), {
    nil: undefined,
  }),
});

const arbLogEvent: fc.Arbitrary<DraftEvent> = fc.oneof(arbMeal, arbSymptom, arbBowel, arbCheckin);

// Strip the photo (and only the photo) from a meal event for comparison, since
// eventFromRow never reconstructs a photo.
function withoutPhoto(e: DraftEvent): DraftEvent {
  if (e.type === "meal") {
    const { photo, ...rest } = e;
    void photo;
    return rest;
  }
  return e;
}

describe("rowFromEvent → eventFromRow (Property 5: round-trip preserves non-photo fields)", () => {
  it("reconstructs an event deeply equal to the original on all non-photo fields", () => {
    fc.assert(
      fc.property(arbLogEvent, (e) => {
        const back = eventFromRow(rowFromEvent(e, labelFor), symptomIdFor);
        expect(back).toEqual(withoutPhoto(e));
      }),
      { numRuns: 100 },
    );
  });
});
