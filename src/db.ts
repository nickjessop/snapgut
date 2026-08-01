import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import type { Severity } from "./symptoms";

// The pure half of `cloudSync.ts`: the wire codec and the merge rule, which
// `mergePulledPage` below evaluates inside its transaction. `cloudSync.ts`
// imports this module in turn, so the two form an import cycle — a benign one,
// because neither module calls into the other while it is being evaluated: every
// use is inside a function body.
import { fromEventRecord, mergeRecords } from "./cloudSync";

export interface LoggedSymptom {
  id: string; // SymptomDef id
  severity: Severity;
}

/**
 * Confidence in an ingredient:
 * - "confident": clearly visible in the photo, or explicitly named by the user.
 * - "maybe": inferred from the dish/context (e.g. instant ramen → likely wheat,
 *   palm oil, MSG). Weaker signal for pattern-finding.
 */
export type Confidence = "confident" | "maybe";

export interface Ingredient {
  name: string;
  confidence: Confidence;
  /**
   * Canonical food id from the server-side dictionary (server/food-dict.json),
   * resolved at recognition time. The join key for the illustration pack, food
   * scoring and trigger tags. Absent on foods outside the dictionary, and on events
   * logged before the dictionary existed — callers must fall back to `name`.
   */
  canonical?: string;
  /** Trigger/FODMAP groups for this food, from the dictionary (see fodmap.ts). */
  tags?: string[];
}

export interface MealAnalysis {
  dish: string;
  ingredients: Ingredient[];
}

// ---- Event model ----
// Everything is a timestamped event on one timeline. Meals and symptoms are
// logged independently because symptoms often occur hours after eating.

export interface BaseEvent {
  id: string;
  createdAt: number; // epoch ms — when the thing actually happened
  /**
   * Revision_Time (Req 5.1): epoch ms of the last create/edit/delete on the
   * device that made the change. Required, not optional: the merge rule
   * (Req 8) must be total and deterministic, and the v2→v3 migration
   * guarantees every stored record carries one, so it never sees a missing
   * revision.
   */
  updatedAt: number;
  note?: string;
  /** Wire fields from a newer schemaVersion, preserved verbatim (Req 16.4, 16.9). */
  unknownFields?: Record<string, unknown>;
}

export interface MealEvent extends BaseEvent {
  type: "meal";
  dish: string;
  ingredients: Ingredient[];
  photo?: Blob; // on-device only
}

export interface SymptomEvent extends BaseEvent {
  type: "symptom";
  symptoms: LoggedSymptom[];
}

export interface BowelEvent extends BaseEvent {
  type: "bowel";
  bristol: number; // Bristol Stool Scale 1–7
  symptoms?: LoggedSymptom[]; // optional (e.g. urgency)
}

export type StressLevel = "low" | "medium" | "high";
export type SleepQuality = "poor" | "ok" | "good";

// Gut-brain axis: stress and sleep influence gut symptoms, so we capture them
// as their own lightweight check-in event.
export interface CheckinEvent extends BaseEvent {
  type: "checkin";
  stress?: StressLevel;
  sleep?: SleepQuality;
}

export type LogEvent = MealEvent | SymptomEvent | BowelEvent | CheckinEvent;

/**
 * A deletion marker (Req 5.3, 9.1): identity and revision only, no content.
 * Tombstones live in the `events` store alongside real events, discriminated
 * by `deleted === true`, so one lookup answers "what do I hold for this id".
 */
export interface Tombstone {
  id: string;
  type: LogEvent["type"];
  createdAt: number;
  updatedAt: number;
  deleted: true;
  unknownFields?: Record<string, unknown>;
}

/** What the `events` object store actually holds. */
export type StoredRecord = LogEvent | Tombstone;

export function isTombstone(r: StoredRecord): r is Tombstone {
  return (r as Tombstone).deleted === true;
}

