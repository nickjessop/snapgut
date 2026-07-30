// Property 12: Outbox reconciliation removes exactly the settled ids.
//
// Validates: Requirements 6.6, 6.7, 19.9, 19.11
//
// `reconcileOutbox` is the only place an id leaves the Outbox on a completed
// push, and the Outbox has no time-based expiry (Req 6.8), so an id it removes
// wrongly is a local revision that never reaches the cloud and is never retried.
// The property therefore has two halves:
//
// - **A partition.** Every distinct id the cycle sent comes back in exactly one
//   of `remove` / `keep`, in first-sent order, and no id that was not sent
//   appears in either — a response cannot reach into the Outbox for ids the
//   request never carried.
// - **A justification rule.** `remove` holds precisely the ids reported `stored`
//   (Req 6.6) plus the ids rejected for a reason that is a permanent property of
//   the record — `photo_field`, `record_too_large`, `invalid_record` (Req 19.9).
//   Every other sent id is kept (Req 6.7), including `record_cap`, which must
//   stay queued so the records land once the cap clears (Req 19.11), and
//   `record_limit` / `payload_too_large`, which describe how this cycle packed
//   the request rather than the record.
//
// Three totality choices the wire contract makes unreachable are asserted rather
// than worked around, because the function still has to answer them:
//
// - a sent id with **no** outcome is kept (Req 6.11 promises one per sent id, so
//   a missing one is evidence of nothing);
// - **conflicting** outcomes for one id keep the id — removal must be justified
//   by every outcome seen for it, since a redundant re-push is free (Req 6.5)
//   while a wrong removal is not;
// - an **unrecognized** `reason` from a newer Sync_Service reads as unsettled.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reconcileOutbox, type PushOutcome, type RejectReason } from "./cloudSync";
import { arbId } from "./test/arbitraries";

// ---------------------------------------------------------------------------
// The reason space
// ---------------------------------------------------------------------------

/** Permanent properties of the record: re-sending earns the same answer (Req 19.9). */
const PERMANENT_REASONS = ["photo_field", "record_too_large", "invalid_record"] as const;

/** Capacity- and request-shaped reasons: the id stays queued (Req 6.7, 19.11). */
const TRANSIENT_REASONS = ["record_limit", "payload_too_large", "record_cap"] as const;

/** A newer Sync_Service could report a reason this client has never heard of. */
const UNKNOWN_REASONS = ["future_reason", "", "RECORD_CAP", "quota_exceeded", "stored"] as const;

// Compile-time check that the two lists together are the whole union, so adding
// a reason to `RejectReason` without classifying it here fails to type-check.
const _allReasons: readonly RejectReason[] = [...PERMANENT_REASONS, ...TRANSIENT_REASONS];
void _allReasons;
type _Exhaustive =
  Exclude<RejectReason, (typeof PERMANENT_REASONS)[number] | (typeof TRANSIENT_REASONS)[number]>;
const _noUnclassifiedReason: _Exhaustive[] = [];
void _noUnclassifiedReason;

// ---------------------------------------------------------------------------
// Case shape
//
// A case carries, per distinct sent id, the outcomes the response reports for it
// *and* whether that combination should settle the id. The expectation is built
// from the plan rather than recomputed from the outcomes, so the test does not
// re-implement the function under test.
// ---------------------------------------------------------------------------

type OutcomeSpec = { outcome: "stored" } | { outcome: "rejected"; reason: string };

interface IdPlan {
  label: string;
  /** Expected: this id may leave the Outbox. */
  settles: boolean;
  specs: OutcomeSpec[];
}

interface ReconcileCase {
  /** Ids sent in this request, in send order, possibly with repeats. */
  sentIds: string[];
  /** The response's outcomes, shuffled, including ids that were never sent. */
  outcomes: PushOutcome[];
  /** Per distinct sent id. */
  plans: Map<string, IdPlan>;
  /** Reported ids the request never carried. */
  unsentReported: string[];
}

