// SnapGut Cloud sync.
//
// The file is in two halves, and the boundary between them is the design
// (design.md, "Layering and testability"):
//
//   1. the **pure core** — the wire codec, the merge rule, push planning, outbox
//      reconciliation, Sync_State derivation, the cursor codec, and the retry
//      gate. No IndexedDB, no fetch, no clock: every one of them is a function
//      of its arguments, which is what makes them property-testable.
//   2. the **I/O shell**, below the `I/O shell` banner — the authenticated
//      transport, the Sync_State store and its pub/sub, and (in later tasks) the
//      push and pull phases, the trigger scheduler, and the one-shot operations.
//
// Nothing in the core imports anything from the shell, so the split is visible
// from the import list at the top of the file as well as from the banner.

// ---- pure core dependencies (types, plus the one type guard) --------------
import {
  isTombstone,
  type BowelEvent,
  type CheckinEvent,
  type Confidence,
  type Ingredient,
  type LoggedSymptom,
  type LogEvent,
  type MealEvent,
  type SleepQuality,
  type StoredRecord,
  type StressLevel,
  type SymptomEvent,
  type Tombstone,
} from "./db";
import type { Severity } from "./symptoms";

// ---- I/O shell dependencies ----------------------------------------------
import {
  clearOutbox,
  enqueueIds,
  getAllRecords,
  getMeta,
  getOutboxBatch,
  getOutboxCount,
  getRecord,
  mergePulledPage,
  removeOutboxIds,
  setMeta,
  type MergePageResult,
} from "./db";
import { fetchWithTimeout } from "./httpTimeout";
import { clearToken, getToken } from "./session";
import { createSingleFlight } from "./singleFlight";
import {
  applyEntitlement,
  getSnapshot as getSyncSettingsSnapshot,
  isDestinationEnabled,
  isProEntitled,
  recordSyncOutcome,
  setDestinationEnabled,
  subscribe as subscribeToSyncSettings,
} from "./syncSettings";

// ---------------------------------------------------------------------------
// Wire format (Req 16.3, 20)
// ---------------------------------------------------------------------------

/** Every Event_Record this client pushes carries `schemaVersion: 2` (Req 16.3). */
export const SCHEMA_VERSION = 2;

/** Per-record serialized ceiling the Sync_Service enforces (Req 19.3). */
export const MAX_RECORD_BYTES = 16_384;

/**
 * A Log_Event or Tombstone as it travels over the wire.
 *
 * Optional keys are *absent* rather than `undefined` whenever the source field
 * is unset, so absence and emptiness stay distinguishable across a round trip
 * (Req 20.6). Fields from a newer `schemaVersion` ride along at the top level
 * and are matched by the index signature (Req 16.4, 16.9).
 */
export interface EventRecord {
  id: string;
  type: LogEvent["type"];
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  deleted?: true;
  note?: string;
  dish?: string;
  ingredients?: Ingredient[];
  /** "This meal sat fine", stated by the user. See MealEvent.outcome. */
  outcome?: "fine";
  symptoms?: LoggedSymptom[];
  bristol?: number;
  stress?: StressLevel;
  sleep?: SleepQuality;
  /** Preserved verbatim from a newer schemaVersion (Req 16.4, 16.9). */
  [unknownField: string]: unknown;
}

const EVENT_TYPES: readonly LogEvent["type"][] = ["meal", "symptom", "bowel", "checkin"];
const CONFIDENCE_VALUES: readonly Confidence[] = ["confident", "maybe"];
const SEVERITY_VALUES: readonly Severity[] = ["mild", "moderate", "severe"];
const STRESS_VALUES: readonly StressLevel[] = ["low", "medium", "high"];
const SLEEP_VALUES: readonly SleepQuality[] = ["poor", "ok", "good"];

/**
 * Keys the codec understands. Anything else on a pulled record is preserved as
 * an unknown field; anything here is never preserved, so a key this version
 * recognizes can't come back as a duplicate under another name — and a
 * type-irrelevant known key (a `bristol` on a `meal`, say) is dropped rather
 * than smuggled back on the next push.
 */
const KNOWN_WIRE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "createdAt",
  "updatedAt",
  "schemaVersion",
  "deleted",
  "note",
  "dish",
  "ingredients",
  "outcome",
  "symptoms",
  "bristol",
  "stress",
  "sleep",
  // Never on the wire, and never resurrected from it (Req 16.1, 20.2).
  "photo",
  // The local container itself is never a wire key.
  "unknownFields",
]);

// ---------------------------------------------------------------------------
// Photo exclusion (Req 16.1, 16.2, 20.2)
// ---------------------------------------------------------------------------

/** Base64 alphabet plus the line breaks a wrapped payload carries. */
const BASE64_ONLY = /^[A-Za-z0-9+/=\r\n]+$/;
const MAX_BASE64_FREE_LENGTH = 4_096;

/**
 * The Requirement 16.2 shape of Photo data in a string: a data URL, or a long
 * run of nothing but base64 characters. The Sync_Service rejects a push
 * carrying either, so the codec drops them before they can leave.
 */
function looksLikePhotoData(value: string): boolean {
  if (value.startsWith("data:")) return true;
  return value.length > MAX_BASE64_FREE_LENGTH && BASE64_ONLY.test(value);
}

/** How deep an unknown-field value may nest before it is dropped. */
const MAX_UNKNOWN_DEPTH = 8;

type Cleaned = { ok: true; value: unknown } | { ok: false };
const DROP: Cleaned = { ok: false };

/**
 * Deep-copy a preserved unknown value, keeping only JSON-safe, photo-free
 * content. An allowlist rather than a denylist: a `Blob`, a typed array, a
 * `Date`, a function, a cyclic structure, or a data URL nested anywhere inside
 * drops the whole key. That is what makes "no Photo bytes reach the wire"
 * (Req 16.1, 20.2) structural rather than a promise about the fields we happen
 * to know about.
 *
 * Copying matters as much as filtering: a pulled record's own objects must
 * never end up aliased into the Local_Store.
 */
function cleanUnknownValue(value: unknown, depth: number): Cleaned {
  if (depth > MAX_UNKNOWN_DEPTH) return DROP;
  if (value === null) return { ok: true, value: null };

  switch (typeof value) {
    case "string":
      return looksLikePhotoData(value) ? DROP : { ok: true, value };
    case "number":
      // NaN and ±Infinity are not JSON round-trippable.
      return Number.isFinite(value) ? { ok: true, value } : DROP;
    case "boolean":
      return { ok: true, value };
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint
      return DROP;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const cleaned = cleanUnknownValue(item, depth + 1);
      // Dropping one element would shift the rest, so the key goes instead.
      if (!cleaned.ok) return DROP;
      out.push(cleaned.value);
    }
    return { ok: true, value: out };
  }

  if (!isPlainObject(value)) return DROP;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "photo") return DROP;
    const cleaned = cleanUnknownValue(nested, depth + 1);
    if (!cleaned.ok) return DROP;
    out[key] = cleaned.value;
  }
  return { ok: true, value: out };
}

/** A `{}` literal — not a Blob, Date, Map, or class instance. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  if (proto === null || proto === Object.prototype) return true;
  // A plain object from another realm has a different Object.prototype.
  return proto.constructor?.name === "Object";
}

/**
 * The preserved unknown fields, cleaned and ready to spread onto the wire or to
 * store. Known keys are filtered out so a preserved field can never shadow one
 * this version understands.
 */
function cleanUnknownFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (KNOWN_WIRE_KEYS.has(key)) continue;
    const cleaned = cleanUnknownValue(value, 0);
    if (cleaned.ok) out[key] = cleaned.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialization: StoredRecord → EventRecord
// ---------------------------------------------------------------------------

function copyIngredient(i: Ingredient): Ingredient {
  // Field-by-field, so nothing else riding on the object reaches the wire.
  return { name: i.name, confidence: i.confidence };
}

function copySymptom(s: LoggedSymptom): LoggedSymptom {
  return { id: s.id, severity: s.severity };
}

/**
 * Serialize a Log_Event or Tombstone for a push.
 *
 * Three rules drive the shape:
 *
 * - **No Photo, ever** (Req 16.1, 20.2). `photo` is never read, every field is
 *   copied by name, and preserved unknown fields go through
 *   `cleanUnknownValue`, so no `Blob` and no `data:` string can appear.
 * - **Absence ≠ emptiness** (Req 20.6). A key is omitted when its source field
 *   is `undefined`; a field that is present but empty is emitted as its empty
 *   value (`""`, `[]`).
 * - **Preserved fields verbatim** (Req 16.4, 16.9). Unknown fields are spread
 *   first so a known field always wins a name collision.
 *
 * A Tombstone carries identity, revision, and its preserved fields only — no
 * content field of any kind (Req 9.1, 20.8).
 */
export function toEventRecord(r: StoredRecord): EventRecord {
  return buildEventRecord(r, false);
}

function buildEventRecord(r: StoredRecord, dropUnknown: boolean): EventRecord {
  const out: Record<string, unknown> = dropUnknown ? {} : cleanUnknownFields(r.unknownFields);

  out.id = r.id;
  out.type = r.type;
  out.createdAt = r.createdAt;
  out.updatedAt = r.updatedAt;
  out.schemaVersion = SCHEMA_VERSION;

  if (isTombstone(r)) {
    out.deleted = true;
    return out as EventRecord;
  }

  if (r.note !== undefined) out.note = r.note;

  switch (r.type) {
    case "meal":
      out.dish = r.dish;
      out.ingredients = r.ingredients.map(copyIngredient);
      // Omitted when unset, so "not stated" stays distinguishable from "fine" on the
      // wire as well as locally.
      if (r.outcome !== undefined) out.outcome = r.outcome;
      break;
    case "symptom":
      out.symptoms = r.symptoms.map(copySymptom);
      break;
    case "bowel":
      out.bristol = r.bristol;
      if (r.symptoms !== undefined) out.symptoms = r.symptoms.map(copySymptom);
      break;
    case "checkin":
      if (r.stress !== undefined) out.stress = r.stress;
      if (r.sleep !== undefined) out.sleep = r.sleep;
      break;
  }

  return out as EventRecord;
}

let encoder: TextEncoder | null = null;

/** Serialized size in bytes — what the 16 KiB limit is measured against. */
function serializedBytes(record: EventRecord): number {
  encoder ??= new TextEncoder();
  return encoder.encode(JSON.stringify(record)).length;
}

/**
 * Serialize for a push, reporting the size and whether preserved unknown fields
 * had to be left out.
 *
 * Requirement 16.8: when the preserved fields are what carries the record past
 * 16,384 bytes, the record is pushed without them — for that push only. The
 * Local_Store copy keeps them, so a later push of a smaller revision sends them
 * again. Dropping them is pointless when the record is over the limit either
 * way, so in that case the full record is returned as-is and the Sync_Service's
 * `record_too_large` rejection settles it.
 */
export function serializeForPush(r: StoredRecord): {
  record: EventRecord;
  bytes: number;
  omittedUnknown: boolean;
} {
  const record = toEventRecord(r);
  const bytes = serializedBytes(record);
  if (bytes <= MAX_RECORD_BYTES) return { record, bytes, omittedUnknown: false };

  const lean = buildEventRecord(r, true);
  const leanBytes = serializedBytes(lean);
  if (leanBytes < bytes && leanBytes <= MAX_RECORD_BYTES) {
    return { record: lean, bytes: leanBytes, omittedUnknown: true };
  }
  return { record, bytes, omittedUnknown: false };
}

// ---------------------------------------------------------------------------
// Deserialization: unknown → StoredRecord | null
// ---------------------------------------------------------------------------

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isEventType(value: unknown): value is LogEvent["type"] {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

function isConfidence(value: unknown): value is Confidence {
  return typeof value === "string" && (CONFIDENCE_VALUES as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITY_VALUES as readonly string[]).includes(value);
}

function isStress(value: unknown): value is StressLevel {
  return typeof value === "string" && (STRESS_VALUES as readonly string[]).includes(value);
}

function isSleep(value: unknown): value is SleepQuality {
  return typeof value === "string" && (SLEEP_VALUES as readonly string[]).includes(value);
}

/** `null` means "this value cannot be converted" — the caller skips the record. */
function parseIngredients(value: unknown): Ingredient[] | null {
  if (!Array.isArray(value)) return null;
  const out: Ingredient[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { name, confidence } = item as Record<string, unknown>;
    if (typeof name !== "string" || !isConfidence(confidence)) return null;
    out.push({ name, confidence });
  }
  return out;
}

function parseSymptoms(value: unknown): LoggedSymptom[] | null {
  if (!Array.isArray(value)) return null;
  const out: LoggedSymptom[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { id, severity } = item as Record<string, unknown>;
    // Symptom ids are not checked against the registry: an id from a newer
    // version is data to carry, not a reason to skip the record.
    if (typeof id !== "string" || !isSeverity(severity)) return null;
    out.push({ id, severity });
  }
  return out;
}

/**
 * The type-specific half of a record. `bristol` is optional here because a
 * bowel Tombstone carries no content; the event path requires it below.
 */
type WireContent =
  | { type: "meal"; dish: string; ingredients: Ingredient[]; outcome?: "fine" }
  | { type: "symptom"; symptoms: LoggedSymptom[] }
  | { type: "bowel"; bristol?: number; symptoms?: LoggedSymptom[] }
  | { type: "checkin"; stress?: StressLevel; sleep?: SleepQuality };

/**
 * Validate and convert the fields belonging to the declared `type`. A missing
 * recognized field reads as unset (Req 16.7: a record from an older
 * `schemaVersion` is merged, not skipped); a *present* field outside its domain
 * skips the record (Req 20.4).
 */
function parseContent(
  type: LogEvent["type"],
  src: Record<string, unknown>,
): WireContent | null {
  switch (type) {
    case "meal": {
      if (src.dish !== undefined && typeof src.dish !== "string") return null;
      let ingredients: Ingredient[] = [];
      if (src.ingredients !== undefined) {
        const parsed = parseIngredients(src.ingredients);
        if (parsed === null) return null;
        ingredients = parsed;
      }
      const content: WireContent = {
        type,
        dish: src.dish === undefined ? "" : (src.dish as string),
        ingredients,
      };
      // "fine" is the only value; anything else is outside the domain and skips the
      // record (Req 20.4) rather than being coerced into a claim the user never made.
      if (src.outcome !== undefined) {
        if (src.outcome !== "fine") return null;
        content.outcome = "fine";
      }
      return content;
    }
    case "symptom": {
      let symptoms: LoggedSymptom[] = [];
      if (src.symptoms !== undefined) {
        const parsed = parseSymptoms(src.symptoms);
        if (parsed === null) return null;
        symptoms = parsed;
      }
      return { type, symptoms };
    }
    case "bowel": {
      const content: { type: "bowel"; bristol?: number; symptoms?: LoggedSymptom[] } = { type };
      if (src.bristol !== undefined) {
        const bristol = asInteger(src.bristol);
        if (bristol === null || bristol < 1 || bristol > 7) return null;
        content.bristol = bristol;
      }
      if (src.symptoms !== undefined) {
        const parsed = parseSymptoms(src.symptoms);
        if (parsed === null) return null;
        content.symptoms = parsed;
      }
      return content;
    }
    case "checkin": {
      const content: { type: "checkin"; stress?: StressLevel; sleep?: SleepQuality } = { type };
      if (src.stress !== undefined) {
        if (!isStress(src.stress)) return null;
        content.stress = src.stress;
      }
      if (src.sleep !== undefined) {
        if (!isSleep(src.sleep)) return null;
        content.sleep = src.sleep;
      }
      return content;
    }
  }
}

/**
 * Deserialize a pulled Event_Record, or return `null` when it must be skipped.
 *
 * Never throws: a malformed record is a skipped record, not a failed
 * Sync_Cycle (Req 20.3, 20.4). A record is skipped when it is not an object, is
 * missing `id`, `createdAt`, or `updatedAt`, carries a `type` outside
 * `meal | symptom | bowel | checkin`, or holds any recognized field whose value
 * sits outside its domain — an unrecognized `confidence`, `severity`, `stress`,
 * or `sleep`, a `bristol` that is not an integer from 1 to 7, a non-string
 * `note`, or a `deleted` flag that is present but not `true`.
 *
 * Domain checks run before the tombstone branch, so a Tombstone whose payload
 * is out of domain is skipped like any other bad record; content is then
 * discarded, leaving identity, revision, and preserved fields (Req 20.8).
 *
 * A `schemaVersion` above 2 is not a reason to skip: the recognized fields are
 * converted and the rest are kept in `unknownFields` for later pushes
 * (Req 16.4, 16.9). Note that an *empty* set of preserved fields round-trips as
 * absent — the wire carries preserved fields inline and has no container key,
 * so "no preserved fields" has exactly one representation.
 */
export function fromEventRecord(raw: unknown): StoredRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;

  const id = typeof src.id === "string" && src.id.length > 0 ? src.id : null;
  if (id === null) return null;

  const createdAt = asInteger(src.createdAt);
  const updatedAt = asInteger(src.updatedAt);
  if (createdAt === null || updatedAt === null) return null;

  if (!isEventType(src.type)) return null;
  const type = src.type;

  const deleted = src.deleted;
  if (deleted !== undefined && deleted !== true) return null;

  if (src.note !== undefined && typeof src.note !== "string") return null;
  const note = src.note as string | undefined;

  const content = parseContent(type, src);
  if (content === null) return null;

  const preserved = cleanUnknownFields(collectUnknownFields(src));
  const carried = Object.keys(preserved).length > 0 ? { unknownFields: preserved } : {};

  if (deleted === true) {
    const tombstone: Tombstone = { id, type, createdAt, updatedAt, deleted: true, ...carried };
    return tombstone;
  }

  const base = { id, createdAt, updatedAt, ...(note !== undefined ? { note } : {}), ...carried };

  switch (content.type) {
    case "meal": {
      const meal: MealEvent = {
        ...base,
        type: "meal",
        dish: content.dish,
        ingredients: content.ingredients,
        ...(content.outcome !== undefined ? { outcome: content.outcome } : {}),
      };
      return meal;
    }
    case "symptom": {
      const symptom: SymptomEvent = { ...base, type: "symptom", symptoms: content.symptoms };
      return symptom;
    }
    case "bowel": {
      // A bowel event needs a Bristol score; a value outside 1–7 — including
      // none at all — is out of domain (Req 20.4).
      if (content.bristol === undefined) return null;
      const bowel: BowelEvent = {
        ...base,
        type: "bowel",
        bristol: content.bristol,
        ...(content.symptoms !== undefined ? { symptoms: content.symptoms } : {}),
      };
      return bowel;
    }
    case "checkin": {
      const checkin: CheckinEvent = {
        ...base,
        type: "checkin",
        ...(content.stress !== undefined ? { stress: content.stress } : {}),
        ...(content.sleep !== undefined ? { sleep: content.sleep } : {}),
      };
      return checkin;
    }
  }
}

