// Property 13: Sync is idempotent in both directions — the **push** half.
//
// Validates: Requirements 6.5
//
// (The merge half — pulling and merging the same page twice, Req 7.6 — lands
// with the I/O shell in task 14.4.)
//
// Requirement 6.5 is about a push that carries nothing new: the same payload
// arriving again with no intervening change to the stored Event_Records must
// leave exactly one stored record per `id`, with every field other than
// Server_Sequence equal to its value after the first request. That makes a
// retry after a timeout, a duplicated request, or a client that re-sends an
// Outbox entry it never got an acknowledgement for harmless.
//
// Three behaviors of `server/eventStore.js` are what the property leans on:
//
//   - Only a **changed** record is written, and only a written record takes a
//     new Server_Sequence. So a repeated payload assigns none at all and
//     reports `highestSequence: null`.
//   - Every `id` in a payload is acknowledged `stored` (Req 6.11), including
//     one whose pushed record *loses* the merge — which is exactly what every
//     record does on the second push (Req 9.5, 9.8).
//   - The clock clamp of Requirement 8.8 pulls against idempotence: a
//     far-future Revision_Time is stored as the server clock, and the clock
//     moves between requests. The store keeps the clamped-from value beside the
//     record so re-sending the identical far-future payload is recognized as a
//     re-send rather than stored as a fresh revision. The second test below is
//     that case, driven with a **different** server clock on each push.
//
// Stored state is read back through `pull`, which is how a client observes it —
// and which carries no `seq`, so deep-equality over a pulled page is exactly
// "every field other than Server_Sequence" (Req 8.9).
//
// The payloads are wire Event_Records built with `toEventRecord`, the same
// projection a real client pushes: unknown fields inline, no `unknownFields`
// container, and never a photo.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toEventRecord } from "./cloudSync";
import type { StoredRecord } from "./db";
import { arbStoredRecords, MAX_EPOCH_MS, type SyncStoredRecord } from "./test/arbitraries";

// The Sync_Service is plain ESM JavaScript with no type declarations, so the
// module is imported untyped and given the local shape below.
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { MAX_CLOCK_SKEW_MS, createMemoryEventStore } from "../server/eventStore.js";

// ---------------------------------------------------------------------------
// Local typing of the untyped server module
// ---------------------------------------------------------------------------

/** A wire Event_Record, as the server stores and serves it. */
type WireRecord = Record<string, unknown>;

interface PushResult {
  outcomes: { id: string; outcome: string }[];
  stored: number;
  highestSequence: number | null;
}

interface PullPage {
  cursorInvalid: boolean;
  records: WireRecord[];
  cursor: string | null;
  hasMore: boolean;
}

interface EventStore {
  push(email: string, records: WireRecord[], now?: number): Promise<PushResult>;
  pull(email: string, cursor?: string | null, limit?: number, now?: number): Promise<PullPage>;
  countFor(email: string, now?: number): Promise<number>;
  getMeta(email: string): Promise<{ seq: number; epoch: number }>;
}

const newEventStore = createMemoryEventStore as () => EventStore;
/** Req 8.8 — one day of tolerated clock skew. */
const CLOCK_SKEW_MS = MAX_CLOCK_SKEW_MS as number;

const EMAIL = "idempotence@example.com";
const PAGE = 500;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

interface Payload {
  /** The records sent, in send order. An `id` may repeat verbatim. */
  records: WireRecord[];
  /** The distinct ids the payload carries. */
  ids: string[];
}

function wireOf(r: SyncStoredRecord): WireRecord {
  return toEventRecord(r as StoredRecord) as WireRecord;
}

/** A separate object carrying equal content — a re-send, not the same reference. */
function copyWire(r: WireRecord): WireRecord {
  return JSON.parse(JSON.stringify(r)) as WireRecord;
}

/**
 * One push payload.
 *
 * A record appears once per `id`, which is what `planPush` on the client
 * produces — one Event_Record per Outbox id. `repeats` then re-sends some of
 * those records verbatim inside the same payload, so the "a payload repeating
 * an `id` reports it once" path is covered too.
 */
