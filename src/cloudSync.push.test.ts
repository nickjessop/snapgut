// Property 11: Push planning accounts for every outbox id exactly once.
//
// Validates: Requirements 6.1, 6.2
//
// `planPush` is the whole decision of what one Sync_Cycle sends. The property
// that makes it safe is a partition: every id the Outbox handed over is settled
// exactly once — sent in a batch, dropped as unmatched (Req 6.1), or deferred
// past the request ceiling (Req 6.2) — with nothing lost and nothing counted
// twice. Losing an id would silently strand a local revision; counting one
// twice would assign it two Server_Sequences for the same content.
//
// Two deliberate behaviours shape how the property is stated:
//
// - **The partition is over DISTINCT ids.** The Local_Store holds at most one
//   entry per id (Req 4.6), so a repeated id in the Outbox is collapsed on
//   first sight rather than pushed twice.
// - **A record whose own serialization passes the request byte budget is sent
//   alone** rather than deferred forever, so that single-record batch is the one
//   input where a batch may exceed 1 MiB. It is covered by a unit case below
//   instead of by weakening the byte assertion.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_RECORDS_PER_REQUEST,
  MAX_REQUEST_BYTES,
  MAX_REQUESTS_PER_CYCLE,
  planPush,
  type EventRecord,
} from "./cloudSync";
import type { StoredRecord } from "./db";
import {
  arbId,
  arbStoredRecords,
  type SyncStoredRecord,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One planning input: the Outbox ids, and what the Local_Store holds. */
interface PlanCase {
  ids: string[];
  records: Map<string, SyncStoredRecord>;
}

function lookupFrom(records: Map<string, SyncStoredRecord>) {
  return (id: string): StoredRecord | null =>
    (records.get(id) as StoredRecord | undefined) ?? null;
}

function plan(testCase: PlanCase) {
  return planPush(testCase.ids, lookupFrom(testCase.records));
}

const encoder = new TextEncoder();

/** What the request body's record array serializes to, in bytes (Req 19.1). */
function batchBytes(batch: EventRecord[]): number {
  return encoder.encode(JSON.stringify(batch)).length;
}

/**
 * Outbox ids: every generated record's id, some ids the Local_Store holds
 * nothing for, and duplicates of both — shuffled, so the plan can never lean on
 * arrival order.
 */
const arbPlanCase: fc.Arbitrary<PlanCase> = fc
  .tuple(
    arbStoredRecords,
    fc.array(arbId, { maxLength: 8 }),
    fc.array(fc.nat({ max: 64 }), { maxLength: 10 }),
  )
  .chain(([records, missing, duplicatePicks]) => {
    const byId = new Map<string, SyncStoredRecord>();
    for (const r of records) byId.set(r.id, r);

    const base = [...byId.keys(), ...missing.filter((id) => !byId.has(id))];
    const duplicates =
      base.length === 0 ? [] : duplicatePicks.map((n) => base[n % base.length]);
    const all = [...base, ...duplicates];

    return fc
      .shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
      .map((ids) => ({ ids, records: byId }));
  });

// ---------------------------------------------------------------------------
// Bulk inputs: the record-count, request-count, and byte ceilings
//
// The Requirement 20.1 domain caps a record at a few kilobytes, so reaching 20
// full requests takes thousands of records and reaching the byte ceiling takes
// hundreds of large ones. These build such inputs directly — cheaply, and with
// a seeded pseudo-random Revision_Time so ordering and ties still vary run to
// run.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit LCG, so a large input costs one generated seed. */
function lcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

/** Ids that sort the same way lexicographically and numerically. */
function bulkId(i: number): string {
  return `evt-${String(i).padStart(6, "0")}`;
}

/** A minimal in-domain record: a few hundred bytes on the wire. */
function tinyRecord(i: number, updatedAt: number): SyncStoredRecord {
  return { id: bulkId(i), type: "checkin", createdAt: 1_700_000_000_000, updatedAt };
}

const FILLER = "aq,\"x ".repeat(400); // 2,000+ code units of hostile-ish text

/** An in-domain record near the top of its size range: ~8 KiB on the wire. */
function bulkyRecord(i: number, updatedAt: number): SyncStoredRecord {
  return {
    id: bulkId(i),
    type: "meal",
    createdAt: 1_700_000_000_000,
    updatedAt,
    note: FILLER.slice(0, 2_000),
    dish: FILLER.slice(0, 2_000),
    ingredients: Array.from({ length: 50 }, (_, n) => ({
      name: `${FILLER.slice(0, 55)}${n}`,
      confidence: n % 2 === 0 ? ("confident" as const) : ("maybe" as const),
    })),
  };
}

function bulkCase(
  count: number,
  seed: number,
  build: (i: number, updatedAt: number) => SyncStoredRecord,
): PlanCase {
  const next = lcg(seed);
  const records = new Map<string, SyncStoredRecord>();
  for (let i = 0; i < count; i++) {
    // A small Revision_Time range on purpose, so ties are common and the
    // ascending-id tiebreak is exercised at scale.
    const record = build(i, 1_700_000_000_000 + (next() % 64));
    records.set(record.id, record);
  }
  return { ids: [...records.keys()], records };
}

/** Ascending `updatedAt`, then ascending `id` — the Requirement 6.1 order. */
function inPlanOrder(records: SyncStoredRecord[]): SyncStoredRecord[] {
  return [...records].sort((a, b) =>
    a.updatedAt !== b.updatedAt ? a.updatedAt - b.updatedAt : a.id < b.id ? -1 : 1,
  );
}

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

describe("Property 11: Push planning accounts for every outbox id exactly once", () => {
  it("settles every distinct outbox id exactly once across batches, drop, and defer", () => {
    fc.assert(
      fc.property(arbPlanCase, (testCase) => {
        const { batches, drop, defer } = plan(testCase);

        const batched = batches.flat().map((r) => r.id);
        const settled = [...batched, ...drop, ...defer];
        const distinct = new Set(testCase.ids);

        // Exactly once: the three collections together are the distinct input
        // ids, with no id repeated anywhere among them.
        expect(settled.length).toBe(distinct.size);
        expect(new Set(settled)).toEqual(distinct);
        // And no id was invented: nothing outside the input appears.
        for (const id of settled) expect(distinct.has(id)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("puts every id with no matching record in drop, and nothing else (Req 6.1)", () => {
    fc.assert(
      fc.property(arbPlanCase, (testCase) => {
        const { batches, drop, defer } = plan(testCase);

        const unmatched = new Set(
          [...new Set(testCase.ids)].filter((id) => !testCase.records.has(id)),
        );

        expect(new Set(drop)).toEqual(unmatched);
        // An unmatched id is settled by dropping it, never sent and never held
        // over to the next cycle.
        for (const id of [...batches.flat().map((r) => r.id), ...defer]) {
          expect(unmatched.has(id)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("sends records in ascending updatedAt order with ties broken by ascending id (Req 6.1)", () => {
    fc.assert(
      fc.property(arbPlanCase, (testCase) => {
        const sent = plan(testCase).batches.flat();

        for (let i = 1; i < sent.length; i++) {
          const prev = sent[i - 1];
          const next = sent[i];
          if (prev.updatedAt === next.updatedAt) {
            expect(prev.id < next.id).toBe(true);
          } else {
            expect(prev.updatedAt).toBeLessThan(next.updatedAt);
          }
        }

        // Each sent record carries the identity and revision of the record the
        // Local_Store holds for that id.
        for (const wire of sent) {
          const source = testCase.records.get(wire.id);
          expect(source).toBeDefined();
          expect(wire.updatedAt).toBe(source?.updatedAt);
          expect(wire.createdAt).toBe(source?.createdAt);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("keeps every batch within the record and byte ceilings, and the plan within 20 batches (Req 6.2)", () => {
    fc.assert(
      fc.property(arbPlanCase, (testCase) => {
        const { batches } = plan(testCase);

        expect(batches.length).toBeLessThanOrEqual(MAX_REQUESTS_PER_CYCLE);
        for (const batch of batches) {
          expect(batch.length).toBeGreaterThan(0);
          expect(batch.length).toBeLessThanOrEqual(MAX_RECORDS_PER_REQUEST);
          expect(batchBytes(batch)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("reports omittedUnknown only for ids this cycle actually sends (Req 16.8)", () => {
    fc.assert(
      fc.property(arbPlanCase, (testCase) => {
        const { batches, omittedUnknown } = plan(testCase);

        const batched = new Set(batches.flat().map((r) => r.id));
        for (const id of omittedUnknown) expect(batched.has(id)).toBe(true);
        expect(new Set(omittedUnknown).size).toBe(omittedUnknown.length);
      }),
      { numRuns: 300 },
    );
  });

  it("splits on the record ceiling and defers the remainder past 20 requests (Req 6.2)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3_950, max: 4_150 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (count, seed) => {
          const testCase = bulkCase(count, seed, tinyRecord);
          const { batches, drop, defer } = plan(testCase);

          const capacity = MAX_REQUESTS_PER_CYCLE * MAX_RECORDS_PER_REQUEST;
          const sent = batches.flat();

          // Tiny records: the record ceiling binds, not the byte ceiling.
          expect(batches.length).toBe(Math.min(MAX_REQUESTS_PER_CYCLE, Math.ceil(count / 200)));
          expect(sent.length).toBe(Math.min(count, capacity));
          expect(defer.length).toBe(Math.max(0, count - capacity));
          expect(drop).toEqual([]);
          for (const batch of batches.slice(0, -1)) {
            expect(batch.length).toBe(MAX_RECORDS_PER_REQUEST);
          }

          // The partition still holds, and what waits is the tail of the order:
          // the deferred ids are the ones the ceiling cut off, not an arbitrary
          // subset.
          expect(new Set([...sent.map((r) => r.id), ...defer]).size).toBe(count);
          const ordered = inPlanOrder([...testCase.records.values()]).map((r) => r.id);
          expect(sent.map((r) => r.id)).toEqual(ordered.slice(0, sent.length));
          expect(defer).toEqual(ordered.slice(sent.length));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("splits on the byte ceiling for large records, still settling every id once (Req 6.2, 19.1)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 160, max: 300 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (count, seed) => {
          const testCase = bulkCase(count, seed, bulkyRecord);
          const { batches, drop, defer } = plan(testCase);

          const sent = batches.flat();

          // ~8 KiB per record, so a request fills on bytes well before 200
          // records — which is the only way this input can produce a split.
          expect(batches.length).toBeGreaterThan(1);
          for (const batch of batches) {
            expect(batch.length).toBeLessThan(MAX_RECORDS_PER_REQUEST);
            expect(batchBytes(batch)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
          }

          expect(drop).toEqual([]);
          expect(defer).toEqual([]);
          expect(sent.length).toBe(count);
          expect(new Set(sent.map((r) => r.id)).size).toBe(count);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// The one deliberate exception to the byte ceiling
// ---------------------------------------------------------------------------

describe("planPush: a record larger than the request budget", () => {
  it("sends an oversized record alone rather than deferring it forever", () => {
    // Past 1 MiB on its own, so no batch could ever hold it alongside another
    // record. Deferring it would park it at the head of every future cycle;
    // sending it alone lets the Sync_Service answer `record_too_large` and
    // Requirement 19.9 take it out of the Outbox.
    const oversized: SyncStoredRecord = {
      id: "zz-oversized",
      type: "meal",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      dish: "x".repeat(MAX_REQUEST_BYTES + 1_000),
      ingredients: [],
    };
    const small: SyncStoredRecord = tinyRecord(1, 1_700_000_000_000);

    const records = new Map<string, SyncStoredRecord>([
      [oversized.id, oversized],
      [small.id, small],
    ]);
    const { batches, drop, defer } = plan({ ids: [...records.keys()], records });

    // Equal Revision_Times, so the ascending-id tiebreak sends "zz-oversized"
    // after "evt-000001": the small record fills the first request, the
    // oversized one goes out on its own.
    expect(batches.map((b) => b.map((r) => r.id))).toEqual([[small.id], [oversized.id]]);
    expect(batchBytes(batches[1])).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(drop).toEqual([]);
    expect(defer).toEqual([]);
  });
});