/** Every key on a wire record this version does not recognize. */
function collectUnknownFields(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (KNOWN_WIRE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge rule (Req 8)
//
// One rule, four keys, evaluated in order:
//
//   1. greater `updatedAt`, compared as integer epoch milliseconds (Req 8.1)
//   2. on a tie, the Tombstone (Req 8.2)
//   3. then greater `createdAt` (Req 8.3)
//   4. then the record ordered last by `canonicalKey` (Req 8.3)
//
// What the rule deliberately does *not* look at: which side holds a record, the
// order records arrived in, Server_Sequence, and Photos (Req 8.3, 8.7). Because
// the four keys are a lexicographic composition of total orders over field
// values alone, the rule is total, deterministic, idempotent, commutative, and
// associative (Req 8.5, 8.6) — the properties tasks 7.2 and 7.3 assert.
//
// `server/eventStore.js` mirrors this rule in JavaScript (task 10.1). The mirror
// is a direct transcription: a server-stored record is already a wire record
// with its unknown fields inline, so its `canonicalKey` is
// `canonicalStringify(record)` over the same excluded keys, and its
// `compareForMerge` / `mergeRecords` are these functions verbatim.
// ---------------------------------------------------------------------------

/**
 * Keys left out of `canonicalKey`.
 *
 * - `photo` — a Photo is never a factor in the merge (Req 8.7), and Photo bytes
 *   are not part of the shared wire shape the ordering has to agree on.
 * - `schemaVersion` — a wire-envelope field, not event data; excluding it lets
 *   the client and the Sync_Service derive the same key for the same record even
 *   when one of them re-stamps the envelope.
 * - `unknownFields` — the local *container* is not itself a field; its contents
 *   are folded in inline, which is how they travel on the wire (Req 16.4).
 */
const CANONICAL_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "photo",
  "schemaVersion",
  "unknownFields",
]);

/** Defensive nesting ceiling so a pathological value can never hang a merge. */
const MAX_CANONICAL_DEPTH = 16;

/**
 * JSON with object keys sorted, so the string depends on field *values* only and
 * never on insertion order. Arrays keep their order — element order is data
 * (Req 20.1). Anything JSON cannot express (`undefined`, a function, a Blob's
 * bytes) collapses to `null` or `{}` rather than throwing, which keeps the
 * ordering total over every input (Req 8.5).
 */
function canonicalStringify(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (depth >= MAX_CANONICAL_DEPTH) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item, depth + 1)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalStringify(obj[key], depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * The single total ordering of Event_Record field values that Requirement 8.3
 * uses to break a `updatedAt` + tombstone + `createdAt` tie: stable, key-sorted
 * JSON of every field except Photo data.
 *
 * Preserved unknown fields are folded in at the top level, where the wire
 * carries them, so a record that round-tripped through the Sync_Service orders
 * the same as the local original. A top-level field always wins a name
 * collision with a preserved one, matching `toEventRecord`.
 */
export function canonicalKey(r: StoredRecord): string {
  const src = r as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  const unknown = src.unknownFields;
  if (typeof unknown === "object" && unknown !== null && !Array.isArray(unknown)) {
    for (const [key, value] of Object.entries(unknown as Record<string, unknown>)) {
      if (CANONICAL_EXCLUDED_KEYS.has(key)) continue;
      fields[key] = value;
    }
  }
  for (const [key, value] of Object.entries(src)) {
    if (CANONICAL_EXCLUDED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    fields[key] = value;
  }

  return canonicalStringify(fields);
}

/**
 * Requirement 8.1 compares Revision_Times "as integer epoch milliseconds". A
 * value that is not an integer cannot participate in that comparison, so it is
 * read as 0 here and the ordering falls through to the later keys — which still
 * see the real value through `canonicalKey`. That keeps the ordering total and
 * commutative even for a record no validated path could produce (Req 8.5).
 */
function asOrderedInt(value: number): number {
  return Number.isInteger(value) ? value : 0;
}

/**
 * `-1` when `a` loses, `1` when `a` wins, `0` when the two records are equal in
 * every field the ordering can see.
 *
 * A `0` result means the two records carry the same `updatedAt`, the same
 * deleted flag, the same `createdAt`, and the same `canonicalKey` — so they
 * agree on every field except Photo data, which the merge must not consider
 * (Req 8.7).
 */
export function compareForMerge(a: StoredRecord, b: StoredRecord): -1 | 0 | 1 {
  const au = asOrderedInt(a.updatedAt);
  const bu = asOrderedInt(b.updatedAt);
  if (au !== bu) return au > bu ? 1 : -1; // Req 8.1

  const aDeleted = isTombstone(a);
  const bDeleted = isTombstone(b);
  if (aDeleted !== bDeleted) return aDeleted ? 1 : -1; // Req 8.2

  const ac = asOrderedInt(a.createdAt);
  const bc = asOrderedInt(b.createdAt);
  if (ac !== bc) return ac > bc ? 1 : -1; // Req 8.3

  const ak = canonicalKey(a);
  const bk = canonicalKey(b);
  if (ak === bk) return 0;
  return ak > bk ? 1 : -1; // Req 8.3 — the record ordered last is retained
}

/**
 * Merge the two sides holding an `id`, returning the record to retain.
 *
 * `null` means "no entry on this side" — not a record with a zero
 * Revision_Time and not a deletion. The present record is returned unchanged,
 * including when it is a Tombstone (Req 8.4), and two absent sides stay absent.
 *
 * The winner is returned by reference, never a copy, so "every field unchanged"
 * covers the Photo the Local_Store already holds; whether that Photo survives is
 * decided by the pull phase (Req 7.7, 9.3), not here.
 *
 * On a `0` comparison the two records agree on every field the ordering can see,
 * so `a` is returned: that makes `mergeRecords(x, x)` return `x` itself and
 * keeps the result a function of field values rather than of Photo bytes.
 */
export function mergeRecords(
  a: StoredRecord | null,
  b: StoredRecord | null,
): StoredRecord | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareForMerge(a, b) >= 0 ? a : b;
}

// ---------------------------------------------------------------------------
// Push planning (Req 6.1, 6.2, 16.8, 19.1, 19.2)
//
// `planPush` is the whole of the push phase's decision-making: given the outbox
// ids and a way to look each one up, it says exactly which records go out, in
// which requests, which ids leave the outbox unsent, and which wait for the next
// Sync_Cycle. Nothing here reads the clock, the network, or IndexedDB.
//
// The partition is total by construction: every distinct id the caller passes in
// lands in exactly one of `batches`, `drop`, and `defer` (design.md, Property 11).
// A duplicate id in the input is collapsed on first sight — the Local_Store holds
// at most one entry per id (Req 4.6), so pushing it twice in one cycle could only
// produce a second Server_Sequence for the same content.
// ---------------------------------------------------------------------------

/** Per-request Event_Record ceiling the Sync_Service enforces (Req 19.2). */
export const MAX_RECORDS_PER_REQUEST = 200;

/** Per-request byte ceiling the Sync_Service enforces (Req 19.1). */
export const MAX_REQUEST_BYTES = 1_048_576;

/** Push requests one Sync_Cycle may issue; the rest is deferred (Req 6.2). */
export const MAX_REQUESTS_PER_CYCLE = 20;

/** Pull page size the Sync_Service serves (Req 7.2). */
export const PULL_PAGE_SIZE = 500;

/**
 * Bytes held back from `MAX_REQUEST_BYTES` for the request envelope around the
 * record array — the wrapper object's keys, braces, and room for a field a later
 * protocol revision adds. Requirement 19.1 measures the whole body, so the plan
 * budgets for the body rather than for the array alone.
 */
const PUSH_ENVELOPE_BYTES = 128;

/** What one batch's records may serialize to, envelope excluded. */
const BATCH_BYTE_BUDGET = MAX_REQUEST_BYTES - PUSH_ENVELOPE_BYTES;

export interface PushPlan {
  /** ≤20 batches, each ≤200 records and ≤1 MiB serialized (Req 6.2, 19.1, 19.2). */
  batches: EventRecord[][];
  /** Outbox ids with no matching Log_Event or Tombstone (Req 6.1). */
  drop: string[];
  /** Ids beyond the 20-request ceiling, kept for a later cycle (Req 6.2). */
  defer: string[];
  /** Ids pushed without their preserved unknown fields (Req 16.8). */
  omittedUnknown: string[];
}

type PushCandidate = { id: string; record: StoredRecord; order: number };

/**
 * Plan the push phase of one Sync_Cycle.
 *
 * `lookup` maps an outbox id to the record the Local_Store holds for it, or
 * `null` when the Local_Store holds neither a Log_Event nor a Tombstone for that
 * id. Those ids go to `drop`: Requirement 6.1 removes them from the Outbox
 * without sending anything and without failing the cycle. They are collected for
 * every id, including ids past the request ceiling, since a missing record is
 * settled whether or not this cycle would have reached it.
 *
 * Everything else is ordered by ascending Revision_Time with ties broken by
 * ascending `id` (Req 6.1) and then packed in that order into requests of at
 * most 200 records and at most the Requirement 19.1 byte limit (Req 6.2). Once
 * 20 requests are full, every remaining id goes to `defer` and stays in the
 * Outbox for the next Sync_Cycle.
 *
 * A record whose own serialized size passes the request budget is sent alone
 * rather than deferred. It is necessarily past the 16,384-byte per-record limit
 * too, so the Sync_Service answers `record_too_large` and Requirement 19.9 takes
 * it out of the Outbox — which is forward progress, where deferring it would
 * park the same record at the head of every future cycle.
 */
export function planPush(
  outboxIds: string[],
  lookup: (id: string) => StoredRecord | null,
): PushPlan {
  const batches: EventRecord[][] = [];
  const drop: string[] = [];
  const defer: string[] = [];
  const omittedUnknown: string[] = [];

  const candidates: PushCandidate[] = [];
  const seen = new Set<string>();

  for (const id of outboxIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = lookup(id);
    // Any nullish answer reads as "no matching entry", so a lookup that returns
    // `undefined` for a miss is handled the same as one returning `null`.
    if (record === null || record === undefined) {
      drop.push(id);
      continue;
    }
    candidates.push({ id, record, order: asOrderedInt(record.updatedAt) });
  }

  candidates.sort(compareCandidates);

  let current: EventRecord[] = [];
  let usedBytes = 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const serialized = serializeForPush(candidate.record);
    // One byte for the comma this record needs once it is not the first.
    const cost = serialized.bytes + (current.length > 0 ? 1 : 0);

    const countFull = current.length >= MAX_RECORDS_PER_REQUEST;
    const bytesFull = usedBytes + cost > BATCH_BYTE_BUDGET;

    if (current.length > 0 && (countFull || bytesFull)) {
      batches.push(current);
      current = [];
      usedBytes = 0;
      if (batches.length >= MAX_REQUESTS_PER_CYCLE) {
        for (let j = i; j < candidates.length; j++) defer.push(candidates[j].id);
        break;
      }
    }

    usedBytes += serialized.bytes + (current.length > 0 ? 1 : 0);
    current.push(serialized.record);
    // Recorded only for records this cycle actually sends (Req 16.8).
    if (serialized.omittedUnknown) omittedUnknown.push(candidate.id);
  }

  if (current.length > 0) batches.push(current);

  return { batches, drop, defer, omittedUnknown };
}