function reject(reason: string): OutcomeSpec {
  return { outcome: "rejected", reason };
}

function materialize(id: string, spec: OutcomeSpec): PushOutcome {
  return spec.outcome === "stored"
    ? { id, outcome: "stored" }
    : { id, outcome: "rejected", reason: spec.reason as RejectReason };
}

function repeat<T>(n: number, make: () => T): T[] {
  return Array.from({ length: n }, make);
}

const arbRepeats = fc.integer({ min: 1, max: 3 });

/** A settling outcome: `stored`, or a rejection that is permanent (Req 6.6, 19.9). */
const arbSettlingSpec: fc.Arbitrary<OutcomeSpec> = fc.oneof(
  fc.constant<OutcomeSpec>({ outcome: "stored" }),
  fc.constantFrom(...PERMANENT_REASONS).map(reject),
);

/**
 * One id's outcomes. Repeated outcomes, mixed settling outcomes, conflicting
 * outcomes, a missing outcome, and unrecognized reasons are all in range.
 */
const arbIdPlan: fc.Arbitrary<IdPlan> = fc.oneof(
  // No outcome at all — a truncated or unexpected response.
  { arbitrary: fc.constant<IdPlan>({ label: "no-outcome", settles: false, specs: [] }), weight: 2 },
  {
    arbitrary: arbRepeats.map((n) => ({
      label: "stored",
      settles: true,
      specs: repeat<OutcomeSpec>(n, () => ({ outcome: "stored" })),
    })),
    weight: 4,
  },
  {
    arbitrary: fc
      .tuple(fc.constantFrom(...PERMANENT_REASONS), arbRepeats)
      .map(([reason, n]) => ({
        label: `permanent:${reason}`,
        settles: true,
        specs: repeat(n, () => reject(reason)),
      })),
    weight: 4,
  },
  {
    arbitrary: fc
      .tuple(fc.constantFrom(...TRANSIENT_REASONS), arbRepeats)
      .map(([reason, n]) => ({
        label: `transient:${reason}`,
        settles: false,
        specs: repeat(n, () => reject(reason)),
      })),
    weight: 4,
  },
  // Several settling outcomes of different kinds: still settled.
  {
    arbitrary: fc.array(arbSettlingSpec, { minLength: 2, maxLength: 3 }).map((specs) => ({
      label: "settled-mix",
      settles: true,
      specs,
    })),
    weight: 2,
  },
  // A settling outcome contradicted by a transient one: keep the id.
  {
    arbitrary: fc
      .tuple(arbSettlingSpec, fc.constantFrom(...TRANSIENT_REASONS))
      .map(([settling, reason]) => ({
        label: "conflict",
        settles: false,
        specs: [settling, reject(reason)],
      })),
    weight: 3,
  },
  {
    arbitrary: fc.constantFrom(...UNKNOWN_REASONS).map((reason) => ({
      label: `unknown:${reason || "<empty>"}`,
      settles: false,
      specs: [reject(reason)],
    })),
    weight: 3,
  },
);

/** Outcomes attributed to ids the request never carried — must be ignored. */
const arbUnsentSpecs: fc.Arbitrary<OutcomeSpec[]> = fc.array(
  fc.oneof(arbSettlingSpec, fc.constantFrom(...TRANSIENT_REASONS).map(reject)),
  { minLength: 1, maxLength: 2 },
);