const arbPayload: fc.Arbitrary<Payload> = fc
  .tuple(arbStoredRecords, fc.array(fc.nat({ max: 2 }), { maxLength: 25 }))
  .map(([records, repeats]) => {
    const seen = new Set<string>();
    const out: WireRecord[] = [];
    records.forEach((record, i) => {
      if (seen.has(record.id)) return;
      seen.add(record.id);
      const wire = wireOf(record);
      out.push(wire);
      for (let n = 0; n < (repeats[i] ?? 0); n += 1) out.push(copyWire(wire));
    });
    return { records: out, ids: [...seen] };
  });

function clampClock(v: number): number {
  return Math.max(0, Math.min(MAX_EPOCH_MS, Math.trunc(v)));
}

/**
 * Three server-clock readings, one per push, derived from the payload's own
 * Revision_Times.
 *
 * Anchoring the clock to the payload keeps two unrelated behaviors out of the
 * way. A clock far *behind* the records means every record is clock-clamped
 * (Req 8.8), a clock at or ahead of them means none is, and offsets in between
 * mix the two — while staying well inside the 180-day tombstone retention
 * window (Req 9.7), so no record is swept out from under the assertions.
 */
const CLOCK_OFFSETS: readonly number[] = [
  -(CLOCK_SKEW_MS * 4), // every record far-future → clamped
  -(CLOCK_SKEW_MS + 1),
  -(CLOCK_SKEW_MS / 2), // inside the tolerance → not clamped
  0,
  1_000,
  CLOCK_SKEW_MS,
  CLOCK_SKEW_MS * 5,
];

/** Clock movement between pushes: still, forward, and backward. */
const CLOCK_STEPS: readonly number[] = [
  0,
  1,
  60_000,
  CLOCK_SKEW_MS,
  CLOCK_SKEW_MS * 5,
  -60_000,
  -CLOCK_SKEW_MS,
];

