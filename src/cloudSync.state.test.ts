// Property 15: Sync_State derivation is total and single-valued.
//
// **Validates: Requirements 1.3, 1.4, 1.6, 12.8, 12.9**
//
// `deriveSyncState` is a pure function of a snapshot, so the whole of
// Requirement 12.8 — "exactly one of the six Sync_State values at any time" —
// reduces to totality and single-valuedness of that function over the entire
// condition space, including the combinations a real Sync_Cycle would never
// produce (a cycle in progress that also failed, a Cloud_Destination that reads
// as disabled while a cycle is still in flight). `arbSyncStateInput` generates
// the flags independently for exactly that reason.
//
// Four claims get their own tests beyond the table walk, because each is a
// consequence the requirements name separately:
//
// - `off` whenever no Session_Token is held, *regardless of every other field*
//   (Req 1.6, 12.8 step 1).
// - `off` whenever the Cloud_Destination is disabled or absent, even on a
//   signed-in device with a cycle flag, a failure, or a stored timestamp set
//   (Req 12.1, 12.8 step 4) — the second and last route to `off`.
// - never `synced` while the Outbox is non-empty (Req 12.8 step 7).
// - the `synced → idle` move of Req 12.9 falls out of derivation: raising the
//   Outbox count on a `synced` snapshot yields `idle` with the last-successful
//   timestamp retained, with no transition to fire.
//
// Two derivation decisions are asserted here rather than worked around, so a
// later change to either has to change this test too:
//
// - "at least one Sync_Cycle has completed successfully" is read as
//   `lastSyncAt !== null` (Req 12.4 persists that timestamp when one does), and
//   step 7 tests the Outbox for *exactly* zero ids, so `synced` is unreachable
//   for any non-zero outbox count.
// - a failed cycle with no attributed `failureKind` reads as `"service"`:
//   offline is the positively detected case, so an unattributed failure is not
//   one the device can claim was its own connectivity (Req 12.5).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveSyncState, type SyncState, type SyncStateInput } from "./cloudSync";
import { arbSyncStateInput, type SyncStateInputLike } from "./test/arbitraries";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StateName = SyncState["state"];

const STATE_NAMES: readonly StateName[] = [
  "off",
  "idle",
  "syncing",
  "synced",
  "error",
];

/**
 * The generators mirror `SyncStateInput`; this assignment is what keeps the two
 * shapes in step — a field added to one and not the other stops compiling.
 */
function toInput(i: SyncStateInputLike): SyncStateInput {
  return i;
}

function derive(i: SyncStateInputLike): SyncState {
  return deriveSyncState(toInput(i));
}

/**
 * Requirement 12.8's table as data: the ordered conditions, first match wins.
 * Written as a separate transcription of the requirement so it can disagree
 * with the implementation's `if` chain.
 */
function tableState(i: SyncStateInputLike): StateName {
  const ordered: ReadonlyArray<readonly [boolean, StateName]> = [
    [!i.hasSession, "off"], // 1 (Req 1.6)
    [!i.enabled, "off"], // 2 (Req 12.1)
    [i.cycleInProgress, "syncing"], // 3 (Req 12.3)
    [i.lastCycleFailed && !i.succeededSinceFailure, "error"], // 4 (Req 12.5)
    [i.lastSyncAt !== null && i.outboxCount === 0, "synced"], // 5 (Req 12.4)
  ];
  for (const [matches, state] of ordered) {
    if (matches) return state;
  }
  return "idle"; // 6 (Req 12.2)
}

function expectNonNegativeInteger(value: unknown): void {
  expect(typeof value).toBe("number");
  expect(Number.isInteger(value as number)).toBe(true);
  expect(value as number).toBeGreaterThanOrEqual(0);
}

/**
 * Single-valuedness: the result names one of the six states and carries exactly
 * the payload that state's status line needs, with values drawn from the
 * snapshot — no extra keys, no missing keys, nothing invented.
 */
function expectWellFormed(state: SyncState, i: SyncStateInputLike): void {
  expect(STATE_NAMES).toContain(state.state);
  const keys = Object.keys(state).sort();

  switch (state.state) {
    case "off":
      expect(keys).toEqual(["state"]);
      break;

    case "idle":
      expect(keys).toEqual(["lastSyncAt", "pending", "state"]);
      expect(state.lastSyncAt).toBe(i.lastSyncAt);
      expectNonNegativeInteger(state.pending);
      expect(state.pending).toBe(i.outboxCount);
      break;

    case "syncing":
      expect(keys).toEqual(["lastSyncAt", "restore", "state"]);
      expect(state.lastSyncAt).toBe(i.lastSyncAt);
      if (i.restoreMerged === null) {
        expect(state.restore).toBeNull();
      } else {
        expect(state.restore).toEqual({ merged: i.restoreMerged });
      }
      break;

    case "synced":
      expect(keys).toEqual(["lastSyncAt", "skipped", "state"]);
      // Req 12.4: `synced` is the one state whose timestamp cannot be null.
      expect(state.lastSyncAt).not.toBeNull();
      expect(state.lastSyncAt).toBe(i.lastSyncAt);
      expectNonNegativeInteger(state.skipped);
      expect(state.skipped).toBe(i.skipped);
      break;

    case "error":
      expect(keys).toEqual(["kind", "lastSyncAt", "message", "state"]);
      expect(state.lastSyncAt).toBe(i.lastSyncAt);
      // An unattributed failure reads as a Sync_Service failure (Req 12.5).
      expect(state.kind).toBe(i.failureKind ?? "service");
      expect(typeof state.message).toBe("string");
      expect(state.message.length).toBeGreaterThan(0);
      break;
  }
}

