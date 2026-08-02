// Shared fast-check generators for the cloud-sync property tests.
//
// Feature: cloud-sync, task 1.3 — test infrastructure only. Nothing here is
// imported by application code.
//
// The generators honour the Requirement 20.1 domain: `dish`/`note` are 0–2,000
// characters, `ingredients` holds at most 50 elements, `symptoms` at most 20,
// symptom ids come from the real SYMPTOMS registry, `bristol` is an integer
// 1–7, and `severity`/`stress`/`sleep`/`confidence` are drawn from their literal
// unions. `createdAt` and `updatedAt` (Revision_Time) are integer epoch
// milliseconds from 0 to 4,102,444,800,000.
//
// Every optional field is generated in three states — absent (the key is really
// missing, not `undefined`), empty, and populated — which is what makes the
// presence/absence properties (Req 20.6) meaningful.

import fc from "fast-check";
import { SYMPTOMS } from "../symptoms";
import type { Severity } from "../symptoms";
import type {
  BowelEvent,
  CheckinEvent,
  Confidence,
  Ingredient,
  LoggedSymptom,
  LogEvent,
  MealEvent,
  SleepQuality,
  StressLevel,
  SymptomEvent,
} from "../db";

// ---------------------------------------------------------------------------
// Local record shapes
//
// The IndexedDB v3 types (`updatedAt` on `BaseEvent`, `Tombstone`,
// `StoredRecord`) land in task 2.1. Until then these structural types stand in,
// built on the existing `LogEvent` plus a required `updatedAt`, so this module
// does not need to touch `src/db.ts`. Once v3 ships these become aliases.
// ---------------------------------------------------------------------------

/** Fields the v3 schema adds to every stored record. */
export interface SyncRevisionFields {
  /** Revision_Time (Req 5.1). */
  updatedAt: number;
  /** Wire fields from a newer schema, preserved verbatim (Req 16.4, 16.9). */
  unknownFields?: Record<string, unknown>;
}

export type SyncMealEvent = MealEvent & SyncRevisionFields;
export type SyncSymptomEvent = SymptomEvent & SyncRevisionFields;
export type SyncBowelEvent = BowelEvent & SyncRevisionFields;
export type SyncCheckinEvent = CheckinEvent & SyncRevisionFields;
export type SyncLogEvent = SyncMealEvent | SyncSymptomEvent | SyncBowelEvent | SyncCheckinEvent;

/** A deletion marker: identity + revision only, no content (Req 5.3, 9.1). */
export interface SyncTombstone extends SyncRevisionFields {
  id: string;
  type: LogEvent["type"];
  createdAt: number;
  deleted: true;
}

export type SyncStoredRecord = SyncLogEvent | SyncTombstone;

export function isSyncTombstone(r: SyncStoredRecord): r is SyncTombstone {
  return (r as SyncTombstone).deleted === true;
}

// ---------------------------------------------------------------------------
// Domain constants (Requirement 20.1)
// ---------------------------------------------------------------------------

export const MAX_EPOCH_MS = 4_102_444_800_000;
export const MAX_TEXT_LENGTH = 2_000;
export const MAX_INGREDIENTS = 50;
export const MAX_SYMPTOMS = 20;

export const SEVERITY_VALUES: readonly Severity[] = ["mild", "moderate", "severe"];
export const CONFIDENCE_VALUES: readonly Confidence[] = ["confident", "maybe"];
export const STRESS_VALUES: readonly StressLevel[] = ["low", "medium", "high"];
export const SLEEP_VALUES: readonly SleepQuality[] = ["poor", "ok", "good"];
export const EVENT_TYPES: readonly LogEvent["type"][] = ["meal", "symptom", "bowel", "checkin"];
export const SYMPTOM_IDS: readonly string[] = SYMPTOMS.map((s) => s.id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drop keys whose value is `undefined`, so an "absent" optional field is really
 * absent. `fc.record` always materializes its keys, and `toEqual` cannot tell
 * `{ note: undefined }` from `{}`, so presence tests need the key gone.
 */
function omitUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** Truncate to `max` UTF-16 code units without splitting a surrogate pair. */
function capUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}

