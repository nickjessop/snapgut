import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { rowFromEvent, SHEET_HEADER } from "./googleSheets";
import { toCSV, type LogEvent } from "./db";
import { SYMPTOMS, getSymptom } from "./symptoms";

// Feature: google-sheets-integration, Property 3: Rows reuse the toCSV mapping and exclude photos
//
// For any LogEvent, the first ten cells of rowFromEvent(e, labelFor) are exactly
// equal to the corresponding cells of the single data row produced by
// toCSV([e], labelFor), the row has exactly eleven cells (the ten CSV columns
// plus the appended id), the final cell equals e.id, and no cell contains a Blob
// or any photo data.
//
// Validates: Requirements 4.4, 4.5

// --- label mapping from the real SYMPTOMS registry ---
// rowFromEvent and toCSV both render logged symptoms as `label (severity)`,
// where the label is resolved from the SYMPTOMS registry (falling back to the
// raw id if unknown).
const labelFor = (id: string): string => getSymptom(id)?.label ?? id;

// --- RFC4180-style CSV parser (single call over the whole toCSV output) ---
// toCSV escapes cells (wrapping any cell containing `" , \r \n` in double quotes
// and doubling internal quotes) then joins cells with commas and records with
// "\r\n". This parser inverts that escaping so we can compare rowFromEvent's raw
// (unescaped) cells directly against toCSV's per-cell values. It correctly
// handles quoted fields that themselves contain commas, quotes, and newlines.
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // Flush the trailing field/record (toCSV emits no trailing record separator).
  row.push(field);
  rows.push(row);
  return rows;
}

// --- generators ---

// Free text that frequently injects CSV-hostile characters (commas, quotes,
// newlines) to exercise the escaping logic shared with toCSV.
const arbText: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.string(),
      fc.constantFrom(",", '"', "\n", "\r", "\r\n", ";", "'", " ", "😃"),
    ),
  )
  .map((parts) => parts.join(""));

const arbSeverity = fc.constantFrom("mild" as const, "moderate" as const, "severe" as const);

const arbSymptomId = fc.constantFrom(...SYMPTOMS.map((s) => s.id));

const arbLoggedSymptom = fc.record({
  id: arbSymptomId,
  severity: arbSeverity,
});

const arbIngredient = fc.record({
  name: arbText,
  confidence: fc.constantFrom("confident" as const, "maybe" as const),
});

// createdAt: a valid epoch-ms integer (0 .. year ~2100) so new Date(...).toISOString() is safe.
const arbCreatedAt = fc.integer({ min: 0, max: 4102444800000 });
const arbId = fc.uuid();
const arbOptionalNote = fc.option(arbText, { nil: undefined });

const arbMeal: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("meal" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  dish: arbText,
  ingredients: fc.array(arbIngredient),
  // Optional dummy on-device photo Blob — must never appear in any row cell.
  photo: fc.option(
    fc.constant(null).map(() => new Blob(["x"])),
    { nil: undefined },
  ),
});

const arbSymptom: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("symptom" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  symptoms: fc.array(arbLoggedSymptom),
});

const arbBowel: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("bowel" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  bristol: fc.integer({ min: 1, max: 7 }),
  symptoms: fc.option(fc.array(arbLoggedSymptom), { nil: undefined }),
});

const arbCheckin: fc.Arbitrary<LogEvent> = fc.record({
  type: fc.constant("checkin" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: arbOptionalNote,
  stress: fc.option(fc.constantFrom("low" as const, "medium" as const, "high" as const), {
    nil: undefined,
  }),
  sleep: fc.option(fc.constantFrom("poor" as const, "ok" as const, "good" as const), {
    nil: undefined,
  }),
});

const arbLogEvent: fc.Arbitrary<LogEvent> = fc.oneof(arbMeal, arbSymptom, arbBowel, arbCheckin);

describe("rowFromEvent (Property 3: rows reuse the toCSV mapping and exclude photos)", () => {
  it("matches toCSV's data-row cells, appends id, and never leaks photo data", () => {
    fc.assert(
      fc.property(arbLogEvent, (e) => {
        const row = rowFromEvent(e, labelFor);

        // Exactly eleven cells: the ten CSV columns plus the appended id.
        expect(row.length).toBe(11);
        expect(row.length).toBe(SHEET_HEADER.length);

        // The final cell is the event id.
        expect(row[10]).toBe(e.id);

        // No cell is a Blob or non-string photo data — every cell is a string.
        for (const cell of row) {
          expect(typeof cell).toBe("string");
          expect((cell as unknown) instanceof Blob).toBe(false);
        }

        // The first ten cells equal toCSV's parsed data-row cells (unescaped).
        const parsed = parseCSV(toCSV([e], labelFor));
        expect(parsed.length).toBe(2); // header + one data row
        const dataRow = parsed[1];
        expect(dataRow.length).toBe(10);
        expect(row.slice(0, 10)).toEqual(dataRow);
      }),
      { numRuns: 100 },
    );
  });
});