const arbReconcileCase: fc.Arbitrary<ReconcileCase> = fc
  .tuple(
    fc.array(arbId, { maxLength: 12 }),
    // Which sent ids get repeated in the request's id list.
    fc.array(fc.nat({ max: 64 }), { maxLength: 6 }),
    fc.array(arbId, { maxLength: 4 }),
  )
  .chain(([base, duplicatePicks, extras]) => {
    const distinct = [...new Set(base)];
    const sentSet = new Set(distinct);
    const unsentReported = [...new Set(extras)].filter((id) => !sentSet.has(id));
    const duplicates =
      distinct.length === 0 ? [] : duplicatePicks.map((n) => distinct[n % distinct.length]);
    const all = [...distinct, ...duplicates];

    return fc
      .tuple(
        // Shuffled, so a repeat can land anywhere and first-sent order is not
        // simply generation order.
        fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }),
        fc.array(arbIdPlan, { minLength: distinct.length, maxLength: distinct.length }),
        fc.array(arbUnsentSpecs, {
          minLength: unsentReported.length,
          maxLength: unsentReported.length,
        }),
      )
      .chain(([sentIds, idPlans, unsentSpecs]) => {
        const plans = new Map<string, IdPlan>();
        distinct.forEach((id, i) => plans.set(id, idPlans[i]));

        const outcomes: PushOutcome[] = [];
        for (const [id, plan] of plans) {
          for (const spec of plan.specs) outcomes.push(materialize(id, spec));
        }
        unsentReported.forEach((id, i) => {
          for (const spec of unsentSpecs[i]) outcomes.push(materialize(id, spec));
        });

        return fc
          .shuffledSubarray(outcomes, {
            minLength: outcomes.length,
            maxLength: outcomes.length,
          })
          .map((shuffled) => ({ sentIds, outcomes: shuffled, plans, unsentReported }));
      });
  });

/** The distinct sent ids in first-sent order — the order both lists must follow. */
function firstSentOrder(sentIds: string[]): string[] {
  return [...new Set(sentIds)];
}

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