/** A fresh empty array per generation (never a shared instance). */
function emptyArray<T>(): fc.Arbitrary<T[]> {
  return fc.constant(null).map(() => [] as T[]);
}

/**
 * Absent / empty / populated, the three states Req 20.6 distinguishes.
 * `undefined` is stripped by `omitUndefined`, so absence is a missing key.
 */
export function arbOptional3<T>(
  populated: fc.Arbitrary<T>,
  empty: fc.Arbitrary<T>,
): fc.Arbitrary<T | undefined> {
  return fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 1 },
    { arbitrary: empty, weight: 1 },
    { arbitrary: populated, weight: 2 },
  );
}

/** Absent / present, for fields with no meaningful "empty" value (enums). */
export function arbOptional2<T>(populated: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 1 },
    { arbitrary: populated, weight: 2 },
  );
}

// ---------------------------------------------------------------------------
// Scalar arbitraries
// ---------------------------------------------------------------------------

export const arbId: fc.Arbitrary<string> = fc.uuid();
export const arbEpochMs: fc.Arbitrary<number> = fc.integer({ min: 0, max: MAX_EPOCH_MS });

/**
 * Adversarial free text, 0–2,000 code units: commas, quotation marks, newlines,
 * leading and trailing whitespace, CSV/JSON metacharacters, and characters
 * outside the Basic Multilingual Plane (Req 20.7).
 */
const arbTextPiece: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.string({ maxLength: 24 }), weight: 4 },
  { arbitrary: fc.fullUnicodeString({ maxLength: 12 }), weight: 2 },
  {
    arbitrary: fc.constantFrom(
      ",",
      '"',
      "''",
      "\n",
      "\r\n",
      "\t",
      " ",
      "   ",
      "; ",
      ";",
      "\\",
      "{}",
      "😃", // non-BMP emoji
      "🇯🇵", // regional-indicator pair
      "𝔘𝔫𝔦", // non-BMP letters
      "👨‍👩‍👧", // ZWJ sequence
      "e\u0301", // combining mark
    ),
    weight: 4,
  },
);

export const arbText: fc.Arbitrary<string> = fc.oneof(
  {
    arbitrary: fc
      .array(arbTextPiece, { maxLength: 40 })
      .map((parts) => capUnits(parts.join(""), MAX_TEXT_LENGTH)),
    weight: 6,
  },
  // Occasionally sit right on the 2,000-character boundary.
  {
    arbitrary: fc
      .string({ minLength: 1_900, maxLength: MAX_TEXT_LENGTH })
      .map((s) => capUnits(s, MAX_TEXT_LENGTH)),
    weight: 1,
  },
  // Whitespace-only text, so leading/trailing whitespace handling is exercised.
  { arbitrary: fc.constantFrom(" ", "  ", "\t", "\n", " x ", "\u00a0"), weight: 1 },
);

/** Non-empty adversarial text, for the "populated" state of optional text. */
export const arbNonEmptyText: fc.Arbitrary<string> = arbText.filter((s) => s.length > 0);

/**
 * Same adversarial character mix, kept short. Used for the many small strings
 * inside collections (ingredient names) so a 50-ingredient record stays a
 * reasonable size while still carrying hostile characters.
 */
export const arbShortText: fc.Arbitrary<string> = fc
  .array(arbTextPiece, { maxLength: 4 })
  .map((parts) => capUnits(parts.join(""), 60));

export const arbSeverity: fc.Arbitrary<Severity> = fc.constantFrom(...SEVERITY_VALUES);
export const arbConfidence: fc.Arbitrary<Confidence> = fc.constantFrom(...CONFIDENCE_VALUES);
export const arbStress: fc.Arbitrary<StressLevel> = fc.constantFrom(...STRESS_VALUES);
export const arbSleep: fc.Arbitrary<SleepQuality> = fc.constantFrom(...SLEEP_VALUES);
export const arbSymptomId: fc.Arbitrary<string> = fc.constantFrom(...SYMPTOM_IDS);
export const arbBristol: fc.Arbitrary<number> = fc.integer({ min: 1, max: 7 });
export const arbEventType: fc.Arbitrary<LogEvent["type"]> = fc.constantFrom(...EVENT_TYPES);

