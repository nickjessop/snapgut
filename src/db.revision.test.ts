// Feature: cloud-sync, Property 14: Revision_Time never decreases for an id
//
// For any sequence of writes to a single `id` and any device clock values,
// including clocks that jump backwards or repeat, the `updatedAt` assigned by
// `nextRevisionTime` is strictly greater than the previously stored `updatedAt`
// for that `id`.
//
// Validates: Requirements 5.8
//
// The property is checked twice over the same adversarial clock sequences:
// against the pure helper, and end-to-end through `putEvent`/`deleteEvent` so
// the value that actually lands in IndexedDB is the one asserted. jsdom has no
// IndexedDB, so `fake-indexeddb/auto` installs a real implementation — the
// through-the-store half is about repeated writes to one key, which an
// in-memory stand-in could not honestly exercise.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  deleteEvent,
  getRecord,
  isTombstone,
  nextRevisionTime,
  putEvent,
  type LogEvent,
} from "./db";
import { arbClockSequence, arbLogEvent, type SyncLogEvent } from "./test/arbitraries";

/** Distinct id per property run, so runs never share a key. */
let idCounter = 0;
function freshId(): string {
  return `rev-${++idCounter}`;
}

/** The two write kinds that assign a Revision_Time (Req 5.2, 5.3). */
type WriteKind = "put" | "delete";

const arbWriteKinds: fc.Arbitrary<WriteKind[]> = fc.array(
  fc.oneof(
    { arbitrary: fc.constant<WriteKind>("put"), weight: 3 },
    { arbitrary: fc.constant<WriteKind>("delete"), weight: 1 },
  ),
  { minLength: 1, maxLength: 25 },
);

describe("Property 14: Revision_Time never decreases for an id", () => {
  it("nextRevisionTime is strictly increasing across any clock sequence", () => {
    fc.assert(
      fc.property(arbClockSequence, (clocks) => {
        let stored: number | undefined;
        for (const now of clocks) {
          const assigned = nextRevisionTime(now, stored);

          if (stored === undefined) {
            // Nothing held for the id yet: the clock is taken as-is.
            expect(assigned).toBe(now);
          } else {
            expect(assigned).toBeGreaterThan(stored);
            // A clock that is not strictly ahead takes stored + 1; otherwise the
            // clock stands, so the revision tracks real time when the clock is
            // healthy rather than drifting away from it.
            expect(assigned).toBe(now <= stored ? stored + 1 : now);
          }

          stored = assigned;
        }
      }),
      { numRuns: 200 },
    );
  });

  it("repeated writes to one id store a strictly increasing Revision_Time", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLogEvent,
        arbClockSequence,
        arbWriteKinds,
        async (event: SyncLogEvent, clocks, kinds) => {
          const id = freshId();
          let stored: number | undefined;

          for (let i = 0; i < clocks.length; i++) {
            const now = clocks[i];
            const kind = kinds[i % kinds.length];

            const assigned =
              kind === "put"
                ? await putEvent({ ...event, id } as LogEvent, { now })
                : await deleteEvent(id, { now });

            // What the write reported is what the store holds.
            const record = await getRecord(id);
            expect(record).toBeDefined();
            expect(record!.updatedAt).toBe(assigned);
            expect(isTombstone(record!)).toBe(kind === "delete");

            if (stored !== undefined) {
              expect(assigned).toBeGreaterThan(stored);
            }
            stored = assigned;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("nextRevisionTime edge cases", () => {
  it("takes the clock when nothing is stored", () => {
    expect(nextRevisionTime(1_000, undefined)).toBe(1_000);
  });

  it("steps past a repeated clock reading", () => {
    expect(nextRevisionTime(1_000, 1_000)).toBe(1_001);
  });

  it("steps past a clock that jumped backwards", () => {
    expect(nextRevisionTime(500, 1_000)).toBe(1_001);
  });

  it("takes the clock when it is strictly ahead", () => {
    expect(nextRevisionTime(1_001, 1_000)).toBe(1_001);
  });

  it("ignores a non-numeric stored revision", () => {
    expect(nextRevisionTime(1_000, Number.NaN)).toBe(1_000);
  });
});
