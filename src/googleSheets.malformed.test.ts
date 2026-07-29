import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { eventFromRow } from "./googleSheets";
import { SYMPTOMS } from "./symptoms";
import type { LogEvent } from "./db";

// Feature: google-sheets-integration, Property 6: Malformed rows are skipped, never fatal
//
// For any array of strings interpreted as a sheet row (including rows with a
// missing/empty id, an unrecognized type, an unparseable datetime, a non-numeric
// bristol, an out-of-set severity token, or an unknown symptom label),
// eventFromRow returns either a valid LogEvent or null, and never throws; when
// the row violates any of those constraints it returns null so the re-import
// skips it and continues.
//
// Validates: Requirements 9.3

// --- inverse label map from the real SYMPTOMS registry ---
// eventFromRow parses a symptoms cell of `label (severity)` tokens and resolves
// each label back to a symptom id; an unknown label yields undefined (→ skip).
const byLabel = new Map(SYMPTOMS.map((s) => [s.label, s.id]));
const symptomIdFor = (label: string): string | undefined => byLabel.get(label);

const KNOWN_TYPES = ["meal", "symptom", "bowel", "checkin"] as const;
const SEVERITIES = ["mild", "moderate", "severe"] as const;

// Row layout mirrors SHEET_HEADER:
// [datetime, type, dish, confident, maybe, symptoms, bristol, stress, sleep, note, id]
function buildRow(overrides: Partial<Record<number, string>>): string[] {
  const row = ["", "", "", "", "", "", "", "", "", "", ""];
  for (const [idx, value] of Object.entries(overrides)) {
    if (value !== undefined) row[Number(idx)] = value;
  }
  return row;
}

// --- shared building-block generators ---

// A valid epoch-ms integer whose ISO string round-trips through new Date().
const arbEpoch = fc.integer({ min: 0, max: 4102444800000 });
const arbValidDatetime = arbEpoch.map((ms) => new Date(ms).toISOString());
const arbId = fc.uuid();
const arbKnownType = fc.constantFrom(...KNOWN_TYPES);
const arbSeverity = fc.constantFrom(...SEVERITIES);

// --- deliberately malformed rows (mustBeNull: true) ---
// Each injects exactly one violation while keeping the rest of the row plausible,
// so we KNOW by construction that eventFromRow must return null.

// Missing / empty / whitespace id (row[10]).
const arbEmptyId = fc
  .record({
    dt: arbValidDatetime,
    type: arbKnownType,
    id: fc.constantFrom("", " ", "   ", "\t", "\n", "  \t "),
  })
  .map(({ dt, type, id }) => ({
    row: buildRow({ 0: dt, 1: type, 10: id }),
    mustBeNull: true,
  }));

// Array too short to contain an id column (index 10 undefined → empty id).
const arbTooShort = fc
  .array(fc.string(), { minLength: 0, maxLength: 10 })
  .map((row) => ({ row, mustBeNull: true }));

// Unrecognized event type (row[1] not one of the four known types).
const arbUnknownType = fc
  .record({
    dt: arbValidDatetime,
    id: arbId,
    type: fc
      .oneof(
        fc.string(),
        fc.constantFrom("food", "poop", "note", "MEAL", "Symptom", "bowels", "check-in", ""),
      )
      .filter((t) => !(KNOWN_TYPES as readonly string[]).includes(t)),
  })
  .map(({ dt, id, type }) => ({
    row: buildRow({ 0: dt, 1: type, 10: id }),
    mustBeNull: true,
  }));

// Unparseable datetime (row[0] cannot be converted to a finite epoch).
const arbBadDatetime = fc
  .record({
    id: arbId,
    type: arbKnownType,
    // Filter guarantees the string is genuinely unparseable (V8 accepts some
    // surprising formats, e.g. "13:99" parses as a time — those are excluded).
    dt: fc
      .constantFrom("not-a-date", "nope", "xyz", "🙂", "abcdef", "date", "zzz", "??")
      .filter((s) => Number.isNaN(new Date(s).getTime())),
  })
  .map(({ id, type, dt }) => ({
    row: buildRow({ 0: dt, 1: type, 10: id }),
    mustBeNull: true,
  }));

// Non-numeric bristol for a bowel row (row[6] not a number).
const arbBadBristol = fc
  .record({
    id: arbId,
    dt: arbValidDatetime,
    bristol: fc.constantFrom("abc", "xyz", "not-a-number", "1.2.3", "--", "NaN", "one", "3a"),
  })
  .map(({ id, dt, bristol }) => ({
    row: buildRow({ 0: dt, 1: "bowel", 6: bristol, 10: id }),
    mustBeNull: true,
  }));

// Out-of-set severity token in the symptoms cell (row[5]).
const arbBadSeverity = fc
  .record({
    id: arbId,
    dt: arbValidDatetime,
    label: fc.constantFrom(...SYMPTOMS.map((s) => s.label)),
    sev: fc.constantFrom("extreme", "none", "bad", "MILD", "Severe", "light", ""),
  })
  .map(({ id, dt, label, sev }) => ({
    row: buildRow({ 0: dt, 1: "symptom", 5: `${label} (${sev})`, 10: id }),
    mustBeNull: true,
  }));

// Unknown symptom label with a valid-shaped token (row[5]).
const arbUnknownLabel = fc
  .record({
    id: arbId,
    dt: arbValidDatetime,
    label: fc.constantFrom("Nonexistent", "Foobar", "ZZZ", "made up symptom", "xyzzy", "???"),
    sev: arbSeverity,
  })
  .map(({ id, dt, label, sev }) => ({
    row: buildRow({ 0: dt, 1: "symptom", 5: `${label} (${sev})`, 10: id }),
    mustBeNull: true,
  }));