export const arbLoggedSymptom: fc.Arbitrary<LoggedSymptom> = fc.record({
  id: arbSymptomId,
  severity: arbSeverity,
});

export const arbIngredient: fc.Arbitrary<Ingredient> = fc.record({
  name: arbShortText,
  confidence: arbConfidence,
});

export const arbIngredients: fc.Arbitrary<Ingredient[]> = fc.array(arbIngredient, {
  maxLength: MAX_INGREDIENTS,
});

export const arbLoggedSymptoms: fc.Arbitrary<LoggedSymptom[]> = fc.array(arbLoggedSymptom, {
  maxLength: MAX_SYMPTOMS,
});

const arbNonEmptySymptoms: fc.Arbitrary<LoggedSymptom[]> = fc.array(arbLoggedSymptom, {
  minLength: 1,
  maxLength: MAX_SYMPTOMS,
});

const arbNonEmptyIngredients: fc.Arbitrary<Ingredient[]> = fc.array(arbIngredient, {
  minLength: 1,
  maxLength: MAX_INGREDIENTS,
});

/** JSON-safe fields from a newer schema version, never colliding with known keys. */
export const arbUnknownFields: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.constantFrom("x_extra", "futureField", "v4Only", "vendor:tag", "mood", "hydration"),
  fc.oneof(
    fc.string({ maxLength: 20 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
    fc.record({ nested: fc.string({ maxLength: 8 }) }),
  ),
  { maxKeys: 4 },
);

/**
 * Photo bytes — on-device only, and never allowed on the wire (Req 16.1, 20.2).
 *
 * The suite runs in jsdom, whose `Blob` exposes `size`/`type` but not
 * `arrayBuffer()`/`text()`, so compare photos by identity, `size`, or `type`.
 */
export const arbPhoto: fc.Arbitrary<Blob> = fc
  .uint8Array({ minLength: 1, maxLength: 64 })
  // Copy into a plain ArrayBuffer so the Blob part type is unambiguous.
  .map((bytes) => new Blob([Uint8Array.from(bytes).buffer as ArrayBuffer], { type: "image/jpeg" }));

const arbEmptyPhoto: fc.Arbitrary<Blob> = fc.constant(null).map(() => new Blob([]));

// ---------------------------------------------------------------------------
// Log events (Requirement 20.1 domain)
//
// `note` and `unknownFields` are generated absent / empty / populated. Enum
// fields (`stress`, `sleep`) have no "empty" member, so they are absent or
// populated only. Required collections (`ingredients`, `symptoms` on a symptom
// event) already include the empty array in their range.
// ---------------------------------------------------------------------------

const arbNote = arbOptional3(arbNonEmptyText, fc.constant(""));
const arbUnknown = arbOptional3(
  arbUnknownFields,
  fc.constant(null).map(() => ({}) as Record<string, unknown>),
);

export const arbMealEvent: fc.Arbitrary<SyncMealEvent> = fc
  .record({
    type: fc.constant("meal" as const),
    id: arbId,
    createdAt: arbEpochMs,
    updatedAt: arbEpochMs,
    note: arbNote,
    unknownFields: arbUnknown,
    dish: arbText,
    ingredients: fc.oneof(
      { arbitrary: emptyArray<Ingredient>(), weight: 1 },
      { arbitrary: arbNonEmptyIngredients, weight: 3 },
    ),
    // "fine" is the only value, so the domain is just present-or-absent — and absent
    // has to survive the round trip as absent, because "not stated" is a distinct
    // meaning from "fine" (see MealEvent.outcome).
    outcome: fc.option(fc.constant("fine" as const), { nil: undefined }),
  })
  .map(omitUndefined);

export const arbSymptomEvent: fc.Arbitrary<SyncSymptomEvent> = fc
  .record({
    type: fc.constant("symptom" as const),
    id: arbId,
    createdAt: arbEpochMs,
    updatedAt: arbEpochMs,
    note: arbNote,
    unknownFields: arbUnknown,
    symptoms: fc.oneof(
      { arbitrary: emptyArray<LoggedSymptom>(), weight: 1 },
      { arbitrary: arbNonEmptySymptoms, weight: 3 },
    ),
  })
  .map(omitUndefined);

export const arbBowelEvent: fc.Arbitrary<SyncBowelEvent> = fc
  .record({
    type: fc.constant("bowel" as const),
    id: arbId,
    createdAt: arbEpochMs,
    updatedAt: arbEpochMs,
    note: arbNote,
    unknownFields: arbUnknown,
    bristol: arbBristol,
    symptoms: arbOptional3(arbNonEmptySymptoms, emptyArray<LoggedSymptom>()),
  })
  .map(omitUndefined);

export const arbCheckinEvent: fc.Arbitrary<SyncCheckinEvent> = fc
  .record({
    type: fc.constant("checkin" as const),
    id: arbId,
    createdAt: arbEpochMs,
    updatedAt: arbEpochMs,
    note: arbNote,
    unknownFields: arbUnknown,
    stress: arbOptional2(arbStress),
    sleep: arbOptional2(arbSleep),
  })
  .map(omitUndefined);

/** The full `LogEvent` union, with a Revision_Time and no photo. */
export const arbLogEvent: fc.Arbitrary<SyncLogEvent> = fc.oneof(
  arbMealEvent,
  arbSymptomEvent,
  arbBowelEvent,
  arbCheckinEvent,
);

/** As `arbLogEvent`, but meals carry a photo absent / empty / populated. */
export const arbLogEventWithPhoto: fc.Arbitrary<SyncLogEvent> = fc.oneof(
  fc
    .tuple(arbMealEvent, arbOptional3(arbPhoto, arbEmptyPhoto))
    .map(([e, photo]): SyncMealEvent => omitUndefined({ ...e, photo })),
  arbSymptomEvent,
  arbBowelEvent,
  arbCheckinEvent,
);

/** A deletion marker: identity + revision only, never any content (Req 9.1). */
export const arbTombstone: fc.Arbitrary<SyncTombstone> = fc
  .record({
    id: arbId,
    type: arbEventType,
    createdAt: arbEpochMs,
    updatedAt: arbEpochMs,
    deleted: fc.constant(true as const),
    unknownFields: arbUnknown,
  })
  .map(omitUndefined);

/** Events (with optional photos) plus tombstones — what the Local_Store holds. */
export const arbStoredRecord: fc.Arbitrary<SyncStoredRecord> = fc.oneof(
  { arbitrary: arbLogEventWithPhoto, weight: 4 },
  { arbitrary: arbTombstone, weight: 1 },
);

export const arbStoredRecords: fc.Arbitrary<SyncStoredRecord[]> = fc.array(arbStoredRecord, {
  maxLength: 25,
});

/** Structural clone that keeps the photo Blob reference intact. */
export function cloneRecord<T extends SyncStoredRecord>(r: T): T {
  const src = r as unknown as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...src };
  if (Array.isArray(src.ingredients)) {
    copy.ingredients = (src.ingredients as Ingredient[]).map((i) => ({ ...i }));
  }
  if (Array.isArray(src.symptoms)) {
    copy.symptoms = (src.symptoms as LoggedSymptom[]).map((s) => ({ ...s }));
  }
  if (src.unknownFields && typeof src.unknownFields === "object") {
    copy.unknownFields = { ...(src.unknownFields as Record<string, unknown>) };
  }
  return copy as unknown as T;
}