/** A snapshot that Requirement 12.8 must resolve to `synced`. */
const arbSyncedInput: fc.Arbitrary<SyncStateInputLike> = fc
  .tuple(arbSyncStateInput, fc.integer({ min: 0, max: 4_102_444_800_000 }))
  .map(([base, lastSyncAt]) => ({
    ...base,
    hasSession: true,
    enabled: true,
    cycleInProgress: false,
    // Either no failure, or one a later cycle has already superseded.
    succeededSinceFailure: true,
    outboxCount: 0,
    lastSyncAt,
  }));

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

describe("Property 15: Sync_State derivation is total and single-valued", () => {
  it("returns exactly one well-formed state for every snapshot, without throwing", () => {
    fc.assert(
      fc.property(arbSyncStateInput, (i) => {
        expectWellFormed(derive(i), i);
      }),
      { numRuns: 500 },
    );
  });

  it("matches the ordered precedence of Requirement 12.8 for every snapshot", () => {
    fc.assert(
      fc.property(arbSyncStateInput, (i) => {
        expect(derive(i).state).toBe(tableState(i));
      }),
      { numRuns: 500 },
    );
  });

  it("is deterministic: the same snapshot derives the same state", () => {
    fc.assert(
      fc.property(arbSyncStateInput, (i) => {
        expect(derive({ ...i })).toEqual(derive({ ...i }));
      }),
      { numRuns: 200 },
    );
  });

  it("reports `off` whenever no Session_Token is held, whatever else holds (Req 1.6)", () => {
    fc.assert(
      fc.property(arbSyncStateInput, (base) => {
        const i = { ...base, hasSession: false };
        // No payload at all: a signed-out device has nothing to report.
        expect(derive(i)).toEqual({ state: "off" });
      }),
      { numRuns: 300 },
    );
  });

  it("reports `off` when a Session_Token is held but the destination is disabled (Req 12.1, 12.8 step 4)", () => {
    fc.assert(
      fc.property(arbSyncStateInput, (base) => {
        // The companion of the test above: this is the *other* route to `off`, the
        // one a signed-in device takes when it has simply not turned the
        // Cloud_Destination on. Every remaining field is left as generated, so the
        // claim is that the disabled destination alone decides the state — a
        // cycle flag, a recorded failure, a stored timestamp, and a non-empty
        // Outbox are all overridden by it, and none of them leaks into a payload.
        const i = { ...base, hasSession: true, enabled: false };
        expect(derive(i)).toEqual({ state: "off" });
      }),
      { numRuns: 200 },
    );
  });

  it("never reports `synced` while the Outbox holds an id (Req 12.8 step 7)", () => {
    fc.assert(
      fc.property(arbSyncStateInput, fc.integer({ min: 1, max: 5_000 }), (base, pending) => {
        const i = { ...base, outboxCount: pending };
        expect(derive(i).state).not.toBe("synced");
      }),
      { numRuns: 500 },
    );
  });

  it("moves `synced` to `idle` when the Outbox gains an id, keeping the timestamp (Req 12.9)", () => {
    fc.assert(
      fc.property(arbSyncedInput, fc.integer({ min: 1, max: 5_000 }), (synced, pending) => {
        // The precondition is part of the claim: this snapshot really is `synced`,
        // which is also what shows the state is reachable at all.
        expect(derive(synced)).toEqual({
          state: "synced",
          lastSyncAt: synced.lastSyncAt,
          skipped: synced.skipped,
        });

        const afterWrite = derive({ ...synced, outboxCount: pending });
        expect(afterWrite).toEqual({
          state: "idle",
          lastSyncAt: synced.lastSyncAt, // retained and still displayed
          pending,
        });
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Req 12.5: the two failure attributions read differently
// ---------------------------------------------------------------------------

describe("deriveSyncState: error attribution", () => {
  const failing = (failureKind: "offline" | "service" | null): SyncStateInputLike => ({
    hasSession: true,
    enabled: true,
    cycleInProgress: false,
    lastCycleFailed: true,
    failureKind,
    succeededSinceFailure: false,
    outboxCount: 0,
    lastSyncAt: 1_700_000_000_000,
    skipped: 0,
    restoreMerged: null,
  });

  it("distinguishes an offline failure from a Sync_Service failure", () => {
    const offline = derive(failing("offline"));
    const service = derive(failing("service"));
    expect(offline.state).toBe("error");
    expect(service.state).toBe("error");
    expect(offline).not.toEqual(service);
    if (offline.state === "error" && service.state === "error") {
      expect(offline.message).not.toBe(service.message);
    }
  });

  it("attributes an unattributed failure to the Sync_Service", () => {
    expect(derive(failing(null))).toEqual(derive(failing("service")));
  });
});