/** Ascending Revision_Time, then ascending `id` (Req 6.1). */
function compareCandidates(a: PushCandidate, b: PushCandidate): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
// ---------------------------------------------------------------------------
// Outbox reconciliation (Req 6.6, 6.7, 19.9, 19.11)
//
// The Outbox is the client's durable "not yet known to be in the cloud" list
// (Req 6.8: it has no time-based expiry). An id therefore leaves it only when
// keeping it could serve no purpose: either the Sync_Service stored the record,
// or the rejection is a permanent property of the record itself, so re-sending
// the same bytes on the next Sync_Cycle would be rejected identically.
//
// Everything else stays queued. A capacity or request-shape rejection says
// nothing about the record: the per-user cap can be raised or freed (Req 19.11),
// and a `record_limit` or `payload_too_large` answer is about how this cycle
// packed the request, which the next `planPush` can pack differently.
// ---------------------------------------------------------------------------

/** Exactly one outcome per pushed `id` (Req 6.11). */
export type PushOutcome =
  | { id: string; outcome: "stored" }
  | { id: string; outcome: "rejected"; reason: RejectReason };

export type RejectReason =
  | "photo_field"
  | "record_too_large"
  | "record_limit"
  | "payload_too_large"
  | "record_cap"
  | "invalid_record";

/**
 * Rejection reasons that are a permanent property of the record. Re-sending the
 * same record can only earn the same answer, so Requirement 19.9 takes the id
 * out of the Outbox while leaving the Log_Event in the Local_Store untouched.
 *
 * The three capacity- and request-shaped reasons are deliberately absent:
 * `record_cap` must stay queued so the records land once the cap clears
 * (Req 19.11), and `record_limit` / `payload_too_large` are properties of the
 * request this cycle built, not of the record.
 */
const PERMANENT_REJECT_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  "photo_field",
  "record_too_large",
  "invalid_record",
]);

/** True when this outcome settles the id, so it can leave the Outbox. */
function settlesOutboxEntry(outcome: PushOutcome): boolean {
  if (outcome.outcome === "stored") return true; // Req 6.6
  // An unrecognized reason from a newer Sync_Service reads as unsettled: the
  // id stays queued, which costs a retry rather than a Log_Event.
  return PERMANENT_REJECT_REASONS.has(outcome.reason); // Req 19.9
}

/**
 * Decide which Outbox ids one push response settles.
 *
 * `remove` and `keep` partition the distinct ids in `sentIds` — every sent id
 * appears in exactly one of them, in first-sent order, and an id repeated in
 * `sentIds` appears once. An `outcomes` entry for an id that was not sent is
 * ignored entirely and appears in neither list, so a response cannot reach into
 * the Outbox for ids this request never carried.
 *
 * Two totality choices the wire contract makes unreachable but which this
 * function still has to answer:
 *
 * - **A sent id with no outcome** is kept. Requirement 6.11 has the Sync_Service
 *   report one outcome per id sent, so a missing one means a truncated or
 *   unexpected response — evidence of nothing, and certainly not of a store.
 * - **Conflicting outcomes for one id** keep the id. Removal has to be justified
 *   by every outcome reported for that id, because retaining an id costs one
 *   redundant re-push (Req 6.5 makes push idempotent) whereas removing it on a
 *   contradictory report would drop a local change that never reached the cloud.
 */
export function reconcileOutbox(
  sentIds: string[],
  outcomes: PushOutcome[],
): { remove: string[]; keep: string[] } {
  const sent = new Set(sentIds);

  // Per sent id: settled only while every outcome seen for it settles it.
  const settled = new Map<string, boolean>();
  for (const outcome of outcomes) {
    if (!sent.has(outcome.id)) continue; // never return an unsent id
    const soFar = settled.get(outcome.id);
    const now = settlesOutboxEntry(outcome);
    settled.set(outcome.id, soFar === undefined ? now : soFar && now);
  }

  const remove: string[] = [];
  const keep: string[] = [];
  const emitted = new Set<string>();

  for (const id of sentIds) {
    if (emitted.has(id)) continue;
    emitted.add(id);
    if (settled.get(id) === true) remove.push(id);
    else keep.push(id);
  }

  return { remove, keep };
}

// ---------------------------------------------------------------------------
// Sync_State derivation (Req 12)
//
// Sync_State is never maintained by transitions. It is *derived* from a snapshot
// of the conditions Requirement 12.8 names, by walking that requirement's
// ordered precedence table and returning on the first condition that matches.
// Because the walk is a total function of the snapshot, no combination of inputs
// can produce two states or none (design.md, "Sync_State machine"), and the
// state diagram's transitions are consequences of the inputs changing rather
// than events this module has to fire.
//
// Two orderings in the table do real work:
//
// - `blocked_no_pro` sits at step 2, above `syncing` and `error`, so a Pro lapse
//   during an in-flight or failed Sync_Cycle reads as paused rather than broken
//   (Req 12.6, 13.11).
// - `synced` at step 7 requires an empty Outbox, which is what makes the
//   `synced → idle` move on the first new local write fall out of derivation
//   instead of needing its own event (Req 12.9).
// ---------------------------------------------------------------------------

/**
 * The user-visible state of the Cloud_Destination, with the payload each state's
 * status line needs (Req 12.1–12.7).
 *
 * `synced` is the one state whose `lastSyncAt` is non-nullable: it is only
 * reachable once a Sync_Cycle has completed successfully (Req 12.4).
 */
export type SyncState =
  | { state: "off" }
  | { state: "idle"; lastSyncAt: number | null; pending: number }
  | { state: "syncing"; lastSyncAt: number | null; restore: { merged: number } | null }
  | { state: "synced"; lastSyncAt: number; skipped: number }
  | { state: "error"; lastSyncAt: number | null; kind: "offline" | "service"; message: string }
  | { state: "blocked_no_pro"; lastSyncAt: number | null; daysUntilPurge: number | null };

/**
 * The snapshot `deriveSyncState` reads. Every field is a condition Requirement
 * 12.8 evaluates or a value one of the six payloads carries; nothing here is
 * read from the clock, the network, or IndexedDB.
 *
 * - `hasSession` — a Session_Token is held on the device (Req 1.6).
 * - `pro` — the persisted Pro_Entitlement snapshot, which reads as false until a
 *   server response has ever supplied one (Req 1.9).
 * - `enabled` — the persisted enabled state of the Cloud_Destination, which
 *   reads as false when absent or unreadable (Req 3.6).
 * - `lastCycleFailed` / `succeededSinceFailure` — the most recent Sync_Cycle
 *   failed, and whether a later one has since succeeded (Req 12.5).
 * - `failureKind` — how that failure is attributed, for the Req 12.5 message.
 * - `outboxCount` — ids currently held in the Outbox (Req 12.2, 12.9).
 * - `lastSyncAt` — the persisted last-successful-Sync_Cycle timestamp, or `null`
 *   when no Sync_Cycle has ever completed successfully (Req 12.2, 12.4).
 * - `skipped` — records the last successful cycle skipped as malformed (Req 20.5).
 * - `restoreMerged` — records merged so far by an in-progress initial pull, or
 *   `null` when this cycle is not a restore (Req 10.2).
 * - `daysUntilPurge` — whole days until the Sync_Service purges the cloud copy
 *   after a Pro_Lapse, or `null` when there is no such deadline. Decision D1 is
 *   resolved as **retain indefinitely**, so the shell always passes `null`; the
 *   field stays in the record because the derivation must remain total over it.
 */
export interface SyncStateInput {
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
 * Requirement 12.5 asks the `error` message to distinguish a failure caused by
 * the device reporting no network connectivity from one reported by or
 * attributed to the Sync_Service, and to state that every Log_Event in the
 * Local_Store is unchanged. The status line adds the last-successful-Sync_Cycle
 * timestamp from `lastSyncAt`, so the message itself does not repeat it.
 */
const ERROR_MESSAGES: Record<"offline" | "service", string> = {
  offline: "Couldn't reach SnapGut Cloud — this device is offline. Your logs are safe on this device.",
  service: "SnapGut Cloud couldn't be updated. Your logs are safe on this device.",
};

/**
 * Derive the single Sync_State to display from a snapshot of the conditions.
 *
 * The body is Requirement 12.8's table in order, one `if` per step, so the
 * mapping is auditable against the requirement line by line. Two guarantees hold
 * for every possible input, not just the reachable ones:
 *
 * - `off` whenever no Session_Token is held, regardless of every other field
 *   (Req 1.6, 12.8 step 1). A signed-out device makes no requests, so neither a
 *   stale entitlement snapshot nor a cycle flag left set by a sign-out mid-cycle
 *   can show it as syncing, paused, or broken.
 * - never `synced` while the Outbox is non-empty (Req 12.8 step 7), which is
 *   also what produces the `synced → idle` transition of Req 12.9.
 *
 * A `lastCycleFailed` snapshot with no `failureKind` is attributed to the
 * Sync_Service: offline is the positively detected case (`navigator.onLine`), so
 * an unattributed failure is not one the device can claim was its own
 * connectivity.
 */
export function deriveSyncState(input: SyncStateInput): SyncState {
  const { lastSyncAt } = input;

  // 1. no Session_Token → off (Req 1.6)
  if (!input.hasSession) return { state: "off" };

  // 2. Pro false ∧ enabled → blocked_no_pro (Req 1.3, 12.6) — above syncing and
  //    error, so a lapse mid-cycle or after a failure reads as paused (13.11).
  if (!input.pro && input.enabled) {
    return { state: "blocked_no_pro", lastSyncAt, daysUntilPurge: input.daysUntilPurge };
  }

  // 3. Pro false ∧ not enabled → off (Req 1.4)
  // 4. not enabled → off (Req 12.1)
  //    Steps 3 and 4 differ only in the entitlement they were reached with, and
  //    both yield the same payload-free state, so one test covers them.
  if (!input.enabled) return { state: "off" };

  // 5. a Sync_Cycle is in progress → syncing (Req 12.3)
  if (input.cycleInProgress) {
    const merged = input.restoreMerged;
    return { state: "syncing", lastSyncAt, restore: merged === null ? null : { merged } };
  }

  // 6. most recent cycle failed with no success since → error (Req 12.5)
  if (input.lastCycleFailed && !input.succeededSinceFailure) {
    const kind = input.failureKind ?? "service";
    return { state: "error", lastSyncAt, kind, message: ERROR_MESSAGES[kind] };
  }

  // 7. a cycle has completed successfully ∧ Outbox empty → synced (Req 12.4)
  //    `lastSyncAt !== null` *is* "at least one Sync_Cycle has completed
  //    successfully": Req 12.4 persists that timestamp when one does, and it is
  //    also what narrows the payload's non-nullable `lastSyncAt`.
  if (lastSyncAt !== null && input.outboxCount === 0) {
    return { state: "synced", lastSyncAt, skipped: input.skipped };
  }

  // 8. otherwise → idle (Req 12.2, 12.9)
  return { state: "idle", lastSyncAt, pending: input.outboxCount };
}

// ---------------------------------------------------------------------------
// Sync_Cursor codec (design.md, "Cursor shape and invalidation")
//
// The Sync_Cursor is opaque to callers — it is stored and echoed back, never
// interpreted — but it is structured as `"{epoch}:{seq}"`. `epoch` is the purge
// generation counter the Sync_Service keeps beside `seq`: deleting the cloud
// copy (Req 17.4) or a retention purge (Req 13.8) bumps `epoch` and resets `seq`
// to 0, which is what lets the Sync_Service recognize a stale cursor and answer
// `cursor_invalid` instead of silently matching nothing (Req 13.13, 17.5).
//
// Both halves are total functions: `formatCursor` always returns a token
// `parseCursor` accepts, and `parseCursor` answers `null` — never throws — for
// an absent or malformed token, because a cursor read back from storage is
// untrusted input and "no usable cursor" is an ordinary state meaning "start
// from the beginning".
// ---------------------------------------------------------------------------

const CURSOR_SEPARATOR = ":";

/** `"{epoch}:{seq}"` — the only shape `parseCursor` accepts. */
const CURSOR_PATTERN = /^(\d+):(\d+)$/;

/**
 * A cursor component as a non-negative safe integer.
 *
 * A negative, fractional, or non-finite input reads as 0 rather than producing a
 * token no parser could read back. That keeps `parseCursor(formatCursor(e, s))`
 * non-null for every pair of numbers; the values only ever originate from the
 * Sync_Service's own counters, so normalizing is a totality guard, not a path.
 */
function cursorComponent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated <= 0) return 0;
  return Math.min(truncated, Number.MAX_SAFE_INTEGER);
}

/** Build the cursor token for a purge generation and a Server_Sequence. */
export function formatCursor(epoch: number, sequence: number): string {
  return `${cursorComponent(epoch)}${CURSOR_SEPARATOR}${cursorComponent(sequence)}`;
}

/**
 * Read a cursor token, or `null` when there is nothing usable to read.
 *
 * `null` is returned for an absent token and for every malformed shape: an empty
 * string, a missing or extra separator, a negative or fractional component,
 * surrounding whitespace, a non-numeric part, and a component beyond
 * `Number.MAX_SAFE_INTEGER` (where integer arithmetic would stop being exact).
 * Callers treat `null` as "no stored cursor" and pull from the beginning, which
 * is the same recovery path Requirement 13.13 takes on `cursor_invalid`.
 */
export function parseCursor(token: string | null): { epoch: number; sequence: number } | null {
  if (typeof token !== "string") return null;
  const match = CURSOR_PATTERN.exec(token);
  if (match === null) return null;
  const epoch = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(sequence)) return null;
  return { epoch, sequence };
}

// ---------------------------------------------------------------------------
// Trigger reasons and the retry gate (Req 11.7, 11.11, 19.8)
//
// Requirement 11.7 is the permissive half: after a failed Sync_Cycle the next
// trigger starts the next Sync_Cycle, with no backoff ladder and no attempt
// counter — the Outbox keeps every id until a cycle succeeds, so a retry costs
// one request and never loses data.
//
// Two things bound how often that can happen, and they compose as a maximum
// rather than a precedence chain:
//
// - **The automatic-retry floor** (Req 11.11): while nothing but the retry timer
//   itself is asking, at most one Sync_Cycle per 60 seconds, measured from the
//   *end* of the failed cycle.
// - **The 429 wait** (Req 19.8): after a rate-limited response, no request at
//   all until the reported number of seconds has elapsed.
//
// The floor is gated on the *reason* because Requirement 11.11 only applies
// "IF no trigger defined in criteria 1 through 4 or criterion 9 has occurred
// since that failure". Those criteria are the local write, the cold launch, the
// "Sync now" control, the connectivity return, and the foreground return — so
// every `TriggerReason` except `auto-retry` names one of them and is exempt from
// the floor. `auto-retry` is the only reason the retry timer itself raises, and
// therefore the only one the floor can gate. The 429 wait has no such exemption:
// Requirement 19.8 bars *every* further request until it elapses, "Sync now"
// included, because the wait belongs to the Sync_Service's limit window rather
// than to this client's retry policy.
// ---------------------------------------------------------------------------

/** Requirement 11.11's floor between successive automatic retries. */
export const AUTO_RETRY_MIN_INTERVAL_MS = 60_000;