// ---------------------------------------------------------------------------
// Record pairs (merge-rule properties)
// ---------------------------------------------------------------------------

/** How the two sides of a pair relate — ties are the interesting branches. */
export type TieMode = "distinct" | "equal-updatedAt" | "equal-updatedAt-and-createdAt" | "identical";

export interface RecordPair {
  a: SyncStoredRecord;
  b: SyncStoredRecord;
  tie: TieMode;
}

/**
 * Two records sharing an `id`, biased toward equal-`updatedAt` and
 * equal-`updatedAt`-plus-equal-`createdAt` ties, since those are the
 * tombstone-wins and canonical-key branches of the merge rule (Req 8.1–8.3).
 */
export const arbRecordPair: fc.Arbitrary<RecordPair> = fc
  .tuple(
    arbStoredRecord,
    arbStoredRecord,
    fc.constantFrom<TieMode>(
      "distinct",
      "equal-updatedAt",
      "equal-updatedAt",
      "equal-updatedAt-and-createdAt",
      "equal-updatedAt-and-createdAt",
      "identical",
    ),
  )
  .map(([left, right, tie]) => {
    const a = cloneRecord(left);
    if (tie === "identical") return { a, b: cloneRecord(a), tie };
    const b = cloneRecord(right) as SyncStoredRecord & { id: string };
    b.id = a.id;
    if (tie !== "distinct") b.updatedAt = a.updatedAt;
    if (tie === "equal-updatedAt-and-createdAt") b.createdAt = a.createdAt;
    return { a, b, tie };
  });