/**
 * An event as a caller builds it, before a Revision_Time is assigned: the input
 * shape of `putEvent`.
 *
 * The log flows and a reconstructed spreadsheet row have no revision to offer —
 * `putEvent` owns that assignment (Req 5.2, 5.8) — while a stored `LogEvent` is
 * assignable to this type, so an edit of an existing event passes through
 * unchanged.
 */
export type DraftEvent =
  | Omit<MealEvent, "updatedAt">
  | Omit<SymptomEvent, "updatedAt">
  | Omit<BowelEvent, "updatedAt">
  | Omit<CheckinEvent, "updatedAt">;

// ---- Helpers ----

export function confidentNames(e: MealEvent): string[] {
  return e.ingredients.filter((i) => i.confidence === "confident").map((i) => i.name);
}

/** Confident ingredients with their canonical ids/tags intact (for grouping). */
export function confidentIngredients(e: MealEvent): Ingredient[] {
  return e.ingredients.filter((i) => i.confidence === "confident");
}

/**
 * Stable grouping key for a food: the canonical dictionary id when recognition
 * resolved one, else a normalised form of the raw name. Keeps "Tomato"/"Tomatoes"
 * (and legacy events with no canonical id) from splitting into separate foods.
 */
export function foodKey(i: Ingredient): string {
  return i.canonical || i.name.trim().toLowerCase();
}
export function allNames(e: MealEvent): string[] {
  return e.ingredients.map((i) => i.name);
}

// ---- IndexedDB ----