/** Requirement 19.8's wait when a 429 response reports no seconds value. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Why a Sync_Cycle is being asked for (Req 11.1–11.4, 11.9, 11.11).
 *
 * - `local-write` — a Log_Event was saved or deleted (Req 11.1).
 * - `cold-launch` — the app became interactive and Sync_Settings finished
 *   restoring the persisted destination state (Req 11.2, 3.9).
 * - `manual` — the user activated "Sync now" (Req 11.3).
 * - `reconnect` — the device regained connectivity (Req 11.4).
 * - `foreground` — the app returned to the foreground after 60+ seconds in the
 *   background (Req 11.9).
 * - `auto-retry` — the retry timer fired after a failed Sync_Cycle with nothing
 *   else asking; the only reason the Requirement 11.11 floor gates.
 */
export type TriggerReason =
  | "local-write"
  | "cold-launch"
  | "manual"
  | "reconnect"
  | "foreground"
  | "auto-retry";

/**
 * How long remains of a wait that ends at `until`, or 0 when nothing is pending.
 *
 * `null` is the only input that means "nothing pending". A wait whose end or
 * whose remaining span is not a finite number is pending but unmeasurable, and
 * resolves to `fallbackMs` rather than to 0: a wait this module cannot measure is
 * one it has not seen elapse, and Requirement 19.8 bars requests until it has.
 */
function remainingWait(now: number, until: number | null, fallbackMs: number): number {
  if (until === null) return 0;
  const remaining = until - now;
  if (!Number.isFinite(remaining)) return fallbackMs;
  return remaining > 0 ? remaining : 0;
}

/**
 * Decide whether a trigger may start a Sync_Cycle now, and how long to wait if
 * not.
 *
 * `lastFailureEndedAt` is when the most recent failed Sync_Cycle ended, or
 * `null` when the most recent Sync_Cycle did not fail. `rateLimitedUntil` is
 * when the Requirement 19.8 wait from a 429 response expires, or `null` when no
 * such wait is outstanding.
 *
 * The answer is the longer of the two waits that apply, so:
 *
 * - a 429 wait longer than 60 seconds supersedes the automatic-retry floor,
 *   which is exactly what Requirement 11.11's "SHALL apply instead the wait
 *   imposed by Requirement 19.8 WHERE that wait is longer" asks for;
 * - a 429 wait shorter than the remaining floor leaves the floor in force for an
 *   `auto-retry`, since 11.11 caps automatic cycles at one per 60 seconds
 *   regardless of what else has expired;
 * - a user- or event-initiated trigger waits out a live 429 and nothing else.
 *
 * `waitMs` is 0 whenever `allowed` is true, and otherwise the milliseconds until
 * the same input would be allowed — it is a delay to arm a timer with, not a
 * timestamp. The floor is measured from the end of the failed cycle, so a clock
 * that moved backwards yields at most the full 60 seconds rather than an
 * unbounded wait; a device whose clock jumps cannot park retries forever.
 *
 * This gate does not consider connectivity, entitlement, or the enabled state:
 * Requirements 11.6 and 11.8 discard those triggers before a gate is consulted.
 */
export function retryGate(input: {
  now: number;
  lastFailureEndedAt: number | null;
  rateLimitedUntil: number | null;
  reason: TriggerReason;
}): { allowed: boolean; waitMs: number } {
  // Req 19.8 — applies to every reason, "Sync now" included.
  const rateLimitWait = remainingWait(
    input.now,
    input.rateLimitedUntil,
    DEFAULT_RATE_LIMIT_WAIT_MS,
  );

  // Req 11.11 — only the retry timer's own trigger is subject to the floor.
  let floorWait = 0;
  if (input.reason === "auto-retry" && input.lastFailureEndedAt !== null) {
    const floorEndsAt = input.lastFailureEndedAt + AUTO_RETRY_MIN_INTERVAL_MS;
    floorWait = Math.min(
      remainingWait(input.now, floorEndsAt, AUTO_RETRY_MIN_INTERVAL_MS),
      AUTO_RETRY_MIN_INTERVAL_MS,
    );
  }

  const waitMs = Math.max(rateLimitWait, floorWait);
  return waitMs > 0 ? { allowed: false, waitMs } : { allowed: true, waitMs: 0 };
}

// ###########################################################################
// I/O shell
// ###########################################################################
//
// Everything above this banner is pure. Everything below touches the network,
// IndexedDB, `localStorage` (through `syncSettings`), or the clock.
//
// The foundation (task 14.1) is the two pieces every phase sits on:
//
//   - **the transport** — one authenticated, timeout-bounded `fetch` wrapper that
//     every sync request goes through, so the Bearer credential, the 30-second
//     abort, the entitlement refresh, the 401 sign-out, and the 429 wait are
//     properties of the module rather than habits of each call site;
//   - **the Sync_State store** — `getSyncState()` / `subscribe()` over the pure
//     `deriveSyncState`, with the persisted `lastSyncAt` and `lastSkipped` mirrored
//     in memory so the state is a synchronous read and survives a restart.
//
// On top of it sit the push phase (task 14.2), the pull phase (14.3), and the
// trigger scheduler (14.6) at the end of this file: `requestSync` gates a trigger,
// the single-flight admits at most one cycle, and `runSyncCycle` runs the push
// phase and then, only on `complete`, the pull phase.
//
// The one-shot operations (task 14.8) close the file: `enqueueEntireLocalStore()`
// is what the pull phase's `cursorReset` result asks for (Req 10.9, 13.13) and
// `deleteCloudCopy()` is Settings' delete row (Req 17.4, 17.5). Neither is a
// Sync_Cycle: the first only writes to the Outbox, and the second is one request
// followed by local clean-up.

// ---------------------------------------------------------------------------
// Transport (Req 1.7, 2.7, 2.8, 6.8, 7.5, 19.8)
// ---------------------------------------------------------------------------

/** The Sync_Service endpoints (design.md, "API and route contracts"). */
export const PUSH_PATH = "/api/sync/push";
export const PULL_PATH = "/api/sync/pull";
export const CLOUD_DATA_PATH = "/api/sync/data";

/**
 * Per-request budget for every sync request (Req 6.8, 7.5). `fetchWithTimeout`
 * wires an `AbortController` into the `fetch`, so this is a genuine abort of the
 * in-flight request rather than an abandoned promise.
 */
export const SYNC_REQUEST_TIMEOUT_MS = 30_000;

/** Rejection message `fetchWithTimeout` raises when the 30 s budget elapses. */
export const SYNC_TIMEOUT_MESSAGE = "SnapGut Cloud request timed out";

/**
 * Ceiling on the wait a 429 response can impose. The Sync_Service reports 1–60
 * seconds (Req 19.4, 19.5); the clamp only bounds a nonsense value from a proxy
 * or a future revision, so a single bad header cannot park sync for a day.
 */
const MAX_RATE_LIMIT_WAIT_SECONDS = 3_600;

/**
 * Why a sync request did not produce a usable response.
 *
 * - `offline` — the request never reached the Sync_Service and the device reports
 *   no connectivity. The one case Requirement 12.5 asks the `error` message to
 *   distinguish, so it is the only failure that maps to `failureKind: "offline"`.
 * - `service` — a request-level failure, a timeout, a 5xx, or a success status
 *   whose body is not a JSON object. Attributed to the Sync_Service.
 * - `unauthorized` — 401. The existing sign-out has **already been applied** by
 *   the time this is returned, so Sync_State reads `off` from the absent
 *   Session_Token (Req 2.8, 1.6).
 * - `upgrade_required` — 402. The entitlement snapshot in the body has **already
 *   been applied**, so Sync_State reads `blocked_no_pro` (Req 2.7).
 * - `rate_limited` — 429, or a request refused locally because an earlier 429's
 *   wait has not elapsed. `waitMs` is what Requirement 19.8 bars requests for.
 * - `rejected` — 400, 409, or 413: the Sync_Service answered about the *payload*,
 *   and the body names the ids (Req 19.9, 19.11). The parsed body is handed back
 *   for `reconcileOutbox` in task 14.2.
 */
export type SyncFailure =
  | { kind: "offline"; message: string }
  | { kind: "service"; status: number | null; message: string }
  | { kind: "unauthorized" }
  | { kind: "upgrade_required" }
  | { kind: "rate_limited"; waitMs: number }
  | { kind: "rejected"; status: number; error: string; body: Record<string, unknown> };

/** A sync request's outcome: a parsed JSON body, or one reason it has none. */
export type SyncResult<T> = { ok: true; body: T } | { ok: false; failure: SyncFailure };

/**
 * How a failure is attributed in the `error` Sync_State (Req 12.5). Only a
 * positively detected lack of connectivity reads as `offline`; everything else,
 * a timeout included, is attributed to the Sync_Service.
 */
export function failureDisplayKind(failure: SyncFailure): "offline" | "service" {
  return failure.kind === "offline" ? "offline" : "service";
}

/**
 * Whether the device reports no network connectivity. A context without
 * `navigator` (a non-DOM test runner) is treated as online: an absent signal is
 * not a positive report of being offline.
 */
export function isDeviceOffline(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.onLine === false;
}

/** A JSON object body, or `null` when the response carries no parseable object. */
async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

/**
 * Funnel a response's entitlement snapshot into `syncSettings` (Req 1.7, 2.7).
 *
 * Applied for **every** response that carries one — push, pull, the cloud delete,
 * a 402 rejection — because ordinary sync traffic is what keeps the client's Pro
 * gate fresh. `applyEntitlement` persists the value and notifies synchronously,
 * so the "within 1 second" bound of Requirements 1.7 and 2.7 holds by
 * construction, and this module's own subscribers see the new gate through the
 * `syncSettings` bridge below.
 *
 * A snapshot that is not `{ pro: boolean, proUntil: number | null }` is ignored
 * rather than partially applied: a malformed entitlement is no evidence about the
 * user's entitlement, and Requirement 1.9 already fails closed without one.
 */
function applyResponseEntitlement(body: Record<string, unknown> | null): void {
  const raw = body?.entitlement;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const { pro, proUntil } = raw as Record<string, unknown>;
  if (typeof pro !== "boolean") return;
  if (proUntil !== null && proUntil !== undefined) {
    if (typeof proUntil !== "number" || !Number.isFinite(proUntil)) return;
  }
  applyEntitlement({ pro, proUntil: typeof proUntil === "number" ? proUntil : null });
}

/** A reported wait in whole seconds, or `null` when there is nothing usable. */
function waitSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.ceil(value), MAX_RATE_LIMIT_WAIT_SECONDS);
}

/**
 * How long a 429 bars further requests for (Req 19.8): the `retryAfterSeconds`
 * the body reports, else the `Retry-After` header, else 60 seconds.
 */