/** Three records sharing an `id`, for associativity (Property 2). */
export const arbRecordTriple: fc.Arbitrary<{
  a: SyncStoredRecord;
  b: SyncStoredRecord;
  c: SyncStoredRecord;
}> = fc.tuple(arbRecordPair, arbStoredRecord, fc.boolean()).map(([pair, third, tieThird]) => {
  const c = cloneRecord(third) as SyncStoredRecord & { id: string };
  c.id = pair.a.id;
  if (tieThird) c.updatedAt = pair.a.updatedAt;
  return { a: pair.a, b: pair.b, c };
});

// ---------------------------------------------------------------------------
// Wire records
//
// `toWireLike` is a deliberately dumb projection used only to give the
// generators a plausible on-the-wire shape. The real codec (`toEventRecord` /
// `fromEventRecord`) lands in task 6.1 and is the thing under test, so tests
// must never assert this helper against it — it exists to build inputs.
// ---------------------------------------------------------------------------

export const WIRE_SCHEMA_VERSION = 2;

export function toWireLike(r: SyncStoredRecord): Record<string, unknown> {
  const src = r as unknown as Record<string, unknown>;
  const unknown = (src.unknownFields ?? {}) as Record<string, unknown>;
  const wire: Record<string, unknown> = { ...unknown };
  wire.id = src.id;
  wire.type = src.type;
  wire.createdAt = src.createdAt;
  wire.updatedAt = src.updatedAt;
  wire.schemaVersion = WIRE_SCHEMA_VERSION;

  if (isSyncTombstone(r)) {
    wire.deleted = true;
    return wire; // no content, ever (Req 20.8)
  }

  if ("note" in src) wire.note = src.note;
  if (r.type === "meal") {
    wire.dish = r.dish;
    wire.ingredients = r.ingredients.map((i) => ({ ...i }));
    if (r.outcome !== undefined) wire.outcome = r.outcome;
    // `photo` is intentionally never projected (Req 16.1, 20.2).
  } else if (r.type === "symptom") {
    wire.symptoms = r.symptoms.map((s) => ({ ...s }));
  } else if (r.type === "bowel") {
    wire.bristol = r.bristol;
    if ("symptoms" in r && r.symptoms) wire.symptoms = r.symptoms.map((s) => ({ ...s }));
  } else {
    if ("stress" in r) wire.stress = r.stress;
    if ("sleep" in r) wire.sleep = r.sleep;
  }
  return wire;
}

/** Well-formed wire records: every field inside its declared domain. */
export const arbValidWireRecord: fc.Arbitrary<Record<string, unknown>> =
  arbStoredRecord.map(toWireLike);

/** A single out-of-domain edit applied to an otherwise valid wire record. */
interface WireMutation {
  label: string;
  apply: (wire: Record<string, unknown>) => unknown;
}