export interface FoodSnapDB extends DBSchema {
  events: {
    key: string;
    value: StoredRecord; // LogEvent | Tombstone
    indexes: { "by-createdAt": number; "by-updatedAt": number };
  };
  outbox: {
    key: string;
    value: { id: string; queuedAt: number };
    indexes: { "by-queuedAt": number };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

export const DB_NAME = "food-snap";
export const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<FoodSnapDB>> | null = null;

/**
 * Set when a schema upgrade transaction was observed aborting in this session.
 *
 * Requirement 5.9's retry-on-next-launch falls out of IndexedDB itself: an
 * aborted upgrade aborts the version bump with it, so the database stays at its
 * previous version with its data intact and the next `openDB` retries the same
 * upgrade. This flag exists purely so the UI can say the upgrade didn't
 * complete — no extra bookkeeping is stored.
 */
let upgradeFailed = false;

/** True when the schema upgrade did not complete in this session (Req 5.9). */
export function didUpgradeFail(): boolean {
  return upgradeFailed;
}

/** The abort itself is what matters; the rejection is recorded by the caller. */
function noop(): void {}

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<FoodSnapDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        // v1 stored a single "entries" store; the event model replaces it.
        if (oldVersion < 2 && db.objectStoreNames.contains("entries" as never)) {
          db.deleteObjectStore("entries" as never);
        }
        if (!db.objectStoreNames.contains("events")) {
          const store = db.createObjectStore("events", { keyPath: "id" });
          store.createIndex("by-createdAt", "createdAt");
        }

        if (oldVersion < 3) {
          const events = tx.objectStore("events");
          if (!events.indexNames.contains("by-updatedAt")) {
            events.createIndex("by-updatedAt", "updatedAt");
          }
          if (!db.objectStoreNames.contains("outbox")) {
            const outbox = db.createObjectStore("outbox", { keyPath: "id" });
            outbox.createIndex("by-queuedAt", "queuedAt");
          }
          if (!db.objectStoreNames.contains("meta")) {
            db.createObjectStore("meta", { keyPath: "key" });
          }

          // Backfill (Req 5.4, 5.5): walk the existing records and rewrite each
          // one in place with `cursor.update(...)`, so the photo Blob and every
          // other pre-existing field is carried through untouched and no record
          // is recreated. This runs inside the same upgrade transaction, so a
          // failure aborts the version bump and leaves v2 data exactly as it
          // was, to be retried on the next launch (Req 5.9).
          if (oldVersion >= 2) {
            const upgradeClock = Date.now();
            void (async () => {
              let cursor = await events.openCursor();
              while (cursor) {
                const record = cursor.value as StoredRecord & { updatedAt?: unknown };
                if (typeof record.updatedAt !== "number") {
                  const createdAt: unknown = record.createdAt;
                  const updatedAt = Number.isInteger(createdAt)
                    ? (createdAt as number)
                    : upgradeClock;
                  // Not awaited: the write stays inside this transaction and a
                  // failure aborts it, which is exactly the wanted outcome.
                  void cursor.update({ ...record, updatedAt } as StoredRecord).catch(noop);
                }
                cursor = await cursor.continue();
              }
            })().catch(() => {
              // The failing request aborts the upgrade transaction, which
              // rejects `openDB` below; record it for the UI (Req 5.9).
              upgradeFailed = true;
            });
          }
        }
      },
    });

    dbPromise = dbPromise.catch((err) => {
      // An aborted upgrade rejects `openDB`; the stored version is unchanged so
      // the next launch retries it (Req 5.9). Reset the memo so a later call in
      // this session can retry too.
      upgradeFailed = true;
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// ---- writes ----

/**
 * Revision_Time assignment (Req 5.8): the clock proposes, the stored value
 * vetoes. A device clock that jumps backwards or repeats would otherwise let a
 * newer write lose the merge (Req 8.1) against the version it replaced, so a
 * write whose clock is not strictly ahead of what is already stored takes
 * `stored + 1` instead. Pure, with the clock injected, so it is testable
 * against adversarial clock sequences.
 */
export function nextRevisionTime(now: number, stored: number | undefined): number {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return now;
  return now <= stored ? stored + 1 : now;
}

export interface PutOptions {
  /** Assign a fresh monotonic updatedAt (default true; false for photo attach, Req 10.7). */
  touch?: boolean;
  /** Record the id in the Outbox (default true; Req 4.6). */
  enqueue?: boolean;
  /** Injected clock; defaults to Date.now(). */
  now?: number;
}

/**
 * One `readwrite` transaction over both stores, so the event and its Outbox
 * entry commit together or not at all (Req 4.6). `idb` keeps a transaction
 * alive across awaits on its own requests, so every write below stays inside
 * this one transaction.
 *
 * On abort the transaction leaves `events` and `outbox` untouched and the
 * rejection is rethrown naming the id, so the caller can report which save
 * failed and keep the entered content (Req 4.9).
 */
async function writeInOneTransaction(
  id: string,
  write: (tx: IDBPTransaction<FoodSnapDB, ["events", "outbox"], "readwrite">) => Promise<void>,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["events", "outbox"], "readwrite");
  try {
    await write(tx);
    await tx.done;
  } catch (err) {
    // `idb` creates `tx.done` as soon as the transaction is wrapped, and this
    // path never awaits it, so claim its rejection here — otherwise an abort
    // surfaces as an unhandled promise rejection alongside the error below.
    tx.done.catch(noop);
    // An already-aborted transaction throws on abort(); the store contents are
    // unchanged either way, which is what Req 4.9 asks for.
    try {
      tx.abort();
    } catch {
      // already aborted
    }
    const failure = new Error(`Failed to write event ${id}`);
    // `cause` is set by hand: the tsconfig lib predates the Error options bag.
    (failure as Error & { cause?: unknown }).cause = err;
    throw failure;
  }
}

/**
 * Create or edit a Log_Event. Returns the assigned Revision_Time.
 *
 * The content, the Revision_Time, and the Outbox entry all land in one durable
 * transaction (Req 4.6, 5.2). The Outbox is keyed by id, so a repeat write to
 * the same id replaces its entry rather than adding a second one (Req 4.6:
 * at most one entry per id). Enqueuing is unconditional on the destination
 * being enabled or on Pro, so an id logged today still syncs whenever the
 * destination is turned on.
 */
export async function putEvent(
  event: LogEvent | DraftEvent,
  opts: PutOptions = {},
): Promise<number> {
  const { touch = true, enqueue = true, now = Date.now() } = opts;
  let assigned = (event as LogEvent).updatedAt;

  await writeInOneTransaction(event.id, async (tx) => {
    const events = tx.objectStore("events");
    if (touch) {
      const existing = await events.get(event.id);
      assigned = nextRevisionTime(now, existing?.updatedAt);
    } else if (typeof assigned !== "number") {
      // Nothing to carry over and nothing to assign: fall back to whatever is
      // stored, else the clock, so the record never lands without a revision.
      const existing = await events.get(event.id);
      assigned = existing?.updatedAt ?? now;
    }
    await events.put({ ...event, updatedAt: assigned } as StoredRecord);
    if (enqueue) {
      await tx.objectStore("outbox").put({ id: event.id, queuedAt: now });
    }
  });

  return assigned as number;
}

/**
 * Attach a Photo from a Manual_Backup import (Req 10.7): the photo is the only
 * field that changes, so this leaves the Revision_Time alone and adds nothing
 * to the Outbox — a photo is on-device-only data and must not look like a new
 * revision to the merge rule or to sync.
 *
 * A missing id or a tombstoned id is a no-op: there is no content to attach to,
 * and resurrecting a deleted record from a photo would defeat the tombstone.
 */
export async function attachPhoto(id: string, photo: Blob): Promise<void> {
  await writeInOneTransaction(id, async (tx) => {
    const events = tx.objectStore("events");
    const existing = await events.get(id);
    if (!existing || isTombstone(existing) || existing.type !== "meal") return;
    await events.put({ ...existing, photo });
  });
}

/**
 * Unchanged contract: real events only, newest first. Tombstones are filtered
 * out so no existing consumer needs to learn about them (Req 9.6).
 *
 * The filter is what keeps a tombstoned id out of the timeline, out of every
 * derived statistic, and out of CSV export without a Sync_Cycle having to run
 * first: every one of those consumers reads the store through here.
 */
export async function getEvents(): Promise<LogEvent[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("events", "by-createdAt");
  const events = all.filter((r): r is LogEvent => !isTombstone(r));
  return events.reverse(); // newest first
}

/**
 * Raw access for sync: events *and* tombstones, unordered.
 *
 * Sync needs the tombstones `getEvents` hides — a deletion only propagates if
 * the push phase can see it — so the raw reads are separate functions rather
 * than a flag on `getEvents`, leaving that contract untouched (Req 9.6).
 */
export async function getAllRecords(): Promise<StoredRecord[]> {
  const db = await getDB();
  return db.getAll("events");
}

/** Raw single-record read: the event, the tombstone, or nothing (Req 8.4). */
export async function getRecord(id: string): Promise<StoredRecord | undefined> {
  const db = await getDB();
  return db.get("events", id);
}

/**
 * Delete a Log_Event. Returns the Tombstone's Revision_Time.
 *
 * Content removal and the Tombstone write happen in one transaction over one
 * key (Req 5.3): `put` of the Tombstone replaces the record in place, so the
 * content, the note text, every type-specific field, and the photo Blob all go
 * with it and the store is left holding exactly one entry for the id — never
 * both, never neither. The Outbox entry rides the same transaction (Req 4.6) so
 * the deletion propagates.
 *
 * Deleting an id that is already a tombstone, or that was never present, still
 * writes a tombstone: the other device may hold content for it.
 */
export async function deleteEvent(id: string, opts: { now?: number } = {}): Promise<number> {
  const { now = Date.now() } = opts;
  let assigned = now;

  await writeInOneTransaction(id, async (tx) => {
    const events = tx.objectStore("events");
    const existing = await events.get(id);
    assigned = nextRevisionTime(now, existing?.updatedAt);
    const tombstone: Tombstone = {
      id,
      type: existing?.type ?? "meal",
      createdAt: existing?.createdAt ?? now,
      updatedAt: assigned,
      deleted: true,
      ...(existing?.unknownFields ? { unknownFields: existing.unknownFields } : {}),
    };
    await events.put(tombstone);
    await tx.objectStore("outbox").put({ id, queuedAt: now });
  });

  return assigned;
}

// ---- pull merge (Req 7.3, 7.4, 7.6, 7.7, 7.9, 9.3, 9.4, 20.5) ----

/** What one merged page did. */
export interface MergePageResult {
  /** Records that went through the merge rule — every record except the skipped. */
  merged: number;
  /** Records skipped as malformed, which the cursor still advances past (Req 20.5). */
  skipped: number;
  /** Ids whose stored record actually changed, for the Req 7.10 / 9.4 refresh. */
  changedIds: string[];
}

/**
 * Retain the Photo the Local_Store already holds (Req 7.7).
 *
 * A Photo is on-device-only data that no Event_Record carries, so a pulled record
 * winning the merge would otherwise silently drop it. It is carried across only
 * when the winner is a `meal` event and the local entry was a `meal` event
 * holding one; a *winning Tombstone* is written as-is, which is what removes the
 * content and the Photo together (Req 9.3), and Requirement 10.4's "no `photo`
 * field" case is the same code path with nothing to carry.
 */
function withRetainedPhoto(winner: StoredRecord, local: StoredRecord | null): StoredRecord {
  if (local === null) return winner;
  if (isTombstone(winner) || winner.type !== "meal") return winner;
  if (isTombstone(local) || local.type !== "meal" || local.photo === undefined) return winner;
  return { ...winner, photo: local.photo };
}

/**
 * Merge one pulled page into the Local_Store and commit the Sync_Cursor with it.
 *
 * The page and the cursor share **one** `readwrite` transaction over `events` and
 * `meta` (Req 7.3, 7.4). That is the whole point of this function: the cursor can
 * never end up ahead of a record that was not merged, because there is no instant
 * at which one is durable and the other is not. A transaction that aborts leaves
 * both the merged records and the cursor exactly as the previous page left them
 * (Req 7.5), and the caller — which only issues the next pull request after this
 * promise resolves — retries the same page on the next Sync_Cycle.
 *
 * Per record, in the order the page delivered them (ascending Server_Sequence):
 *
 * - `fromEventRecord` returning `null` is a **skipped** record, not a failure: the
 *   Local_Store is left unchanged for that `id`, the remaining records are still
 *   merged, and the cursor still advances past it so it is never re-fetched
 *   (Req 20.3, 20.4, 20.5).
 * - `mergeRecords(local, pulled)` decides the winner, with the local entry passed
 *   first so a tie — two records equal in every field the ordering can see —
 *   retains the local one. That is what makes re-merging the same page a no-op:
 *   no write, no `changedIds` entry, and the Photo untouched (Req 7.6).
 * - the local entry winning writes nothing at all, leaving its Photo and the
 *   Outbox alone while the cursor advances as for a merged record (Req 7.9).
 *
 * The Outbox is never touched here. A pulled record came *from* the Sync_Service,
 * so queueing it would push it straight back; and Requirement 7.9 says as much
 * for the discarded case.
 *
 * `changedIds` names the ids whose stored record actually changed, which is what a
 * caller uses to refresh the timeline and the derived statistics within the 2
 * seconds Requirements 7.10 and 9.4 allow. `getEvents()` already filters
 * Tombstones, so a merged Tombstone drops out of both by being written.
 */
export async function mergePulledPage(
  records: unknown[],
  cursorAfterPage: string,
): Promise<MergePageResult> {
  const db = await getDB();
  const tx = db.transaction(["events", "meta"], "readwrite");
  const result: MergePageResult = { merged: 0, skipped: 0, changedIds: [] };

  try {
    const events = tx.objectStore("events");
    for (const raw of records) {
      const pulled = fromEventRecord(raw);
      if (pulled === null) {
        result.skipped++; // Req 20.3, 20.4 — skipped, and the cursor still advances
        continue;
      }
      result.merged++;
      const local = (await events.get(pulled.id)) ?? null;
      const winner = mergeRecords(local, pulled);
      // Reference equality, not deep equality: `mergeRecords` returns one of its
      // two arguments, so this is exactly "the local entry was retained".
      if (winner === local) continue; // Req 7.6, 7.9 — nothing to write
      await events.put(withRetainedPhoto(winner as StoredRecord, local));
      result.changedIds.push(pulled.id);
    }

    // Committed by the same transaction as the merges above (Req 7.4).
    await tx.objectStore("meta").put({ key: "cursor", value: cursorAfterPage });
    await tx.done;
  } catch (err) {
    // See `writeInOneTransaction`: claim `tx.done`'s rejection and force the
    // abort, so a failed page leaves the store and the cursor as they were.
    tx.done.catch(noop);
    try {
      tx.abort();
    } catch {
      // already aborted
    }
    const failure = new Error("Failed to merge pulled page");
    (failure as Error & { cause?: unknown }).cause = err;
    throw failure;
  }

  return result;
}

// ---- outbox ----

/**
 * The oldest `limit` queued ids, ascending by `queuedAt` (Req 6.2's batching
 * reads the head of the queue). Ties on `queuedAt` — a re-enqueue of the whole
 * store stamps one clock value on every id — fall back to the index's own
 * primary-key order, so the batch boundary is deterministic across calls rather
 * than depending on insertion order.
 */
export async function getOutboxBatch(limit: number): Promise<string[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const db = await getDB();
  const ids: string[] = [];
  let cursor = await db.transaction("outbox").store.index("by-queuedAt").openCursor();
  while (cursor && ids.length < limit) {
    ids.push(cursor.value.id);
    cursor = await cursor.continue();
  }
  return ids;
}

/** How many ids are waiting to sync — drives the `pending` Sync_State (Req 12.3). */
export async function getOutboxCount(): Promise<number> {
  const db = await getDB();
  return db.count("outbox");
}

/**
 * Drop acknowledged ids (Req 6.6). One transaction, so a partially applied
 * response never leaves the Outbox in a state no single push produced. Ids that
 * are not queued are skipped silently: `delete` on an absent key is a no-op,
 * which is what makes reconciling the same response twice harmless.
 */
export async function removeOutboxIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDB();
  const tx = db.transaction("outbox", "readwrite");
  for (const id of ids) {
    await tx.store.delete(id);
  }
  await tx.done;
}