function arbClocks(records: WireRecord[]): fc.Arbitrary<[number, number, number]> {
  const revisions = records.map((r) => Number(r.updatedAt));
  const base = revisions.length > 0 ? Math.min(...revisions) : 0;
  return fc
    .tuple(
      fc.constantFrom(...CLOCK_OFFSETS),
      fc.constantFrom(...CLOCK_STEPS),
      fc.constantFrom(...CLOCK_STEPS),
    )
    .map(([offset, step2, step3]) => {
      const t1 = clampClock(base + offset);
      const t2 = clampClock(t1 + step2);
      return [t1, t2, clampClock(t2 + step3)];
    });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Every distinct `id` carried by the request, acknowledged exactly once (Req 6.11). */
function expectAcknowledgedOnce(result: PushResult, ids: string[]): void {
  expect(result.outcomes.map((o) => o.outcome)).toEqual(ids.map(() => "stored"));
  expect([...result.outcomes.map((o) => o.id)].sort()).toEqual([...ids].sort());
}

// ---------------------------------------------------------------------------
// Property 13 (push half)
// ---------------------------------------------------------------------------

describe("Property 13: Sync is idempotent in both directions (push)", () => {
  it("re-pushing a payload stores one record per id with every field but seq unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPayload.chain((payload) =>
          arbClocks(payload.records).map((clocks) => ({ payload, clocks })),
        ),
        async ({ payload, clocks: [t1, t2, t3] }) => {
          const store = newEventStore();

          const first = await store.push(EMAIL, payload.records, t1);
          expectAcknowledgedOnce(first, payload.ids);

          // The state every later push is measured against.
          const after = await store.pull(EMAIL, null, PAGE, t1);
          expect(after.records).toHaveLength(payload.ids.length);
          expect(new Set(after.records.map((r) => r.id)).size).toBe(payload.ids.length);
          expect(await store.countFor(EMAIL, t1)).toBe(payload.ids.length);
          const seqAfterFirst = (await store.getMeta(EMAIL)).seq;

          // The same payload again, under a clock that has moved.
          for (const now of [t2, t3]) {
            const repeat = await store.push(EMAIL, payload.records, now);

            // Still one outcome per id, all `stored` — every record loses the
            // merge this time round, and losing is still acknowledged
            // (Req 6.11, 9.5, 9.8).
            expectAcknowledgedOnce(repeat, payload.ids);

            // Nothing changed, so nothing was written and no Server_Sequence
            // was assigned.
            expect(repeat.stored).toBe(0);
            expect(repeat.highestSequence).toBeNull();
            expect((await store.getMeta(EMAIL)).seq).toBe(seqAfterFirst);

            // One record per id, field-for-field as after the first push. A
            // pulled record carries no `seq`, so this is equality over exactly
            // the fields Requirement 6.5 pins.
            const now2 = await store.pull(EMAIL, null, PAGE, now);
            expect(now2.records).toEqual(after.records);
            expect(now2.cursor).toBe(after.cursor);
            expect(await store.countFor(EMAIL, now)).toBe(payload.ids.length);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("re-pushing a far-future payload under a moved clock keeps the clamped revision", async () => {
    /**
     * Every record's Revision_Time is pushed beyond the skew tolerance, so the
     * first push stores the server clock in its place (Req 8.8). The later
     * pushes run under a different clock — including one far enough ahead that
     * the payload's own Revision_Time no longer looks far-future — and must
     * still leave the stored record exactly as the first push left it
     * (Req 6.5).
     */
    const arbFarFuturePayload: fc.Arbitrary<{ payload: Payload; clocks: number[] }> = fc
      .tuple(
        arbPayload,
        fc.integer({ min: 0, max: CLOCK_SKEW_MS * 4 }), // t1
        fc.array(fc.integer({ min: 1, max: CLOCK_SKEW_MS * 20 }), { maxLength: 25 }),
        fc.array(fc.integer({ min: 0, max: CLOCK_SKEW_MS * 30 }), { minLength: 2, maxLength: 2 }),
      )
      .map(([payload, t1, aheadBy, steps]) => {
        const revisions = new Map<string, number>();
        payload.ids.forEach((id, i) => {
          // Strictly more than the tolerance past t1, so the clamp applies.
          revisions.set(id, t1 + CLOCK_SKEW_MS + 1 + (aheadBy[i] ?? 1));
        });
        const records = payload.records.map((r) => ({
          ...r,
          updatedAt: revisions.get(String(r.id)),
        }));
        const t2 = clampClock(t1 + steps[0]);
        return {
          payload: { records, ids: payload.ids },
          clocks: [t1, t2, clampClock(t2 + steps[1])],
        };
      });

    await fc.assert(
      fc.asyncProperty(arbFarFuturePayload, async ({ payload, clocks: [t1, t2, t3] }) => {
        const store = newEventStore();

        const first = await store.push(EMAIL, payload.records, t1);
        expectAcknowledgedOnce(first, payload.ids);

        const after = await store.pull(EMAIL, null, PAGE, t1);
        expect(after.records).toHaveLength(payload.ids.length);
        // The clamp really fired: the stored Revision_Time is the server clock.
        for (const record of after.records) expect(record.updatedAt).toBe(t1);
        const seqAfterFirst = (await store.getMeta(EMAIL)).seq;

        for (const now of [t2, t3]) {
          const repeat = await store.push(EMAIL, payload.records, now);
          expectAcknowledgedOnce(repeat, payload.ids);
          expect(repeat.stored).toBe(0);
          expect(repeat.highestSequence).toBeNull();
          expect((await store.getMeta(EMAIL)).seq).toBe(seqAfterFirst);

          const again = await store.pull(EMAIL, null, PAGE, now);
          expect(again.records).toEqual(after.records);
          expect(await store.countFor(EMAIL, now)).toBe(payload.ids.length);
        }
      }),
      { numRuns: 150 },
    );
  });
});