const WIRE_MUTATIONS: readonly WireMutation[] = [
  { label: "missing id", apply: (w) => ({ ...w, id: undefined }) },
  { label: "id not a string", apply: (w) => ({ ...w, id: 42 }) },
  { label: "missing createdAt", apply: (w) => ({ ...w, createdAt: undefined }) },
  { label: "createdAt not a number", apply: (w) => ({ ...w, createdAt: "yesterday" }) },
  { label: "missing updatedAt", apply: (w) => ({ ...w, updatedAt: undefined }) },
  { label: "updatedAt null", apply: (w) => ({ ...w, updatedAt: null }) },
  { label: "unrecognized type", apply: (w) => ({ ...w, type: "snack" }) },
  { label: "type not a string", apply: (w) => ({ ...w, type: 3 }) },
  { label: "note not a string", apply: (w) => ({ ...w, note: 7 }) },
  {
    label: "bad confidence",
    apply: (w) => ({
      ...w,
      type: "meal",
      dish: w.dish ?? "",
      ingredients: [{ name: "oats", confidence: "sure" }],
    }),
  },
  {
    label: "ingredients not an array",
    apply: (w) => ({ ...w, type: "meal", dish: w.dish ?? "", ingredients: "oats; milk" }),
  },
  {
    label: "bad severity",
    apply: (w) => ({ ...w, type: "symptom", symptoms: [{ id: "bloating", severity: "awful" }] }),
  },
  {
    label: "symptom id not a string",
    apply: (w) => ({ ...w, type: "symptom", symptoms: [{ id: 5, severity: "mild" }] }),
  },
  { label: "bristol below range", apply: (w) => ({ ...w, type: "bowel", bristol: 0 }) },
  { label: "bristol above range", apply: (w) => ({ ...w, type: "bowel", bristol: 8 }) },
  { label: "bristol not an integer", apply: (w) => ({ ...w, type: "bowel", bristol: 3.5 }) },
  { label: "bristol a string", apply: (w) => ({ ...w, type: "bowel", bristol: "4" }) },
  { label: "bad stress", apply: (w) => ({ ...w, type: "checkin", stress: "extreme" }) },
  { label: "bad sleep", apply: (w) => ({ ...w, type: "checkin", sleep: "meh" }) },
  { label: "deleted not true", apply: (w) => ({ ...w, deleted: "yes" }) },
];

/** Records that must be skipped rather than merged or thrown on (Req 20.3, 20.4). */
export const arbMalformedWireRecord: fc.Arbitrary<unknown> = fc.oneof(
  {
    arbitrary: fc
      .tuple(arbValidWireRecord, fc.constantFrom(...WIRE_MUTATIONS))
      .map(([wire, mutation]) => mutation.apply(wire)),
    weight: 5,
  },
  // Values that are not records at all.
  {
    arbitrary: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.boolean(),
      fc.string({ maxLength: 12 }),
      fc.constant(null).map(() => []),
      fc.constant(null).map(() => ({})),
      fc.constant(null).map(() => ({ schemaVersion: 99 })),
    ),
    weight: 1,
  },
);

/** Arbitrary wire values: well-formed records mixed with malformed ones. */
export const arbWireRecord: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: arbValidWireRecord, weight: 3 },
  { arbitrary: arbMalformedWireRecord, weight: 2 },
);

/** A pulled page: mostly valid records with malformed ones interleaved. */
export const arbWireRecordPage: fc.Arbitrary<unknown[]> = fc.array(arbWireRecord, {
  maxLength: 30,
});

// ---------------------------------------------------------------------------
// Device clocks (Property 14: Revision_Time never decreases)
// ---------------------------------------------------------------------------

/**
 * A sequence of `Date.now()` readings from a device whose clock is not
 * monotonic: forward steps, repeats (delta 0), and backward jumps, all clamped
 * to the valid epoch-ms range.
 */
export const arbClockSequence: fc.Arbitrary<number[]> = fc
  .tuple(
    arbEpochMs,
    fc.array(
      fc.oneof(
        { arbitrary: fc.constant(0), weight: 2 }, // repeat
        { arbitrary: fc.integer({ min: 1, max: 86_400_000 }), weight: 3 }, // forward
        { arbitrary: fc.integer({ min: -86_400_000, max: -1 }), weight: 3 }, // backward jump
        { arbitrary: fc.constant(-31_536_000_000), weight: 1 }, // a year back
      ),
      { minLength: 1, maxLength: 25 },
    ),
  )
  .map(([start, deltas]) => {
    const readings = [start];
    let current = start;
    for (const d of deltas) {
      current = Math.min(MAX_EPOCH_MS, Math.max(0, current + d));
      readings.push(current);
    }
    return readings;
  });

// ---------------------------------------------------------------------------
// Sync_State derivation (Property 15, Requirement 12.8)
// ---------------------------------------------------------------------------