/**
 * Queue ids for the next Sync_Cycle (Req 10.9, 13.13: re-upload the whole
 * timeline after a restore or an invalidated cursor).
 *
 * An id already in the Outbox keeps its original `queuedAt`, so a bulk enqueue
 * cannot push work that has been waiting longer to the back of the queue, and
 * the store still holds at most one entry per id.
 */
export async function enqueueIds(ids: string[], opts: { now?: number } = {}): Promise<void> {
  if (ids.length === 0) return;
  const { now = Date.now() } = opts;
  const db = await getDB();
  const tx = db.transaction("outbox", "readwrite");
  for (const id of ids) {
    const existing = await tx.store.get(id);
    if (!existing) await tx.store.put({ id, queuedAt: now });
  }
  await tx.done;
}

/**
 * Empty the Outbox (Req 17.5): after the cloud copy is deleted, nothing local
 * may be re-uploaded by a later Sync_Cycle. The Local_Store is untouched — the
 * events and their photos stay on the device.
 */
export async function clearOutbox(): Promise<void> {
  const db = await getDB();
  await db.clear("outbox");
}

// ---- meta (cursor, timestamps, counters) ----

export type MetaKey =
  | "cursor"
  | "lastSyncAt"
  | "lastSkipped"
  | "lastTombstoneSweepAt"
  /**
   * Past AI insights, newest first. Kept in `meta` rather than in a store of their
   * own so this needs no schema version bump: they are a bounded list of small text
   * records, not a queryable collection, and `meta` is exactly the place for that.
   *
   * They also stay local by consequence rather than by accident — the Sync_Service
   * carries `events`, never `meta`, so a narrative generated on one device does not
   * travel to another. That is the conservative default for text derived from a
   * health log.
   */
  | "insightHistory";