describe("Property 12: Outbox reconciliation removes exactly the settled ids", () => {
  it("partitions the distinct sent ids across remove and keep, in first-sent order", () => {
    fc.assert(
      fc.property(arbReconcileCase, ({ sentIds, outcomes }) => {
        const { remove, keep } = reconcileOutbox(sentIds, outcomes);
        const order = firstSentOrder(sentIds);

        // Exactly once each: the two lists together are the distinct sent ids,
        // with no id repeated within or across them.
        expect(remove.length + keep.length).toBe(order.length);
        expect(new Set([...remove, ...keep])).toEqual(new Set(order));
        expect(new Set(remove).size).toBe(remove.length);
        expect(new Set(keep).size).toBe(keep.length);
        for (const id of remove) expect(keep).not.toContain(id);

        // Each list is the corresponding subsequence of first-sent order, so a
        // repeated id is reported at its first position and nowhere else.
        const position = new Map(order.map((id, i) => [id, i]));
        for (const list of [remove, keep]) {
          const positions = list.map((id) => position.get(id) as number);
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never returns an id that was not sent, ignoring outcomes for unsent ids", () => {
    fc.assert(
      fc.property(arbReconcileCase, ({ sentIds, outcomes, unsentReported }) => {
        const { remove, keep } = reconcileOutbox(sentIds, outcomes);
        const sent = new Set(sentIds);

        for (const id of [...remove, ...keep]) expect(sent.has(id)).toBe(true);
        for (const id of unsentReported) {
          expect(remove).not.toContain(id);
          expect(keep).not.toContain(id);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("removes stored and permanently rejected ids and keeps every other sent id", () => {
    fc.assert(
      fc.property(arbReconcileCase, ({ sentIds, outcomes, plans }) => {
        const { remove, keep } = reconcileOutbox(sentIds, outcomes);
        const order = firstSentOrder(sentIds);

        // Built from the generated plans, not recomputed from `outcomes`: an id
        // is settled when every outcome reported for it is `stored` or a
        // permanent rejection, and unsettled otherwise — including no outcome,
        // a conflict, and an unrecognized reason.
        expect(remove).toEqual(order.filter((id) => plans.get(id)?.settles === true));
        expect(keep).toEqual(order.filter((id) => plans.get(id)?.settles !== true));
      }),
      { numRuns: 300 },
    );
  });

  it("does not depend on the order the outcomes arrive in", () => {
    fc.assert(
      fc.property(arbReconcileCase, ({ sentIds, outcomes }) => {
        // Settling is a conjunction over the outcomes seen for an id, so a
        // response that lists them in the opposite order settles the same ids.
        expect(reconcileOutbox(sentIds, [...outcomes].reverse())).toEqual(
          reconcileOutbox(sentIds, outcomes),
        );
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// The permanent / transient split, reason by reason
// ---------------------------------------------------------------------------

describe("reconcileOutbox: every rejection reason", () => {
  const cases: ReadonlyArray<[RejectReason, boolean, string]> = [
    ["photo_field", true, "Req 19.9: the record carries Photo data and always will"],
    ["record_too_large", true, "Req 19.9: the record is over the per-record limit"],
    ["invalid_record", true, "Req 19.9: the record cannot be parsed"],
    ["record_limit", false, "Req 6.7: this cycle packed too many records into one request"],
    ["payload_too_large", false, "Req 6.7: this cycle packed too many bytes into one request"],
    ["record_cap", false, "Req 19.11: the records land once the per-user cap clears"],
  ];

  for (const [reason, removed, why] of cases) {
    it(`${removed ? "removes" : "keeps"} an id rejected for ${reason} — ${why}`, () => {
      const result = reconcileOutbox(["a"], [{ id: "a", outcome: "rejected", reason }]);
      expect(result).toEqual(removed ? { remove: ["a"], keep: [] } : { remove: [], keep: ["a"] });
    });
  }

  it("removes a stored id (Req 6.6) while keeping the rest of the request", () => {
    const { remove, keep } = reconcileOutbox(
      ["a", "b", "c"],
      [
        { id: "a", outcome: "stored" },
        { id: "b", outcome: "rejected", reason: "record_cap" },
        { id: "c", outcome: "rejected", reason: "record_too_large" },
      ],
    );
    expect(remove).toEqual(["a", "c"]);
    expect(keep).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// Totality: the answers the wire contract never asks for
// ---------------------------------------------------------------------------

describe("reconcileOutbox: totality", () => {
  it("keeps a sent id the response reports no outcome for (Req 6.7, 6.11)", () => {
    const { remove, keep } = reconcileOutbox(["a", "b"], [{ id: "a", outcome: "stored" }]);
    expect(remove).toEqual(["a"]);
    expect(keep).toEqual(["b"]);
  });

  it("keeps an id whose outcomes conflict, whichever order they arrive in", () => {
    const stored: PushOutcome = { id: "a", outcome: "stored" };
    const capped: PushOutcome = { id: "a", outcome: "rejected", reason: "record_cap" };

    expect(reconcileOutbox(["a"], [stored, capped])).toEqual({ remove: [], keep: ["a"] });
    expect(reconcileOutbox(["a"], [capped, stored])).toEqual({ remove: [], keep: ["a"] });
  });

  it("keeps an id rejected for a reason this client does not recognize", () => {
    const { remove, keep } = reconcileOutbox(
      ["a"],
      [{ id: "a", outcome: "rejected", reason: "future_reason" as RejectReason }],
    );
    expect(remove).toEqual([]);
    expect(keep).toEqual(["a"]);
  });

  it("collapses a repeated sent id to one report", () => {
    expect(reconcileOutbox(["a", "a", "b"], [{ id: "a", outcome: "stored" }])).toEqual({
      remove: ["a"],
      keep: ["b"],
    });
  });

  it("returns two empty lists when nothing was sent, whatever the response says", () => {
    expect(reconcileOutbox([], [{ id: "ghost", outcome: "stored" }])).toEqual({
      remove: [],
      keep: [],
    });
    expect(reconcileOutbox([], [])).toEqual({ remove: [], keep: [] });
  });

  it("keeps every sent id when the response reports no outcomes at all", () => {
    expect(reconcileOutbox(["a", "b"], [])).toEqual({ remove: [], keep: ["a", "b"] });
  });
});