/** Mirrors the `SyncStateInput` shape from design.md; task 8.5 owns the real type. */
export interface SyncStateInputLike {
  hasSession: boolean;
  pro: boolean;
  enabled: boolean;
  cycleInProgress: boolean;
  lastCycleFailed: boolean;
  failureKind: "offline" | "service" | null;
  succeededSinceFailure: boolean;
  outboxCount: number;
  lastSyncAt: number | null;
  skipped: number;
  restoreMerged: number | null;
  daysUntilPurge: number | null;
}

/**
 * Near-exhaustive coverage of the Requirement 12.8 condition space. The boolean
 * flags are independent on purpose — including combinations a real cycle would
 * never produce — because Property 15 asserts the derivation is *total*.
 */
export const arbSyncStateInput: fc.Arbitrary<SyncStateInputLike> = fc.record({
  hasSession: fc.boolean(),
  pro: fc.boolean(),
  enabled: fc.boolean(),
  cycleInProgress: fc.boolean(),
  lastCycleFailed: fc.boolean(),
  failureKind: fc.oneof(
    { arbitrary: fc.constantFrom("offline" as const, "service" as const), weight: 3 },
    { arbitrary: fc.constant(null), weight: 1 },
  ),
  succeededSinceFailure: fc.boolean(),
  outboxCount: fc.oneof(
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.integer({ min: 1, max: 5_000 }), weight: 3 },
  ),
  lastSyncAt: fc.oneof(
    { arbitrary: fc.constant(null), weight: 1 },
    { arbitrary: arbEpochMs, weight: 3 },
  ),
  skipped: fc.oneof(
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.integer({ min: 1, max: 500 }), weight: 1 },
  ),
  restoreMerged: fc.oneof(
    { arbitrary: fc.constant(null), weight: 2 },
    { arbitrary: fc.integer({ min: 0, max: 100_000 }), weight: 1 },
  ),
  daysUntilPurge: fc.oneof(
    { arbitrary: fc.constant(null), weight: 2 },
    { arbitrary: fc.integer({ min: 0, max: 90 }), weight: 1 },
  ),
});

// ---------------------------------------------------------------------------
// Trigger schedules (Property 18: at most one cycle, at most one queued rerun)
// ---------------------------------------------------------------------------

/** Mirrors `TriggerReason` from design.md; task 14.6 owns the real type. */
export type TriggerReasonLike =
  | "local-write"
  | "cold-launch"
  | "manual"
  | "reconnect"
  | "foreground"
  | "auto-retry";

export const TRIGGER_REASONS: readonly TriggerReasonLike[] = [
  "local-write",
  "cold-launch",
  "manual",
  "reconnect",
  "foreground",
  "auto-retry",
];

/** One step against a controllable fake cycle body. */
export type ScheduleStep =
  /** Call `requestSync(reason)`. */
  | { kind: "trigger"; reason: TriggerReasonLike }
  /** Let the in-flight fake cycle finish with this outcome. */
  | { kind: "finishCycle"; outcome: "success" | "failure" }
  /** Advance the fake clock. */
  | { kind: "advance"; ms: number }
  /** Flush pending microtasks without advancing the clock. */
  | { kind: "settle" };

export interface TriggerSchedule {
  steps: ScheduleStep[];
}

const arbScheduleStep: fc.Arbitrary<ScheduleStep> = fc.oneof(
  {
    arbitrary: fc
      .constantFrom(...TRIGGER_REASONS)
      .map((reason): ScheduleStep => ({ kind: "trigger", reason })),
    weight: 4,
  },
  {
    arbitrary: fc
      .constantFrom("success" as const, "failure" as const)
      .map((outcome): ScheduleStep => ({ kind: "finishCycle", outcome })),
    weight: 3,
  },
  {
    arbitrary: fc
      .constantFrom(0, 1, 1_000, 30_000, 60_000, 60_001, 300_000)
      .map((ms): ScheduleStep => ({ kind: "advance", ms })),
    weight: 2,
  },
  { arbitrary: fc.constant<ScheduleStep>({ kind: "settle" }), weight: 1 },
);

/** Trigger counts and interleavings, including bursts of the same reason. */
export const arbTriggerSchedule: fc.Arbitrary<TriggerSchedule> = fc
  .array(arbScheduleStep, { minLength: 1, maxLength: 24 })
  .map((steps) => ({ steps }));