function rateLimitWaitFrom(body: Record<string, unknown> | null, headers: Headers): number {
  const fromBody = waitSeconds(body?.retryAfterSeconds);
  if (fromBody !== null) return fromBody * 1000;
  const fromHeader = waitSeconds(Number(headers.get("Retry-After")));
  if (fromHeader !== null) return fromHeader * 1000;
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

/** The short error code a rejection body names, for the caller's diagnostics. */
function errorCode(body: Record<string, unknown> | null): string {
  return typeof body?.error === "string" ? body.error : "unknown";
}

/**
 * A request-level failure, attributed by what the device reports rather than by
 * the error's text — a timeout while online is the Sync_Service's problem, the
 * same timeout while offline is the device's.
 */
function transportFailure(err: unknown): SyncFailure {
  const message = err instanceof Error && err.message.length > 0 ? err.message : "Request failed";
  return isDeviceOffline()
    ? { kind: "offline", message }
    : { kind: "service", status: null, message };
}

/**
 * Perform one authenticated sync request.
 *
 * Every request the Cloud_Destination makes goes through here, which is what
 * makes the following structural rather than a per-call-site convention:
 *
 * - **A Bearer credential or no request at all.** The Session_Token is read at
 *   call time and sent as `Authorization: Bearer …`; with no token held, no
 *   request is issued (Req 1.6, 2.1).
 * - **A 30-second abort.** `fetchWithTimeout` cancels the in-flight request when
 *   the budget elapses, so a hung connection cannot hold a Sync_Cycle open
 *   (Req 6.8, 7.5).
 * - **Entitlement stays fresh.** Every response body's `entitlement` is applied
 *   before the status is interpreted (Req 1.7), so a 402 refreshes the snapshot
 *   on its way to reporting `upgrade_required` (Req 2.7).
 * - **A 401 signs out.** `clearToken()` — the same sign-out the other
 *   authenticated endpoints apply — runs before the failure is returned, so
 *   Sync_State reads `off` from the absent token (Req 2.8, 1.6).
 * - **A 429 wait is honoured.** The wait is recorded and enforced *here*, so no
 *   further request can leave until it elapses, "Sync now" included (Req 19.8).
 *
 * One status is deliberately not a failure: `cursor_invalid` arrives as an HTTP
 * **200** carrying `{ error: "cursor_invalid", cursor: null }`. Success is keyed
 * on the status alone, so that body comes back as `{ ok: true }` and the pull
 * phase can take the Requirement 13.13 reset path instead of the retry path a
 * failure would trigger.
 *
 * `path` may carry its own query string; nothing here appends to it.
 */
export async function syncRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<SyncResult<T>> {
  const token = getToken();
  // No Session_Token → zero requests (Req 1.6). Nothing to sign out of, so the
  // existing sign-out is not re-applied here.
  if (token === null) return { ok: false, failure: { kind: "unauthorized" } };

  // An outstanding Requirement 19.8 wait bars every further request.
  const outstanding = remainingWait(
    Date.now(),
    runtime.rateLimitedUntil,
    DEFAULT_RATE_LIMIT_WAIT_MS,
  );
  if (outstanding > 0) {
    return { ok: false, failure: { kind: "rate_limited", waitMs: outstanding } };
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetchWithTimeout(
      path,
      {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      SYNC_REQUEST_TIMEOUT_MS,
      SYNC_TIMEOUT_MESSAGE,
    );
  } catch (err) {
    return { ok: false, failure: transportFailure(err) };
  }

  const parsed = await readJsonObject(res);
  // Before the status is interpreted, so a 402's own snapshot lands (Req 1.7, 2.7).
  applyResponseEntitlement(parsed);

  if (res.status === 401) {
    // The existing sign-out used by the other authenticated endpoints (Req 2.8).
    clearToken();
    notifySyncState();
    return { ok: false, failure: { kind: "unauthorized" } };
  }

  if (res.status === 402) return { ok: false, failure: { kind: "upgrade_required" } };

  if (res.status === 429) {
    const waitMs = rateLimitWaitFrom(parsed, res.headers);
    runtime.rateLimitedUntil = Date.now() + waitMs;
    return { ok: false, failure: { kind: "rate_limited", waitMs } };
  }

  if (res.ok) {
    if (parsed === null) {
      return {
        ok: false,
        failure: { kind: "service", status: res.status, message: "Unreadable response body" },
      };
    }
    return { ok: true, body: parsed as T };
  }

  // 400 / 409 / 413 — an answer about the payload, whose ids the caller reconciles.
  if (res.status < 500) {
    return {
      ok: false,
      failure: {
        kind: "rejected",
        status: res.status,
        error: errorCode(parsed),
        body: parsed ?? {},
      },
    };
  }

  return {
    ok: false,
    failure: { kind: "service", status: res.status, message: errorCode(parsed) },
  };
}

// ---------------------------------------------------------------------------
// Sync_State store (Req 12.4, 12.8, 12.9)
//
// `getSyncState()` is a synchronous read, because every consumer of it is a React
// render. The two durable inputs it needs — the last-successful-Sync_Cycle
// timestamp and the skipped count of Requirement 20.5 — live in the IndexedDB
// `meta` store, so they are mirrored in memory by `hydrateSyncState()` at startup
// and updated in the same step that writes them. That mirror is what makes
// Requirement 12.4's "the same value is displayed after an app restart" hold: the
// timestamp is read back from `meta`, not rebuilt from a session that no longer
// exists.
//
// Everything else is either in-memory runtime state (whether a cycle is running,
// how the last one ended) or read live from `syncSettings` (the Session_Token, the
// Pro gate, the persisted enabled state), so a sign-out, a Pro lapse, or a toggle
// changes the derived state without this module observing anything itself.
// ---------------------------------------------------------------------------

/**
 * In-memory half of the `SyncStateInput`, plus the two waits `retryGate` reads.
 *
 * There is no purge-countdown field. Decision D1 is resolved as **retain
 * indefinitely**: a lapsed user's stored Event_Records are never purged, so
 * `SyncStateInput.daysUntilPurge` is permanently `null` and nothing needs to
 * track a deadline that does not exist.
 */
interface ShellRuntime {
  cycleInProgress: boolean;
  lastCycleFailed: boolean;
  failureKind: "offline" | "service" | null;
  succeededSinceFailure: boolean;
  restoreMerged: number | null;
  /** End of the most recent failed Sync_Cycle — the Req 11.11 floor's origin. */
  lastFailureEndedAt: number | null;
  /** When the Requirement 19.8 wait from a 429 expires. */
  rateLimitedUntil: number | null;
}

/** Durable values mirrored from the IndexedDB `meta` store. */
interface ShellPersisted {
  lastSyncAt: number | null;
  lastSkipped: number;
  outboxCount: number;
}

function initialRuntime(): ShellRuntime {
  return {
    cycleInProgress: false,
    lastCycleFailed: false,
    failureKind: null,
    succeededSinceFailure: false,
    restoreMerged: null,
    lastFailureEndedAt: null,
    rateLimitedUntil: null,
  };
}

function initialPersisted(): ShellPersisted {
  return { lastSyncAt: null, lastSkipped: 0, outboxCount: 0 };
}

let runtime: ShellRuntime = initialRuntime();
let persisted: ShellPersisted = initialPersisted();

/** Subscribers notified with the derived Sync_State on any change. */
const stateListeners = new Set<(s: SyncState) => void>();

/** Memoized so `hydrateSyncState()` reads `meta` once however often it is called. */
let hydratePromise: Promise<void> | null = null;

/** Live while the `syncSettings` bridge is installed. */
let settingsUnsubscribe: (() => void) | null = null;

/**
 * Republish on every `syncSettings` change, so a sign-out, a Pro lapse, an
 * entitlement refresh, or a toggle reaches this module's subscribers within the
 * 1-second bounds of Requirements 1.7, 3.8, and 13.1 — synchronously, in fact.
 *
 * Installed lazily and idempotently rather than at module load: `syncSettings`
 * exposes a test reset that drops every listener, and re-installing on demand
 * means a bridge dropped that way is restored by the next `subscribe()` or
 * `hydrateSyncState()` instead of staying silently dead.
 */
function ensureSettingsBridge(): void {
  if (settingsUnsubscribe !== null) return;
  settingsUnsubscribe = subscribeToSyncSettings(() => {
    notifySyncState();
  });
}

/** Push the derived Sync_State to every subscriber. */
function notifySyncState(): void {
  if (stateListeners.size === 0) return;
  const state = getSyncState();
  for (const listener of stateListeners) listener(state);
}

/** A skipped count is a non-negative integer; anything else reads as none. */
function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

/** A stored timestamp is a finite number; anything else reads as "never". */
function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The snapshot `deriveSyncState` reads, assembled from the three sources: live
 * `syncSettings` state, in-memory runtime state, and the mirrored durable values.
 *
 * While `syncSettings` has not finished restoring, its enabled state reads false
 * and the derived state is `off`, which is what Requirement 3.5 asks for: no
 * trigger acts and nothing is claimed about a destination whose state is unread.
 */
function syncStateInput(): SyncStateInput {
  return {
    hasSession: getSyncSettingsSnapshot().hasSession,
    pro: isProEntitled(),
    enabled: isDestinationEnabled("cloud"),
    cycleInProgress: runtime.cycleInProgress,
    lastCycleFailed: runtime.lastCycleFailed,
    failureKind: runtime.failureKind,
    succeededSinceFailure: runtime.succeededSinceFailure,
    outboxCount: persisted.outboxCount,
    lastSyncAt: persisted.lastSyncAt,
    skipped: persisted.lastSkipped,
    restoreMerged: runtime.restoreMerged,
    // Decision D1: cloud records are retained indefinitely after a Pro_Lapse, so
    // there is no purge to count down to and `blocked_no_pro` carries no deadline.
    daysUntilPurge: null,
  };
}

/**
 * The single Sync_State to display (Req 12.8). A synchronous total function of
 * the current inputs — there is no stored state value to fall out of step with
 * them, and no combination of inputs yields two states or none.
 */
export function getSyncState(): SyncState {
  return deriveSyncState(syncStateInput());
}

/**
 * Subscribe to Sync_State changes; returns an unsubscribe function. The listener
 * is not invoked on subscription — read {@link getSyncState} for the current
 * value — and is invoked synchronously on every subsequent change.
 */
export function subscribe(listener: (s: SyncState) => void): () => void {
  ensureSettingsBridge();
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** Best-effort `meta` write: a failed one costs a restart's display, not data. */
async function persistMeta(key: "lastSyncAt" | "lastSkipped", value: number): Promise<void> {
  try {
    await setMeta(key, value);
  } catch {
    /* best-effort — the in-memory mirror still shows the new value this session */
  }
}

/**
 * Read the durable inputs into the in-memory mirror: the last-successful-cycle
 * timestamp and skipped count from `meta` (Req 12.4) and the current Outbox size
 * (Req 12.2, 12.9).
 *
 * Idempotent and memoized, so `App.tsx` can await it beside
 * `syncSettings.restore()` without guarding. An unavailable IndexedDB leaves the
 * defaults in place — no timestamp and an empty Outbox — which derives `idle`
 * rather than claiming a sync that cannot be evidenced.
 */
export function hydrateSyncState(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  ensureSettingsBridge();
  hydratePromise = (async () => {
    try {
      const [lastSyncAt, lastSkipped, outboxCount] = await Promise.all([
        getMeta<number>("lastSyncAt"),
        getMeta<number>("lastSkipped"),
        getOutboxCount(),
      ]);
      persisted = {
        lastSyncAt: normalizeTimestamp(lastSyncAt),
        lastSkipped: normalizeCount(lastSkipped),
        outboxCount: normalizeCount(outboxCount),
      };
    } catch {
      /* leave the defaults — nothing durable could be read */
    }
    notifySyncState();
  })();
  return hydratePromise;
}

/**
 * Re-read the Outbox size and republish.
 *
 * This is the whole of Requirement 12.9: `synced` requires an empty Outbox, so a
 * local write that queues an id turns the displayed state into `idle` as soon as
 * the count is re-read — no transition to fire, and the persisted `lastSyncAt`
 * keeps being displayed because derivation still carries it.
 */
export async function refreshOutboxCount(): Promise<void> {
  try {
    persisted.outboxCount = normalizeCount(await getOutboxCount());
  } catch {
    return;
  }
  notifySyncState();
}

// ---- Cycle lifecycle hooks -----------------------------------------------
//
// The four hooks below are the only way the runtime half of the input record
// changes. The push phase (task 14.2), the pull phase (14.3), and the scheduler
// (14.6) drive them; keeping them here means "which Sync_State does this show?"
// is answered by `deriveSyncState` over these fields and nothing else.

/**
 * A Sync_Cycle has started → `syncing` (Req 12.3). `restore` marks the cycle as
 * an initial pull, which carries the merged-so-far count of Requirement 10.2.
 */
export function markCycleStarted(restore = false): void {
  runtime.cycleInProgress = true;
  runtime.restoreMerged = restore ? 0 : null;
  notifySyncState();
}

/** Records merged so far by an in-progress restore (Req 10.2). */
export function markRestoreProgress(merged: number): void {
  runtime.restoreMerged = normalizeCount(merged);
  notifySyncState();
}

/**
 * A Sync_Cycle completed successfully at `at`, having skipped `skipped`
 * malformed pulled records (Req 12.4, 20.5).
 *
 * The mirror is updated and published before the durable write, so the new
 * timestamp is displayed immediately and the write is what makes it survive a
 * restart. The Outbox is re-read because `synced` requires it to be empty and
 * this cycle is what emptied it.
 */
export async function markCycleSucceeded(at: number, skipped = 0): Promise<void> {
  runtime.cycleInProgress = false;
  runtime.restoreMerged = null;
  runtime.lastCycleFailed = false;
  runtime.failureKind = null;
  runtime.succeededSinceFailure = true;
  runtime.lastFailureEndedAt = null;
  persisted.lastSyncAt = at;
  persisted.lastSkipped = normalizeCount(skipped);
  notifySyncState();
  // Feeds the 72-hour failing rule behind the shared backup nudge (Req 14.9).
  recordSyncOutcome("cloud", "success", at);
  await Promise.all([
    persistMeta("lastSyncAt", at),
    persistMeta("lastSkipped", persisted.lastSkipped),
    refreshOutboxCount(),
  ]);
}

/**
 * A Sync_Cycle failed at `at` → `error`, attributed by `kind` (Req 12.5).
 *
 * `lastSyncAt` and `lastSkipped` are left exactly as they were: Requirement 4.5
 * keeps the last-successful-sync timestamp unchanged on failure, and the `error`
 * status line displays it. `at` also becomes the origin of the Requirement 11.11
 * automatic-retry floor.
 */
export function markCycleFailed(at: number, kind: "offline" | "service"): void {
  runtime.cycleInProgress = false;
  runtime.restoreMerged = null;
  runtime.lastCycleFailed = true;
  runtime.failureKind = kind;
  runtime.succeededSinceFailure = false;
  runtime.lastFailureEndedAt = at;
  notifySyncState();
  recordSyncOutcome("cloud", "failure", at);
}

/**
 * A Sync_Cycle was abandoned rather than failed — the destination was disabled,
 * the session ended, or Pro lapsed mid-cycle (Req 13.11).
 *
 * Deliberately not a failure: the last-cycle-failed flag is untouched, so the
 * derived state comes from the condition that caused the abandonment
 * (`blocked_no_pro` or `off`) rather than reading as broken. The Outbox, the
 * Sync_Cursor, and the Local_Store are the caller's to leave alone, and this
 * touches none of them.
 */
export function markCycleAbandoned(): void {
  runtime.cycleInProgress = false;
  runtime.restoreMerged = null;
  notifySyncState();
}

// ---------------------------------------------------------------------------
// Push phase (Req 6.1, 6.2, 6.6, 6.7, 6.8, 6.12, 2.7, 2.8, 19.8, 19.9, 19.11)
//
// The push phase is the first half of a Sync_Cycle, and it is deliberately thin:
// every decision it makes is made by the pure core. It reads the Outbox, hands
// the ids to `planPush`, issues the batches that plan produced, and hands each
// response to `reconcileOutbox`. What is left here is the I/O and one control-flow
// rule — **when the push phase stops, the Sync_Cycle stops**.
//
// That rule is Requirement 6.8, and it is why this function reports a `status`
// rather than just returning. A push failure retains every Outbox id, issues no
// further push request, and ends the cycle *without beginning the pull*: pulling
// after a failed push would advance the Sync_Cursor past records the device has
// not yet managed to send, so the next cycle would push into a timeline that has
// already moved on. Only `status: "complete"` licenses the pull phase.
//
// Three answers are ends of the cycle without being failures of it:
//
//   - **401** — `syncRequest` has already applied the existing sign-out, so
//     Sync_State reads `off` from the absent Session_Token. The cycle is
//     abandoned rather than failed, and the Outbox is untouched (Req 2.8).
//   - **402** — `syncRequest` has already applied the entitlement snapshot from
//     the body, so Sync_State reads `blocked_no_pro`. Again abandoned, again with
//     every id retained (Req 2.7).
//   - an **empty Outbox** — zero push requests, the phase is complete, and the
//     pull phase runs (Req 6.12).
//
// Everything else that is not a 200 is a failed push request: a transport error,
// the 30-second abort, a 5xx, a 429 (Req 19.8), and the payload answers 400, 409,
// and 413. The 409 case is the one Requirement 19.11 names explicitly — the ids
// stay queued and no further push request is issued until the next trigger —
// which is exactly what stopping the cycle here produces.
// ---------------------------------------------------------------------------

/**
 * Outbox ids one Sync_Cycle reads. `planPush` caps the cycle at 20 requests of
 * 200 records, so this is the most it could ever send; ids beyond it stay in the
 * Outbox for the next cycle exactly as `defer` ids do (Req 6.2).
 */
export const MAX_OUTBOX_IDS_PER_CYCLE = MAX_REQUESTS_PER_CYCLE * MAX_RECORDS_PER_REQUEST;

/** How many records are read from the Local_Store at once while planning. */
const RECORD_READ_CHUNK = 64;

/** The 200 body of `POST /api/sync/push`; every field is parsed defensively. */
interface PushResponseBody {
  outcomes?: unknown;
  highestSequence?: unknown;
}

/**
 * How a Sync_Cycle phase ended.
 *
 * - `complete` — the phase did what it set out to do. For the push phase this is
 *   the only status that licenses the pull phase (Req 6.8, 6.12).
 * - `failed` — a request failed, timed out, or answered about the payload.
 *   Sync_State has been set to `error` and the cycle is over.
 * - `abandoned` — the session ended (401) or Pro lapsed (402). The cycle is over
 *   and Sync_State derives from that condition rather than reading as broken
 *   (Req 2.7, 2.8, 13.11).
 */
export type PhaseStatus = "complete" | "failed" | "abandoned";

/** What one push phase did, for the cycle wrapper and for the status line. */
export interface PushPhaseResult {
  status: PhaseStatus;
  /** Push requests issued — 0 for an empty Outbox (Req 6.12). */
  requests: number;
  /** Event_Records sent across those requests. */
  sent: number;
  /** Ids removed from the Outbox: dropped, stored, or permanently rejected. */
  removed: number;
  /** Ids removed unsent because the Local_Store holds no record (Req 6.1). */
  dropped: number;
  /** Ids held back by the 20-request ceiling, kept for a later cycle (Req 6.2). */
  deferred: number;
  /**
   * Ids the Sync_Service rejected for a permanent per-record reason. They have
   * left the Outbox and their Log_Events are untouched in the Local_Store, so
   * this is what Requirement 19.9's "indication naming the Log_Event that could
   * not be synced" is built from.
   */
  rejected: { id: string; reason: RejectReason }[];
  /** Why the phase stopped, or `null` when it completed. */
  failure: SyncFailure | null;
}

/** Running tally of one push phase, finished off by {@link endPush}. */
interface PushTally {
  requests: number;
  sent: number;
  removed: number;
  dropped: number;
  deferred: number;
  rejected: { id: string; reason: RejectReason }[];
}

function newTally(): PushTally {
  return { requests: 0, sent: 0, removed: 0, dropped: 0, deferred: 0, rejected: [] };
}

/**
 * A local failure — IndexedDB, not the network. Attributed to `service` rather
 * than to connectivity: the device's own storage failing says nothing about
 * whether it is online, and Requirement 12.5 reserves the offline message for a
 * positively reported lack of connectivity.
 */
function localFailure(err: unknown): SyncFailure {
  const message = err instanceof Error && err.message.length > 0 ? err.message : "Storage failed";
  return { kind: "service", status: null, message };
}

/**
 * Read the Local_Store entry for each Outbox id, in bounded chunks.
 *
 * A read that fails **rejects** rather than reporting the id as absent, which is
 * the whole reason this is not a bare `Promise.all` over the caller's ids: an
 * absent record means "remove this id from the Outbox" (Req 6.1), so treating an
 * unreadable one as absent would discard a local change that was never sent. The
 * caller turns the rejection into a failed cycle, which retains every id.
 */
async function readOutboxRecords(ids: string[]): Promise<Map<string, StoredRecord>> {
  const found = new Map<string, StoredRecord>();
  for (let i = 0; i < ids.length; i += RECORD_READ_CHUNK) {
    const chunk = ids.slice(i, i + RECORD_READ_CHUNK);
    const records = await Promise.all(chunk.map((id) => getRecord(id)));
    for (let j = 0; j < chunk.length; j++) {
      const record = records[j];
      if (record !== undefined) found.set(chunk[j], record);
    }
  }
  return found;
}

/**
 * Take ids out of the Outbox, reporting how many left.
 *
 * Best-effort by design. A failed removal leaves the ids queued, which costs one
 * redundant re-push next cycle — push is idempotent (Req 6.5) — and that is a
 * better outcome than failing a Sync_Cycle over bookkeeping. It also keeps
 * Requirement 6.1's "without failing the Sync_Cycle" true of the drop path even
 * when the Outbox write is what failed.
 */
async function releaseOutboxIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    await removeOutboxIds(ids);
    return ids.length;
  } catch {
    return 0;
  }
}

/** True when the id may leave the Outbox on this reason alone (Req 19.9). */
function isPermanentRejection(reason: RejectReason): boolean {
  return PERMANENT_REJECT_REASONS.has(reason);
}

/**
 * Read the `outcomes` array of a push response.
 *
 * The response is untrusted input, so a malformed entry is skipped rather than
 * repaired: an id with no usable outcome is an id `reconcileOutbox` keeps, and
 * keeping an id can only cost a re-push. A `reason` this version does not
 * recognize is passed through as it arrived — `reconcileOutbox` reads an
 * unrecognized reason as unsettled, which is the safe side of a Sync_Service
 * that grew a new rejection code.
 */
function parsePushOutcomes(raw: unknown): PushOutcome[] {
  if (!Array.isArray(raw)) return [];
  const out: PushOutcome[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, outcome, reason } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) continue;
    if (outcome === "stored") {
      out.push({ id, outcome: "stored" });
      continue;
    }
    if (outcome === "rejected" && typeof reason === "string") {
      out.push({ id, outcome: "rejected", reason: reason as RejectReason });
    }
  }
  return out;
}