export async function getMeta<T>(key: MetaKey): Promise<T | undefined> {
  const db = await getDB();
  const row = await db.get("meta", key);
  return row ? (row.value as T) : undefined;
}

export async function setMeta(key: MetaKey, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put("meta", { key, value });
}

// ---- maintenance ----

/** Tombstone retention window (Req 5.6, 9.7): 180 days. */
export const TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Delete every Tombstone whose Revision_Time is more than 180 days behind the
 * clock **and** whose id is absent from the Outbox; retain every other
 * Tombstone (Req 5.6). Returns how many were deleted.
 *
 * The Outbox check is the important half: a Tombstone still queued has not been
 * acknowledged by the Sync_Service, so sweeping it would drop the deletion and
 * let the other device's copy come back on the next pull. Reading the Outbox
 * and deleting from `events` share one transaction, so an id enqueued
 * concurrently cannot slip past the check.
 *
 * Runs over the `by-updatedAt` index bounded to the expired range, so the cost
 * tracks the number of expired records rather than the size of the timeline.
 */
export async function sweepTombstones(now: number = Date.now()): Promise<number> {
  const db = await getDB();
  const tx = db.transaction(["events", "outbox"], "readwrite");
  const queued = new Set<string>(await tx.objectStore("outbox").getAllKeys());
  // Exclusive bound: "more than 180 days earlier" keeps a Tombstone sitting
  // exactly on the boundary.
  const expired = IDBKeyRange.upperBound(now - TOMBSTONE_RETENTION_MS, true);

  let deleted = 0;
  let cursor = await tx.objectStore("events").index("by-updatedAt").openCursor(expired);
  while (cursor) {
    const record = cursor.value;
    if (isTombstone(record) && !queued.has(record.id)) {
      await cursor.delete();
      deleted++;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}

// ---- CSV export (unified timeline) ----

export function toCSV(events: LogEvent[], labelFor: (id: string) => string): string {
  const header = [
    "datetime",
    "type",
    "dish",
    "confident_ingredients",
    "maybe_ingredients",
    "symptoms",
    "bristol",
    "stress",
    "sleep",
    "note",
  ];

  const symptomsText = (syms?: LoggedSymptom[]) =>
    (syms ?? []).map((s) => `${labelFor(s.id)} (${s.severity})`).join("; ");

  const rows = events.map((e) => {
    const dt = new Date(e.createdAt).toISOString();
    let dish = "";
    let confident = "";
    let maybe = "";
    let symptoms = "";
    let bristol = "";
    let stress = "";
    let sleep = "";

    if (e.type === "meal") {
      dish = e.dish;
      confident = e.ingredients.filter((i) => i.confidence === "confident").map((i) => i.name).join("; ");
      maybe = e.ingredients.filter((i) => i.confidence === "maybe").map((i) => i.name).join("; ");
    } else if (e.type === "symptom") {
      symptoms = symptomsText(e.symptoms);
    } else if (e.type === "bowel") {
      bristol = String(e.bristol);
      symptoms = symptomsText(e.symptoms);
    } else if (e.type === "checkin") {
      stress = e.stress ?? "";
      sleep = e.sleep ?? "";
    }

    return [dt, e.type, dish, confident, maybe, symptoms, bristol, stress, sleep, e.note ?? ""].map(csvEscape);
  });

  return [header, ...rows].map((r) => r.join(",")).join("\r\n");
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