// --- fully arbitrary rows (mustBeNull: false) ---
// Varying length (shorter/longer than 11) drawn from a pool that mixes garbage
// with plausible-looking cells, so some rows may reconstruct a valid LogEvent.
const arbCell = fc.oneof(
  fc.string(),
  fc.constantFrom(...KNOWN_TYPES),
  arbValidDatetime,
  fc.constantFrom("1", "2", "7", "0", "abc", "", " ", "low", "medium", "high", "poor", "ok", "good"),
  fc.constantFrom(...SYMPTOMS.map((s) => `${s.label} (mild)`)),
  arbId,
);
const arbArbitraryRow = fc
  .array(arbCell, { minLength: 0, maxLength: 15 })
  .map((row) => ({ row, mustBeNull: false }));

// Bias toward malformed rows (the six guaranteed-null branches outweigh the
// single arbitrary branch), while still exercising fully random arrays.
const arbSheetRow: fc.Arbitrary<{ row: string[]; mustBeNull: boolean }> = fc.oneof(
  { arbitrary: arbEmptyId, weight: 3 },
  { arbitrary: arbTooShort, weight: 2 },
  { arbitrary: arbUnknownType, weight: 3 },
  { arbitrary: arbBadDatetime, weight: 3 },
  { arbitrary: arbBadBristol, weight: 3 },
  { arbitrary: arbBadSeverity, weight: 3 },
  { arbitrary: arbUnknownLabel, weight: 3 },
  { arbitrary: arbArbitraryRow, weight: 3 },
);

// Structural validity of any non-null reconstruction.
function assertValidEvent(ev: LogEvent): void {
  expect(typeof ev.id).toBe("string");
  expect(ev.id.trim().length).toBeGreaterThan(0);
  expect(KNOWN_TYPES).toContain(ev.type);
  expect(Number.isFinite(ev.createdAt)).toBe(true);

  if (ev.type === "bowel") {
    expect(typeof ev.bristol).toBe("number");
    expect(Number.isFinite(ev.bristol)).toBe(true);
    for (const s of ev.symptoms ?? []) {
      expect(SEVERITIES).toContain(s.severity);
      expect(typeof s.id).toBe("string");
    }
  }
  if (ev.type === "symptom") {
    expect(Array.isArray(ev.symptoms)).toBe(true);
    for (const s of ev.symptoms) {
      expect(SEVERITIES).toContain(s.severity);
      expect(typeof s.id).toBe("string");
    }
  }
  if (ev.type === "meal") {
    expect(Array.isArray(ev.ingredients)).toBe(true);
  }
}

describe("eventFromRow (Property 6: malformed rows are skipped, never fatal)", () => {
  it("never throws, returns null or a valid event, and skips known-malformed rows", () => {
    fc.assert(
      fc.property(arbSheetRow, ({ row, mustBeNull }) => {
        let result: LogEvent | null = null;
        let threw = false;
        try {
          result = eventFromRow(row, symptomIdFor);
        } catch {
          threw = true;
        }

        // (1) eventFromRow never throws for any input row.
        expect(threw).toBe(false);

        // (3) Rows malformed by construction must be skipped (null).
        if (mustBeNull) {
          expect(result).toBeNull();
        }

        // (2) When non-null, the result must be a well-formed LogEvent.
        if (result !== null) {
          assertValidEvent(result);
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- concrete examples complementing the property (one violation each) ---

  it("skips a row with a missing/empty id", () => {
    const row = buildRow({ 0: new Date(0).toISOString(), 1: "meal", 10: "" });
    expect(eventFromRow(row, symptomIdFor)).toBeNull();
  });

  it("skips a row with an unrecognized type", () => {
    const row = buildRow({ 0: new Date(0).toISOString(), 1: "snack", 10: "abc" });
    expect(eventFromRow(row, symptomIdFor)).toBeNull();
  });

  it("skips a row with an unparseable datetime", () => {
    const row = buildRow({ 0: "not-a-date", 1: "meal", 10: "abc" });
    expect(eventFromRow(row, symptomIdFor)).toBeNull();
  });

  it("skips a bowel row with a non-numeric bristol", () => {
    const row = buildRow({ 0: new Date(0).toISOString(), 1: "bowel", 6: "abc", 10: "abc" });
    expect(eventFromRow(row, symptomIdFor)).toBeNull();
  });

  it("skips a symptom row with an out-of-set severity token", () => {
    const label = SYMPTOMS[0].label;
    const row = buildRow({
      0: new Date(0).toISOString(),
      1: "symptom",
      5: `${label} (extreme)`,
      10: "abc",
    });
    expect(eventFromRow(row, symptomIdFor)).toBeNull();
  });

  it("skips a symptom row with an unknown symptom label", () => {
    const row = buildRow({
      0: new Date(0).toISOString(),
      1: "symptom",
      5: "Nonexistent (mild)",
      10: "abc",
    });
    expect(eventFromRow(row, symptomIdFor)).toBeNull();
  });

  it("reconstructs a well-formed event from a valid row", () => {
    const row = buildRow({ 0: new Date(0).toISOString(), 1: "meal", 2: "Toast", 10: "id-1" });
    const ev = eventFromRow(row, symptomIdFor);
    expect(ev).not.toBeNull();
    if (ev) assertValidEvent(ev);
  });
});