/**
 * Apply one push response to the Outbox.
 *
 * `reconcileOutbox` decides which of the ids *this request carried* are settled;
 * this function performs the removal and records the permanently rejected ones
 * for the status line (Req 6.6, 6.7, 19.9, 19.11).
 */
async function applyPushResponse(
  sentIds: string[],
  rawOutcomes: unknown,
  tally: PushTally,
): Promise<void> {
  const outcomes = parsePushOutcomes(rawOutcomes);
  const { remove } = reconcileOutbox(sentIds, outcomes);
  const removable = new Set(remove);

  for (const outcome of outcomes) {
    if (outcome.outcome !== "rejected") continue;
    if (!removable.has(outcome.id)) continue;
    if (!isPermanentRejection(outcome.reason)) continue;
    tally.rejected.push({ id: outcome.id, reason: outcome.reason });
  }

  tally.removed += await releaseOutboxIds(remove);
}

/**
 * Finish a push phase: republish the Outbox count if it changed, set the
 * Sync_State the ending calls for, and report.
 *
 * `failure === null` is the completing case and touches no cycle state — the
 * cycle is still running, and the pull phase is what ends it. A 401 or a 402
 * *abandons* the cycle (Req 2.7, 2.8): the sign-out and the entitlement refresh
 * have already been applied by the transport, so `markCycleAbandoned` leaves
 * derivation to report `off` or `blocked_no_pro` rather than `error`. Everything
 * else is a failed push request, which sets `error` (Req 6.8, 19.8, 19.11).
 *
 * `abandoned` is the third ending: the destination was disabled, the session
 * ended, or Pro lapsed between requests, which the scheduler's guard reports
 * (Req 11.10, 13.1, 13.11). Like a 401 or a 402 it is not a failure, so it
 * carries no `failure` value and leaves derivation to report the condition that
 * caused it.
 */
async function endPush(
  tally: PushTally,
  failure: SyncFailure | null,
  abandoned = false,
): Promise<PushPhaseResult> {
  // The drop path and any permanent rejections changed the pending count even
  // when the phase went on to fail (Req 12.2).
  if (tally.removed > 0) await refreshOutboxCount();

  let status: PhaseStatus = "complete";
  if (abandoned) {
    status = "abandoned";
    markCycleAbandoned();
  } else if (failure !== null) {
    if (failure.kind === "unauthorized" || failure.kind === "upgrade_required") {
      status = "abandoned";
      markCycleAbandoned();
    } else {
      status = "failed";
      markCycleFailed(Date.now(), failureDisplayKind(failure));
    }
  }

  return {
    status,
    requests: tally.requests,
    sent: tally.sent,
    removed: tally.removed,
    dropped: tally.dropped,
    deferred: tally.deferred,
    rejected: tally.rejected,
    failure,
  };
}

/**
 * Run the push phase of one Sync_Cycle.
 *
 * The caller has already established eligibility and called `markCycleStarted`;
 * this function does not gate on the enabled state, Pro, or connectivity
 * (Req 11.6, 11.8 discard those triggers before a cycle begins). It runs to one
 * of three endings, and only `complete` licenses the pull phase:
 *
 * 1. **Empty Outbox** → zero push requests, `complete`, and the caller pulls
 *    (Req 6.12).
 * 2. **Every batch stored** → the settled ids are out of the Outbox, `complete`.
 * 3. **A request failed** → every unsettled id is still queued, no further push
 *    request is issued, and the cycle is over (Req 6.8).
 * 4. **The destination stopped being usable between requests** → `abandoned`,
 *    with every unsettled id queued and no further request issued (Req 11.10,
 *    13.1, 13.11). Only a cycle run through `requestSync` arms that guard.
 *
 * The Local_Store's Log_Events and Tombstones are never written here — not on a
 * drop, not on a rejection, not on a failure. The only durable write is the
 * removal of settled Outbox ids.
 */
export async function runPushPhase(): Promise<PushPhaseResult> {
  const tally = newTally();

  let ids: string[];
  try {
    ids = await getOutboxBatch(MAX_OUTBOX_IDS_PER_CYCLE);
  } catch (err) {
    return endPush(tally, localFailure(err));
  }

  // Req 6.12 — nothing queued, so nothing is sent and the pull phase follows.
  if (ids.length === 0) return endPush(tally, null);

  let records: Map<string, StoredRecord>;
  try {
    records = await readOutboxRecords(ids);
  } catch (err) {
    return endPush(tally, localFailure(err));
  }

  const plan = planPush(ids, (id) => records.get(id) ?? null);
  tally.deferred = plan.defer.length;

  // Req 6.1 — an id with no matching Log_Event or Tombstone leaves the Outbox
  // without an Event_Record being sent and without failing the Sync_Cycle.
  tally.dropped = await releaseOutboxIds(plan.drop);
  tally.removed += tally.dropped;

  for (const batch of plan.batches) {
    // Req 11.10, 13.1, 13.11 — a destination disabled, a session ended, or Pro
    // lapsed since the previous request stops the cycle before the next one
    // leaves. Every unsettled id stays queued.
    if (cycleMustStop()) return endPush(tally, null, true);

    const sentIds = batch.map((record) => record.id);
    const res = await syncRequest<PushResponseBody>("POST", PUSH_PATH, { records: batch });

    if (!res.ok) {
      // A 400, 409, or 413 answered about the payload and may name ids: the
      // permanently rejected ones leave the Outbox, every other sent id stays
      // (Req 6.7, 19.9, 19.11). Only then does the cycle end (Req 6.8).
      if (res.failure.kind === "rejected") {
        tally.requests++;
        tally.sent += batch.length;
        await applyPushResponse(sentIds, res.failure.body.outcomes, tally);
      }
      return endPush(tally, res.failure);
    }

    tally.requests++;
    tally.sent += batch.length;
    await applyPushResponse(sentIds, res.body.outcomes, tally);
  }

  return endPush(tally, null);
}

// ---------------------------------------------------------------------------
// Pull phase (Req 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 9.3, 9.4, 10.2,
// 13.13, 20.5)
//
// The pull phase is a page loop, and the loop's shape *is* the durability
// argument. One iteration issues one request, hands the page to
// `db.mergePulledPage`, and waits for that transaction to commit before the next
// request goes out (Req 7.3). Because the merge and the Sync_Cursor share that
// transaction (Req 7.4), the cursor can never name a Server_Sequence past a
// record the Local_Store did not receive: either both are durable or neither is.
//
// Every failure therefore has the same consequence, whether it was the request,
// the 30-second abort, or the IndexedDB transaction: stop, keep the cursor the
// last committed page set, keep every record those pages merged, set `error`, and
// resume from that cursor on the next Sync_Cycle (Req 7.5). There is no partial
// page to reason about and no rollback to perform.
//
// Two answers are not failures:
//
//   - **A page reporting no further records** — including an empty one — is what
//     completes the pull. `markCycleSucceeded` then records the completion
//     timestamp and the skipped count (Req 7.8, 12.4, 20.5).
//   - **`cursor_invalid`**, which arrives as an HTTP **200** carrying
//     `{ error: "cursor_invalid", cursor: null }`. The stored cursor is dropped
//     and the phase returns `cursorReset`, leaving the cycle open: Requirement
//     13.13 has the whole local timeline re-enqueued and *pushed* before the
//     cursor advances again, which is `recoverFromCursorReset` over
//     `enqueueEntireLocalStore()`. Treating this as a failure would retry the same
//     dead cursor forever, which is precisely why the Sync_Service reports it as
//     a 200.
// ---------------------------------------------------------------------------

/** The 200 body of `GET /api/sync/pull`; every field is parsed defensively. */
interface PullResponseBody {
  records?: unknown;
  cursor?: unknown;
  hasMore?: unknown;
  error?: unknown;
}

/** What one pull phase did, for the cycle wrapper and for the status line. */
export interface PullPhaseResult {
  status: PhaseStatus;
  /** Pull requests issued, including the one that failed. */
  requests: number;
  /** Pages whose merge transaction committed. */
  pages: number;
  /** Records that went through the merge rule across those pages. */
  merged: number;
  /** Records skipped as malformed, which the cursor advanced past (Req 20.5). */
  skipped: number;
  /** Ids whose stored record changed, which is what the timeline refresh needs. */
  changed: number;
  /** The Sync_Service reported the stored cursor as no longer valid (Req 13.13). */
  cursorReset: boolean;
  /** When the pull completed, or `null` when it did not (Req 7.8). */
  completedAt: number | null;
  /** Why the phase stopped, or `null` when it completed. */
  failure: SyncFailure | null;
}

interface PullTally {
  requests: number;
  pages: number;
  merged: number;
  skipped: number;
  changed: number;
}

function newPullTally(): PullTally {
  return { requests: 0, pages: 0, merged: 0, skipped: 0, changed: 0 };
}

/** One page's usable contents, or `null` when the body is not a pull page. */
interface PulledPage {
  records: unknown[];
  cursor: string;
  hasMore: boolean;
}

/**
 * Read a pull page from a 200 body.
 *
 * A body with no `records` array or no cursor to commit is not a page this phase
 * can act on, so it reads as `null` and the caller attributes it to the
 * Sync_Service. The cursor is required precisely because it is what
 * `mergePulledPage` commits: merging a page and committing nothing would let the
 * next cycle re-serve it forever.
 *
 * `hasMore` is read strictly, and anything other than `true` ends the pull. That
 * is the safe direction: ending a page early costs one extra Sync_Cycle, whereas
 * continuing on an unreadable flag would loop against a service that has no
 * further pages to give.
 *
 * The cursor itself stays **opaque** — any non-empty string is stored and echoed
 * back. `parseCursor` is not applied here; a token this version cannot read back
 * is handled where it is read, by pulling from the beginning.
 */
function parsePullPage(body: PullResponseBody): PulledPage | null {
  if (!Array.isArray(body.records)) return null;
  if (typeof body.cursor !== "string" || body.cursor.length === 0) return null;
  return { records: body.records, cursor: body.cursor, hasMore: body.hasMore === true };
}

/**
 * The stored Sync_Cursor, or `null` for "pull everything" (Req 7.1).
 *
 * The stored token is untrusted input — it survives restarts and schema
 * upgrades — so it is validated through `parseCursor`, and anything unusable
 * reads as absent. That costs a full re-pull, which is harmless: merging is
 * idempotent (Req 7.6), so re-merging the whole timeline changes nothing.
 */
function readStoredCursor(stored: unknown): string | null {
  if (typeof stored !== "string") return null;
  return parseCursor(stored) === null ? null : stored;
}

/** `GET /api/sync/pull` for one page; an absent cursor asks from the beginning. */
function pullPath(cursor: string | null): string {
  const query = new URLSearchParams();
  if (cursor !== null) query.set("cursor", cursor);
  query.set("limit", String(PULL_PAGE_SIZE));
  return `${PULL_PATH}?${query.toString()}`;
}

// ---- Local_Store change notification (Req 7.10, 9.4) ---------------------

/** Notified with the ids a committed page changed. */
const changeListeners = new Set<(changedIds: string[]) => void>();

/**
 * Subscribe to Local_Store changes a pull produced; returns an unsubscribe
 * function. The listener receives the ids whose stored record changed, once per
 * committed page.
 *
 * This is how the displayed timeline and the derived statistics are refreshed
 * within the 2 seconds Requirements 7.10 and 9.4 allow — synchronously on commit,
 * in fact. Views re-read through `getEvents()`, which filters Tombstones, so a
 * merged Tombstone leaves the timeline, the statistics, and CSV export by the
 * same read (Req 9.3, 9.6).
 */
export function subscribeToLocalChanges(listener: (changedIds: string[]) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** Publish one committed page's changed ids. A listener that throws is isolated. */
function notifyLocalChanges(changedIds: string[]): void {
  if (changedIds.length === 0 || changeListeners.size === 0) return;
  for (const listener of changeListeners) {
    try {
      listener(changedIds.slice());
    } catch {
      /* a subscriber's failure is not a Sync_Cycle failure */
    }
  }
}

/**
 * Finish a pull phase: set the Sync_State the ending calls for, and report.
 *
 * The completing case is the one that ends the whole Sync_Cycle successfully, so
 * this is where `lastSyncAt` and the skipped count are recorded (Req 7.8, 12.4,
 * 20.5). `cursorReset` completes the *phase* without completing the cycle: the
 * Requirement 13.13 recovery still has to push the re-enqueued timeline, so the
 * cycle is left open for the caller and no timestamp is claimed.
 */
async function endPull(
  tally: PullTally,
  failure: SyncFailure | null,
  cursorReset: boolean,
  abandoned = false,
): Promise<PullPhaseResult> {
  let status: PhaseStatus = "complete";
  let completedAt: number | null = null;

  if (abandoned) {
    // Req 13.11 — the pages already merged stay merged, the cursor stays where
    // the last committed page left it, and no timestamp is claimed.
    status = "abandoned";
    markCycleAbandoned();
  } else if (failure !== null) {
    if (failure.kind === "unauthorized" || failure.kind === "upgrade_required") {
      status = "abandoned";
      markCycleAbandoned();
    } else {
      status = "failed";
      markCycleFailed(Date.now(), failureDisplayKind(failure));
    }
  } else if (!cursorReset) {
    completedAt = Date.now();
    await markCycleSucceeded(completedAt, tally.skipped);
  }

  return {
    status,
    requests: tally.requests,
    pages: tally.pages,
    merged: tally.merged,
    skipped: tally.skipped,
    changed: tally.changed,
    cursorReset,
    completedAt,
    failure,
  };
}

/**
 * Run the pull phase of one Sync_Cycle.
 *
 * The caller has established eligibility, called `markCycleStarted`, and had the
 * push phase report `complete` — Requirement 6.8 makes that last one a
 * precondition, since pulling after a failed push would advance the cursor past
 * records the device has not managed to send.
 *
 * Pages are requested from the stored cursor, or from the beginning when none is
 * stored (Req 7.1), and the loop ends on the first page reporting no further
 * records (Req 7.8). While an initial pull is running — recognized by a page
 * arriving full, which is what Requirement 10.2 keys the restore indication on —
 * the merged-so-far count is published after every committed page.
 *
 * The loop is bounded by the Sync_Service advancing the cursor. A page that
 * reports more records while handing back the cursor it was given cannot make
 * progress, so it is attributed to the Sync_Service rather than requested again:
 * a malfunctioning page is a failed Sync_Cycle, never an unbounded loop.
 */
export async function runPullPhase(): Promise<PullPhaseResult> {
  const tally = newPullTally();

  let cursor: string | null;
  try {
    cursor = readStoredCursor(await getMeta<string>("cursor"));
  } catch (err) {
    return endPull(tally, localFailure(err), false);
  }

  // Set once a page arrives carrying the full 500 records (Req 10.2).
  let restoring = false;

  for (;;) {
    // Req 11.10, 13.1, 13.11 — no further page is requested once the
    // destination stops being usable.
    if (cycleMustStop()) return endPull(tally, null, false, true);

    const res = await syncRequest<PullResponseBody>("GET", pullPath(cursor));
    if (!res.ok) return endPull(tally, res.failure, false);
    tally.requests++;

    // Req 13.13 — a 200 carrying the reset signal rather than a page.
    if (res.body.error === "cursor_invalid") {
      try {
        // No stored value, so the next pull starts from the beginning (Req 7.1).
        await setMeta("cursor", null);
      } catch (err) {
        return endPull(tally, localFailure(err), false);
      }
      return endPull(tally, null, true);
    }

    const page = parsePullPage(res.body);
    if (page === null) {
      const failure: SyncFailure = {
        kind: "service",
        status: null,
        message: "Unreadable pull page",
      };
      return endPull(tally, failure, false);
    }

    // Req 13.11 — a page fetched but not yet merged is discarded rather than
    // merged when Pro lapses mid-cycle, so the cursor and the Local_Store stay
    // exactly as the last fully merged page left them.
    if (cycleMustStop()) return endPull(tally, null, false, true);

    let result: MergePageResult;
    try {
      // One transaction for the page and the cursor; the next request waits for
      // it to commit (Req 7.3, 7.4). A rejection here leaves both as the last
      // committed page left them (Req 7.5).
      result = await mergePulledPage(page.records, page.cursor);
    } catch (err) {
      return endPull(tally, localFailure(err), false);
    }

    tally.pages++;
    tally.merged += result.merged;
    tally.skipped += result.skipped;
    tally.changed += result.changedIds.length;
    // Req 7.10, 9.4 — the timeline and every derived statistic refresh from this.
    notifyLocalChanges(result.changedIds);

    if (page.records.length >= PULL_PAGE_SIZE) restoring = true;
    if (restoring) markRestoreProgress(tally.merged);

    // Req 7.8 — no further records, including on an empty page.
    if (!page.hasMore) return endPull(tally, null, false);

    if (page.cursor === cursor) {
      const failure: SyncFailure = {
        kind: "service",
        status: null,
        message: "Pull cursor did not advance",
      };
      return endPull(tally, failure, false);
    }
    cursor = page.cursor;
  }
}

// ---------------------------------------------------------------------------
// Triggers, the eligibility gate, and the Sync_Cycle (Req 11, 13.1, 13.2, 13.11)
//
// Every trigger in the system arrives at `requestSync(reason)`, and the shape of
// that function is the whole of Requirement 11:
//
//   trigger → eligibility gate → single-flight → push phase → pull phase
//
// The gate sits **outside** the single-flight, which is the part that is easy to
// get backwards. Requirements 11.6 and 11.8 do not say "queue it and skip it
// later", they say an ineligible trigger queues *zero* Sync_Cycles: while the
// destination is disabled, Pro is false, no Session_Token is held, the device
// reports no connectivity, or a retry window is still open, the trigger is
// **discarded**. Were the gate inside the single-flight, such a trigger would
// still become the one queued rerun and a cycle would start the moment the
// in-flight one ended — exactly the behavior those criteria rule out.
//
// Inside the gate, `createSingleFlight` (`src/singleFlight.ts`, shared with the
// Sheets mirror) supplies Requirements 11.5, 11.6, 11.8, and 11.10 verbatim: at
// most one cycle runs, any number of triggers arriving during it collapse into
// exactly one queued rerun, and that rerun starts as soon as the in-flight cycle
// settles whether it succeeded or failed. That collapse is also how repeated
// local writes (Req 11.1) and repeated connectivity transitions (Req 11.4) become
// one pending trigger rather than a queue of them.
//
// Two things happen at the boundaries of a cycle rather than inside a phase:
//
//   - **The queued rerun is re-gated.** Requirement 11.10 discards it when the
//     destination was disabled or Pro lapsed while the earlier cycle ran, so the
//     cycle body re-checks eligibility instead of trusting the trigger that
//     queued it.
//   - **An in-flight cycle is abandoned, not failed.** While a cycle runs through
//     here, the push and pull phases consult `cycleMustStop()` before every
//     request and before merging any fetched page, so a disable, a sign-out, or a
//     Pro_Lapse stops the cycle within one request of the entitlement being
//     applied (Req 13.1) while the Outbox, the Sync_Cursor, and the Local_Store
//     are left exactly as they were (Req 11.10, 13.2, 13.11).
// ---------------------------------------------------------------------------

/** Requirement 11.9's background interval before a foreground return syncs. */
export const FOREGROUND_TRIGGER_THRESHOLD_MS = 60_000;

/** Live only while a cycle started by {@link requestSync} is running. */
let cycleGuardArmed = false;

/** One pending automatic retry at a time (Req 11.7, 11.11). */
let autoRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** When the app last became hidden, or `null` when it is not hidden (Req 11.9). */
let hiddenSince: number | null = null;

/** The installed teardown while {@link startTriggers} is active. */
let triggerTeardown: (() => void) | null = null;

/** Built on first use so `resetCloudSyncForTests` can drop its queue state. */
let cycleScheduler: (() => Promise<void>) | null = null;

/**
 * The three conditions a Sync_Cycle needs to exist at all: the destination is
 * enabled, Pro_Entitlement is true, and a Session_Token is held (Req 11.6, 1.6).
 *
 * Read live from `syncSettings` on every call, never cached, so a toggle, a
 * sign-out, or an entitlement refresh is visible to the very next check — which
 * is what lets the mid-cycle guard react within the 1 second of Requirement 13.1.
 */
function destinationUsable(): boolean {
  return isDestinationEnabled("cloud") && isProEntitled() && getSyncSettingsSnapshot().hasSession;
}

/**
 * Whether the in-flight Sync_Cycle must stop before its next request or merge
 * (Req 11.10, 13.1, 13.11).
 *
 * The guard is only armed while a cycle is running through {@link requestSync},
 * so a phase driven directly — by a one-shot operation or a test — behaves as it
 * always did.
 */
function cycleMustStop(): boolean {
  return cycleGuardArmed && !destinationUsable();
}

/**
 * What the Requirement 13.13 recovery did, when a Sync_Cycle ran into a
 * Sync_Cursor the Sync_Service reported as no longer valid.
 *
 * `push` runs before `pull`, which is the whole point: the re-enqueued timeline
 * has to reach the Sync_Service *before* the cursor advances again, or a
 * re-subscribing user's local history would be skipped rather than re-uploaded.
 */
export interface CycleRecovery {
  /** How the recovery ended; `complete` only when the re-pull completed too. */
  status: PhaseStatus;
  /** Ids the re-enqueue placed in the Outbox (Req 13.13). */
  enqueued: number;
  /** The push of the re-enqueued timeline, or `null` when the enqueue failed. */
  push: PushPhaseResult | null;
  /** The pull that advanced the cursor again, or `null` when none was licensed. */
  pull: PullPhaseResult | null;
  /** Why the recovery stopped, or `null` when nothing failed. */
  failure: SyncFailure | null;
}

/** What one Sync_Cycle did, for the scheduler and for one-shot callers. */
export interface CycleResult {
  /** `complete` only when the push phase and the pull phase both completed. */
  status: PhaseStatus;
  push: PushPhaseResult;
  /** `null` when the push phase did not license a pull (Req 6.8). */
  pull: PullPhaseResult | null;
  /** The Sync_Service reported the stored cursor as invalid (Req 13.13). */
  cursorReset: boolean;
  /** The Req 13.13 recovery, or `null` when the cursor was never reset. */
  recovery: CycleRecovery | null;
}

/**
 * Recover from a Sync_Cursor the Sync_Service reported as no longer valid
 * (Req 13.13).
 *
 * The pull phase has already dropped the stored cursor, so the Local_Store's own
 * timeline is the only copy of anything the cloud no longer holds. The recovery
 * is therefore ordered: re-enqueue every local id, **push**, and only then pull
 * again — pulling first would advance the cursor over the empty (or purged) cloud
 * timeline and the device would conclude it was fully synced while holding
 * records the Sync_Service never received.
 *
 * Three endings other than `complete`:
 *
 * - **The re-enqueue failed.** No push, no pull, and the cycle is a failed one.
 *   The cursor stays unset, so the next Sync_Cycle starts this recovery over.
 * - **The push did not complete.** Every id stays queued and no pull runs, which
 *   is Requirement 6.8 applied to the recovery: the cursor must not advance past
 *   records still waiting to be sent.
 * - **The re-pull was answered `cursor_invalid` again.** Not recovered a second
 *   time within one cycle: nothing failed, nothing is claimed, and the next
 *   trigger starts over from an unset cursor. That bounds the recovery at one
 *   attempt per Sync_Cycle rather than looping against a service that keeps
 *   invalidating.
 */
async function recoverFromCursorReset(): Promise<CycleRecovery> {
  // Req 11.10, 13.11 — a disable, a sign-out, or a Pro_Lapse during the pull
  // stops the recovery before it writes to the Outbox.
  if (cycleMustStop()) {
    markCycleAbandoned();
    return { status: "abandoned", enqueued: 0, push: null, pull: null, failure: null };
  }

  let enqueued: number;
  try {
    enqueued = await enqueueEntireLocalStore();
  } catch (err) {
    const failure = localFailure(err);
    markCycleFailed(Date.now(), failureDisplayKind(failure));
    return { status: "failed", enqueued: 0, push: null, pull: null, failure };
  }

  const push = await runPushPhase();
  if (push.status !== "complete") {
    return { status: push.status, enqueued, push, pull: null, failure: push.failure };
  }

  if (cycleMustStop()) {
    markCycleAbandoned();
    return { status: "abandoned", enqueued, push, pull: null, failure: null };
  }

  const pull = await runPullPhase();
  // A second reset ends the cycle without completing it; `runSyncCycle`'s
  // `finally` closes it out, leaving the Outbox and the unset cursor as they are.
  const status: PhaseStatus = pull.cursorReset ? "abandoned" : pull.status;
  return { status, enqueued, push, pull, failure: pull.failure };
}

/**
 * Run one Sync_Cycle: push phase, then — **only** when the push phase reports
 * `complete` — the pull phase (Req 6.8).
 *
 * That ordering is the durability argument of the whole cycle. Pulling after a
 * failed push would advance the Sync_Cursor past records the device has not
 * managed to send, so the next cycle would push into a timeline that has already
 * moved on. A push phase that failed, was abandoned, or ended on a 401 or a 402
 * therefore ends the cycle where it stands, with the Outbox intact.
 *
 * The eligibility gate has already run and `markCycleStarted` is called here, so
 * Sync_State reads `syncing` for the whole cycle (Req 12.3). Whatever the ending,
 * the cycle is closed out before returning: the phases' own hooks handle success,
 * failure, and abandonment, and the `finally` covers the two paths that leave no
 * hook behind — a `cursorReset` and an unexpected throw — so `syncing` can never
 * be left displayed for a cycle that is no longer running.
 */
export async function runSyncCycle(): Promise<CycleResult> {
  markCycleStarted();
  cycleGuardArmed = true;

  try {
    const push = await runPushPhase();
    if (push.status !== "complete") {
      return { status: push.status, push, pull: null, cursorReset: false, recovery: null };
    }

    // Req 11.10, 13.11 — a disable or a Pro_Lapse during the push phase stops the
    // cycle before a single page is pulled.
    if (cycleMustStop()) {
      markCycleAbandoned();
      return { status: "abandoned", push, pull: null, cursorReset: false, recovery: null };
    }

    const pull = await runPullPhase();

    if (!pull.cursorReset) {
      return { status: pull.status, push, pull, cursorReset: false, recovery: null };
    }

    // Req 13.13 — the Sync_Service reported the stored cursor as no longer valid.
    // The cursor has been cleared; the recovery places every local id in the
    // Outbox and pushes it *before* the cursor advances again.
    const recovery = await recoverFromCursorReset();
    return { status: recovery.status, push, pull, cursorReset: true, recovery };
  } finally {
    cycleGuardArmed = false;
    // A `cursorReset` completes the pull phase without completing the cycle, and
    // an unexpected throw completes nothing; neither may leave `syncing` on
    // screen. `markCycleAbandoned` touches no durable state, so the Outbox, the
    // cursor, and the Local_Store are unaffected.
    if (runtime.cycleInProgress) markCycleAbandoned();
  }
}

/**
 * The single-flight-wrapped cycle body.
 *
 * The re-check at the top is Requirement 11.10's "discard the queued
 * Sync_Cycle": a rerun queued by an eligible trigger must not run if the
 * destination was disabled, the session ended, or Pro lapsed while the earlier
 * cycle was still going. Connectivity is re-checked for the same reason — a
 * rerun queued before the device dropped offline would otherwise issue requests
 * Requirement 11.8 bars.
 *
 * The Requirement 19.8 wait is not re-checked here: `syncRequest` enforces it on
 * every request, so a rerun that runs into a live 429 wait ends as a failed cycle
 * and arms the automatic retry below rather than slipping a request past it.
 */
async function cycleBody(): Promise<void> {
  if (!destinationUsable() || isDeviceOffline()) return;

  await runSyncCycle();

  // Req 11.7, 11.11 — after a failed cycle, one automatic retry, no sooner than
  // 60 seconds after that cycle ended (or later, when a 429 wait says so).
  if (runtime.lastCycleFailed) {
    const gate = retryGate({
      now: Date.now(),
      lastFailureEndedAt: runtime.lastFailureEndedAt,
      rateLimitedUntil: runtime.rateLimitedUntil,
      reason: "auto-retry",
    });
    if (!gate.allowed) armAutoRetry(gate.waitMs);
  }
}

/** The shared scheduler, built on first use (Req 11.5). */
function scheduler(): () => Promise<void> {
  cycleScheduler ??= createSingleFlight(cycleBody);
  return cycleScheduler;
}

/**
 * Arm the automatic retry timer for `waitMs` (Req 11.7, 11.11).
 *
 * At most one timer exists at a time and an armed one is never rescheduled, so
 * "at most one automatic Sync_Cycle per 60 seconds" is a property of the timer
 * rather than of the callers. When it fires, `requestSync("auto-retry")` runs the
 * gate again: a wait that has not actually elapsed — a clock that moved, a 429
 * that arrived meanwhile — simply re-arms the timer for what remains, so the
 * scheduler converges instead of retrying early.
 *
 * Nothing is armed unless {@link startTriggers} is installed: the automatic retry
 * belongs to the app's trigger lifetime, and a timer outliving it would fire
 * against a torn-down app.
 */
function armAutoRetry(waitMs: number): void {
  if (triggerTeardown === null) return;
  if (autoRetryTimer !== null) return;
  const delay = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : AUTO_RETRY_MIN_INTERVAL_MS;
  autoRetryTimer = setTimeout(() => {
    autoRetryTimer = null;
    void requestSync("auto-retry");
  }, delay);
}

/**
 * Ask for a Sync_Cycle. The single entry point for every trigger in
 * Requirement 11, and the only place a Sync_Cycle can start.
 *
 * The returned promise settles when the cycle this trigger is served by settles,
 * and resolves immediately for a discarded trigger. It never rejects: a failed
 * cycle is reported through Sync_State (Req 12.5), not through this promise, so
 * no call site needs a `catch` to avoid an unhandled rejection.
 *
 * The gate, in order:
 *
 * 1. **Not usable** — the destination is disabled, Pro is false, or no
 *    Session_Token is held. A no-op: zero queued cycles and zero requests
 *    (Req 11.6). Sync_State already reads `off` or `blocked_no_pro` from those
 *    same conditions, so nothing is recorded.
 * 2. **Offline** — zero requests, the trigger is discarded without queuing, the
 *    Outbox is untouched, and Sync_State is set to `error` with the offline
 *    indication (Req 11.8). While a cycle is already running the state is left to
 *    that cycle's own outcome rather than overwritten mid-flight.
 * 3. **Inside a retry window** — a 429 wait, or the 60-second floor for the retry
 *    timer's own trigger. Discarded, with the timer armed for what remains
 *    (Req 11.11, 19.8).
 *
 * Everything that passes goes to the single-flight, which is what makes a burst
 * of triggers one cycle plus at most one queued rerun (Req 11.1, 11.4, 11.5).
 */
export function requestSync(reason: TriggerReason): Promise<void> {
  // Req 11.6 — a trigger while the destination cannot sync queues nothing.
  if (!destinationUsable()) return Promise.resolve();

  const now = Date.now();

  // Req 11.8 — no connectivity: no request, no queued cycle, Outbox unchanged.
  if (isDeviceOffline()) {
    if (!runtime.cycleInProgress) {
      markCycleFailed(now, "offline");
      armAutoRetry(AUTO_RETRY_MIN_INTERVAL_MS);
    }
    return Promise.resolve();
  }

  // Req 11.7, 11.11, 19.8 — the retry window.
  const gate = retryGate({
    now,
    lastFailureEndedAt: runtime.lastFailureEndedAt,
    rateLimitedUntil: runtime.rateLimitedUntil,
    reason,
  });
  if (!gate.allowed) {
    armAutoRetry(gate.waitMs);
    return Promise.resolve();
  }

  return scheduler()();
}

/**
 * Install the ambient triggers and return their teardown (Req 11.4, 11.9, 11.11).
 *
 * Two listeners and one timer:
 *
 * - **`online`** — the device regained connectivity, so the queued ids get a
 *   chance to leave (Req 11.4). Repeated transitions collapse into one pending
 *   trigger through the single-flight, and a transition while ineligible is
 *   discarded by the gate. A cycle is requested even when the Outbox is empty,
 *   since reconnecting is also the moment a pull becomes possible again.
 * - **`visibilitychange`** — a return to the foreground syncs only after 60 or
 *   more continuous seconds hidden, and triggers nothing at all below that
 *   threshold (Req 11.9). The interval is measured from the `hidden` transition
 *   this handler saw; with no observed `hidden` there is no interval and no
 *   trigger, so a visibility event that arrives without one is ignored rather
 *   than treated as a long absence.
 * - **the automatic retry timer**, armed by a failed cycle and by a trigger the
 *   retry window turned away (Req 11.7, 11.11).
 *
 * Idempotent: a second call while installed returns the same teardown rather than
 * doubling the listeners. The teardown removes the listeners, cancels a pending
 * retry, and forgets the hidden timestamp; it does not touch the Outbox, the
 * Sync_Cursor, or the Local_Store, and an in-flight cycle is left to finish.
 *
 * The startup and save-flow triggers — `cold-launch` (Req 11.2) and
 * `local-write` (Req 11.1) — are not ambient events, so they stay with the code
 * that knows when they happened and call `requestSync` directly (task 15.4).
 */
export function startTriggers(): () => void {
  if (triggerTeardown !== null) return triggerTeardown;

  const onOnline = (): void => {
    void requestSync("reconnect");
  };

  const onVisibilityChange = (): void => {
    if (typeof document === "undefined") return;

    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      return;
    }

    const since = hiddenSince;
    hiddenSince = null;
    if (since === null) return;
    // Req 11.9 — fewer than 60 continuous seconds in the background triggers
    // zero Sync_Cycles.
    if (Date.now() - since < FOREGROUND_TRIGGER_THRESHOLD_MS) return;
    void requestSync("foreground");
  };

  const hasWindow = typeof window !== "undefined";
  const hasDocument = typeof document !== "undefined";
  if (hasWindow) window.addEventListener("online", onOnline);
  if (hasDocument) document.addEventListener("visibilitychange", onVisibilityChange);

  triggerTeardown = () => {
    if (hasWindow) window.removeEventListener("online", onOnline);
    if (hasDocument) document.removeEventListener("visibilitychange", onVisibilityChange);
    if (autoRetryTimer !== null) {
      clearTimeout(autoRetryTimer);
      autoRetryTimer = null;
    }
    hiddenSince = null;
    triggerTeardown = null;
  };

  return triggerTeardown;
}

// ---------------------------------------------------------------------------
// One-shot operations (Req 10.9, 10.10, 13.13, 17.4, 17.5)
//
// Two operations that are not Sync_Cycles and are not triggered by one:
//
//   - `enqueueEntireLocalStore()` — the recovery half of Requirements 10.9 and
//     13.13. It writes ids to the Outbox and nothing else: no request, no cursor
//     write, no Local_Store write. Whoever calls it decides when the push happens,
//     which is what lets Requirement 13.13's "push those ids before advancing the
//     Sync_Cursor" be an ordering the caller controls.
//   - `deleteCloudCopy()` — Requirement 17.4's cloud-only deletion, plus the
//     Requirement 17.5 local clean-up that follows a success.
//
// Both are deliberately outside the single-flight. Neither runs a Sync_Cycle, so
// neither can collapse into one or become a queued rerun; `deleteCloudCopy`
// interacts with an in-flight cycle only through the enabled state it clears,
// which the mid-cycle guard reads before the cycle's next request (Req 13.1).
// ---------------------------------------------------------------------------

/**
 * Place the id of every Log_Event and Tombstone the Local_Store holds into the
 * Outbox, and report how many ids that was.
 *
 * The two callers, and why they need the same thing:
 *
 * - **First enable on a device holding local data** (Req 10.9). The Sync_Cursor
 *   has no stored value, so the cloud holds nothing this device knows about; the
 *   ids must be queued *before the first push phase runs* or the local timeline
 *   would only ever reach the cloud one later edit at a time. The Log_Events
 *   themselves stay in the Local_Store until the Sync_Service acknowledges each
 *   Event_Record as stored, which falls out of the Outbox contract: an id leaves
 *   only on a `stored` outcome or a permanent rejection (Req 6.6, 19.9), and no
 *   path here or in the push phase writes to `events`.
 * - **Cursor-invalid recovery** (Req 13.13), through `recoverFromCursorReset`.
 *
 * Requirement 10.10 is the empty case and it is a genuine no-op: an empty
 * Local_Store queues zero ids, so the first Sync_Cycle after enabling sends zero
 * Event_Records, and nothing here creates a Tombstone for a stored Event_Record
 * the Local_Store does not hold. Absence of a local record is not evidence of a
 * deletion — a device that has never pulled holds nothing at all — so deriving
 * deletions from it would empty the cloud on first enable.
 *
 * An id already queued keeps its original `queuedAt` (`db.enqueueIds`), so a bulk
 * enqueue never pushes work that has been waiting longer to the back of the
 * queue. Calling this while a cursor *is* stored is therefore harmless rather
 * than forbidden: it re-pushes records the cloud already holds, and push is
 * idempotent (Req 6.5).
 *
 * Rejects when the Outbox write fails. The caller decides what that means —
 * `recoverFromCursorReset` treats it as a failed Sync_Cycle, which leaves the
 * cursor unset so the next cycle starts the recovery over.
 */
export async function enqueueEntireLocalStore(): Promise<number> {
  const records = await getAllRecords();
  const ids: string[] = [];
  for (const record of records) {
    // A stored row with no usable id could not be pushed and could not be
    // reconciled, so it is not queued.
    if (typeof record.id === "string" && record.id.length > 0) ids.push(record.id);
  }

  // Req 10.10 — zero Log_Events and zero Tombstones queues zero ids.
  if (ids.length === 0) return 0;

  await enqueueIds(ids);
  // Req 12.2 — the pending count the status line shows has changed.
  await refreshOutboxCount();
  return ids.length;
}

/** What `deleteCloudCopy` did, for the Settings row that offers the retry. */
export interface DeleteCloudCopyResult {
  /** True only when the Sync_Service reported the deletion as complete. */
  ok: boolean;
  /** Event_Records and Tombstones the Sync_Service reported deleting. */
  deleted: number;
  /** Why the request failed, or `null` on success. */
  failure: SyncFailure | null;
  /**
   * True when the Outbox was emptied and the Sync_Cursor reset (Req 17.5), false
   * when one of those local writes failed. The destination is disabled either
   * way, so a failed clean-up cannot lead to a re-upload: Requirement 11.6
   * discards every trigger while the destination is disabled.
   */
  localCleared: boolean;
}

/**
 * Delete the cloud copy while keeping the account (Req 17.4), then apply the
 * local consequences of a success (Req 17.5).
 *
 * `DELETE /api/sync/data` is the one sync route that sits behind authentication
 * but *not* behind the Pro gate, so a lapsed user can still remove what the
 * Sync_Service holds. On a success the Sync_Service has deleted every stored
 * Event_Record and Tombstone for the user and bumped the purge generation, which
 * is what makes this device's old cursor report invalid rather than silently
 * matching nothing.
 *
 * The local half, in this order and for this reason:
 *
 * 1. **Disable the Cloud_Destination.** First, because it is what stops further
 *    Sync_Cycles: `requestSync` discards every trigger while the destination is
 *    disabled (Req 11.6) and an in-flight cycle stops before its next request
 *    (Req 13.1). Doing this last would leave a window in which a cycle could
 *    re-upload the Outbox into the emptied cloud.
 * 2. **Empty the Outbox**, so no Log_Event is re-uploaded by a later Sync_Cycle
 *    (Req 17.5). Both writes are issued immediately and IndexedDB has no queue to
 *    wait behind here, so the 1-second bound holds without a timer.
 * 3. **Reset the Sync_Cursor** to no stored value, so a later re-enable pulls
 *    from the beginning of a cloud that starts empty.
 *
 * What is deliberately *not* touched: the `events` store. Every Log_Event, every
 * Tombstone, and every Photo stays exactly as it was (Req 17.5) — this function
 * never opens that store. The Session_Token and the Pro_Entitlement are likewise
 * untouched, which is the difference between this and account deletion.
 *
 * On a failure nothing local changes at all: the destination stays enabled, the
 * Outbox keeps every id, and the cursor stays where it was, so the Settings row
 * can repeat the request against an unchanged device.
 */
export async function deleteCloudCopy(): Promise<DeleteCloudCopyResult> {
  const res = await syncRequest<{ deleted?: unknown }>("DELETE", CLOUD_DATA_PATH);
  if (!res.ok) {
    return { ok: false, deleted: 0, failure: res.failure, localCleared: false };
  }

  // Req 17.5 — disable first, so no trigger and no in-flight cycle can re-upload.
  setDestinationEnabled("cloud", false);

  let localCleared = true;
  try {
    await clearOutbox();
  } catch {
    localCleared = false;
  }
  try {
    await setMeta("cursor", null);
  } catch {
    localCleared = false;
  }

  await refreshOutboxCount();
  return {
    ok: true,
    deleted: normalizeCount(res.body.deleted),
    failure: null,
    localCleared,
  };
}

// ---- Test support --------------------------------------------------------

/**
 * Drop the shell's in-memory state: the runtime flags, the mirrored durable
 * values, the memoized hydration, every subscriber, and the `syncSettings`
 * bridge. Nothing persisted is touched — clear the IndexedDB `meta` store for
 * that. Test-only.
 */
export function resetCloudSyncForTests(): void {
  runtime = initialRuntime();
  persisted = initialPersisted();
  hydratePromise = null;
  stateListeners.clear();
  changeListeners.clear();
  if (settingsUnsubscribe !== null) {
    settingsUnsubscribe();
    settingsUnsubscribe = null;
  }
  if (triggerTeardown !== null) triggerTeardown();
  // A fresh scheduler, so a cycle left in flight by one test cannot become the
  // queued rerun of the next.
  cycleScheduler = null;
  cycleGuardArmed = false;
}
