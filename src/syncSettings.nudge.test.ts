import { describe, it, expect, afterEach, vi } from "vitest";
import fc from "fast-check";
import {
  FAILING_GRACE_MS,
  isDestinationActive,
  shouldNudgeBackup,
  shouldSuppressBackupNudge,
  type DestinationActivity,
  type DestinationOutcome,
} from "./syncSettings";
import { isBackupDue } from "./backup";
// The one-destination gate this module generalizes. Task 4.1 removes
// `shouldNudgeBackup(connected, backupDue)` from `googleSheets.ts`, so this import
// and the "agrees with the retired one-destination gate" case below must be
// updated (or dropped) when that task lands — the generalization is asserted
// directly against the specification in the tests above it either way.
import { shouldNudgeBackup as legacyShouldNudgeBackup } from "./googleSheets";

// Feature: cloud-sync
//
// Property 16: The backup nudge predicate generalizes the existing gate
// Property 17: Destination activity requires all four conditions
//
// This file replaces `googleSheets.nudge.test.ts` (retired in task 4.2), whose
// Property 9 is the single-destination special case of Property 16.

const LAST_BACKUP_KEY = "food-snap-last-backup";
const SNOOZE_KEY = "food-snap-backup-snooze";
const DAY_MS = 86_400_000;

function clearBackupState(): void {
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
}

afterEach(() => {
  clearBackupState();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Local generators
//
// Kept in this file on purpose: `src/test/arbitraries.ts` is shared and holds no
// activity-descriptor generators.
// ---------------------------------------------------------------------------

const arbNow: fc.Arbitrary<number> = fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 });

/**
 * Offsets from `now` back to a last success, biased onto the 72-hour boundary of
 * Req 14.9 — one millisecond either side of it, exactly on it, plus far-inside,
 * far-outside, and a success timestamped in the future (a skewed device clock).
 */
const arbSuccessAge: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.constantFrom(0, 1, 1_000, 60_000, DAY_MS, 2 * DAY_MS), weight: 3 },
  {
    arbitrary: fc.constantFrom(
      FAILING_GRACE_MS - 1,
      FAILING_GRACE_MS,
      FAILING_GRACE_MS + 1,
      FAILING_GRACE_MS + 1_000,
    ),
    weight: 4,
  },
  { arbitrary: fc.integer({ min: 3 * DAY_MS + 1, max: 90 * DAY_MS }), weight: 2 },
  // Future success: `now - lastSuccessAt` is negative, never past the grace.
  { arbitrary: fc.integer({ min: -30 * DAY_MS, max: -1 }), weight: 1 },
);

function arbOutcome(now: number): fc.Arbitrary<DestinationOutcome> {
  return fc
    .record({
      lastOutcome: fc.constantFrom<DestinationOutcome["lastOutcome"]>(
        null,
        "success",
        "failure",
        "failure",
      ),
      successAge: fc.option(arbSuccessAge, { nil: null }),
      failureAge: fc.option(arbSuccessAge, { nil: null }),
    })
    .map(({ lastOutcome, successAge, failureAge }) => ({
      lastOutcome,
      lastSuccessAt: successAge === null ? null : now - successAge,
      lastFailureAt: failureAge === null ? null : now - failureAge,
    }));
}

const arbActivity: fc.Arbitrary<DestinationActivity> = arbNow.chain((now) =>
  fc.record({
    enabled: fc.boolean(),
    configured: fc.boolean(),
    entitled: fc.boolean(),
    outcome: arbOutcome(now),
    now: fc.constant(now),
  }),
);

/** A descriptor guaranteed active, for the "one active suppresses" direction. */
const arbActiveActivity: fc.Arbitrary<DestinationActivity> = arbActivity.map((a) => ({
  ...a,
  enabled: true,
  configured: true,
  entitled: true,
  outcome:
    a.outcome.lastOutcome === "failure"
      ? { ...a.outcome, lastOutcome: "success" as const, lastSuccessAt: a.now }
      : a.outcome,
}));

type MissingCondition = "enabled" | "configured" | "entitled" | "failing";

const MISSING_CONDITIONS: readonly MissingCondition[] = [
  "enabled",
  "configured",
  "entitled",
  "failing",
];

/** A descriptor guaranteed inactive, via one randomly-chosen missing condition. */
const arbInactiveActivity: fc.Arbitrary<DestinationActivity> = fc
  .tuple(arbActivity, fc.constantFrom(...MISSING_CONDITIONS))
  .map(([a, missing]): DestinationActivity => {
    switch (missing) {
      case "enabled":
        return { ...a, enabled: false };
      case "configured":
        return { ...a, configured: false };
      case "entitled":
        return { ...a, entitled: false };
      case "failing":
        return {
          ...a,
          outcome: { ...a.outcome, lastOutcome: "failure", lastSuccessAt: null },
        };
    }
  });

const arbDestinations: fc.Arbitrary<DestinationActivity[]> = fc.array(arbActivity, {
  maxLength: 4,
});

// The backup-timing state Req 14.2/14.3 quantify over: no recorded backup, a
// recent one, an overdue one, a live snooze, and an expired snooze.
interface BackupState {
  lastBackup: number | null;
  snooze: number | null;
  hasData: boolean;
}

const arbBackupState: fc.Arbitrary<BackupState> = fc.record({
  lastBackup: fc.option(
    fc.oneof(
      fc.integer({ min: -30 * DAY_MS, max: -3 * DAY_MS }), // overdue
      fc.integer({ min: -3 * DAY_MS + 1, max: 0 }), // recent
    ),
    { nil: null },
  ),
  snooze: fc.option(fc.integer({ min: -10 * DAY_MS, max: 10 * DAY_MS }), { nil: null }),
  hasData: fc.boolean(),
});

/** Writes the generated timing state into localStorage, offsets relative to now. */
function installBackupState(s: BackupState): void {
  clearBackupState();
  const now = Date.now();
  if (s.lastBackup !== null) localStorage.setItem(LAST_BACKUP_KEY, String(now + s.lastBackup));
  if (s.snooze !== null) localStorage.setItem(SNOOZE_KEY, String(now + s.snooze));
}

// ---------------------------------------------------------------------------
// Property 16: The backup nudge predicate generalizes the existing gate
//
// Validates: Requirements 14.1, 14.2, 14.3, 14.10
// ---------------------------------------------------------------------------

describe("Property 16: the backup nudge predicate generalizes the existing gate", () => {
  it("suppresses when any destination is active and defers to backupDue otherwise", () => {
    fc.assert(
      fc.property(arbDestinations, fc.boolean(), (destinations, backupDue) => {
        const anyActive = destinations.some(isDestinationActive);
        expect(shouldSuppressBackupNudge(destinations)).toBe(anyActive);
        // Req 14.2: false for every backup-timing state while suppressed.
        // Req 14.3: exactly `backupDue` otherwise.
        expect(shouldNudgeBackup(destinations, backupDue)).toBe(anyActive ? false : backupDue);
      }),
      { numRuns: 300 },
    );
  });

  it("is driven by each destination's active definition, not its persisted enabled state", () => {
    fc.assert(
      fc.property(
        fc.array(arbInactiveActivity, { maxLength: 4 }),
        fc.array(arbActiveActivity, { maxLength: 3 }),
        fc.boolean(),
        (inactive, active, backupDue) => {
          // Req 14.1: any number of enabled-but-inactive destinations suppresses
          // nothing; a single active one suppresses everything.
          expect(shouldSuppressBackupNudge(inactive)).toBe(false);
          expect(shouldNudgeBackup(inactive, backupDue)).toBe(backupDue);

          if (active.length > 0) {
            const mixed = [...inactive, ...active];
            expect(shouldSuppressBackupNudge(mixed)).toBe(true);
            expect(shouldNudgeBackup(mixed, backupDue)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("equals the real isBackupDue over arbitrary backup-timing state when nothing is active", () => {
    fc.assert(
      fc.property(
        arbBackupState,
        fc.array(arbInactiveActivity, { maxLength: 3 }),
        fc.array(arbActiveActivity, { minLength: 1, maxLength: 2 }),
        (state, inactive, active) => {
          installBackupState(state);
          const due = isBackupDue(state.hasData);

          // Req 14.3: the unsuppressed decision is exactly `isBackupDue(hasData)`.
          expect(shouldNudgeBackup(inactive, due)).toBe(due);
          // Req 14.2: suppressed regardless of the timing state, including
          // "never backed up" and "3+ days since the last backup".
          expect(shouldNudgeBackup([...inactive, ...active], due)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
    clearBackupState();
  });

  it("leaves the stored backup timestamps untouched, so the decision after suppression is unchanged (Req 14.10)", () => {
    fc.assert(
      fc.property(
        arbBackupState,
        fc.array(arbActiveActivity, { minLength: 1, maxLength: 3 }),
        fc.array(arbInactiveActivity, { maxLength: 3 }),
        (state, active, inactive) => {
          installBackupState(state);
          const beforeLast = localStorage.getItem(LAST_BACKUP_KEY);
          const beforeSnooze = localStorage.getItem(SNOOZE_KEY);
          // The decision that would have been produced had no suppression occurred.
          const baseline = isBackupDue(state.hasData);

          const setItem = vi.spyOn(Storage.prototype, "setItem");
          const removeItem = vi.spyOn(Storage.prototype, "removeItem");
          const clearSpy = vi.spyOn(Storage.prototype, "clear");

          // A whole suppression period: suppression on, then off again.
          expect(shouldSuppressBackupNudge([...inactive, ...active])).toBe(true);
          expect(shouldNudgeBackup([...inactive, ...active], baseline)).toBe(false);
          expect(shouldSuppressBackupNudge(inactive)).toBe(false);
          const afterSuppression = shouldNudgeBackup(inactive, isBackupDue(state.hasData));

          // Structurally: evaluating the predicate wrote to neither key.
          const touched = [...setItem.mock.calls, ...removeItem.mock.calls].map(([k]) => k);
          expect(touched).not.toContain(LAST_BACKUP_KEY);
          expect(touched).not.toContain(SNOOZE_KEY);
          expect(touched).toEqual([]);
          expect(clearSpy).not.toHaveBeenCalled();

          setItem.mockRestore();
          removeItem.mockRestore();
          clearSpy.mockRestore();

          // ...and the stored values, and therefore the decision, are identical.
          expect(localStorage.getItem(LAST_BACKUP_KEY)).toBe(beforeLast);
          expect(localStorage.getItem(SNOOZE_KEY)).toBe(beforeSnooze);
          expect(afterSuppression).toBe(baseline);
        },
      ),
      { numRuns: 200 },
    );
    clearBackupState();
  });

  it("agrees with the retired one-destination gate for a single destination", () => {
    // Task 4.1 deletes `googleSheets.shouldNudgeBackup`; until then this pins the
    // generalization to the behavior it replaces, with the old `connected` flag
    // standing in for the new activity predicate.
    fc.assert(
      fc.property(arbActivity, fc.boolean(), (a, backupDue) => {
        const connected = isDestinationActive(a);
        expect(shouldNudgeBackup([a], backupDue)).toBe(
          legacyShouldNudgeBackup(connected, backupDue),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("suppresses nothing for an empty destination list", () => {
    expect(shouldSuppressBackupNudge([])).toBe(false);
    expect(shouldNudgeBackup([], true)).toBe(true);
    expect(shouldNudgeBackup([], false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 17: Destination activity requires all four conditions
//
// Validates: Requirements 14.8, 14.9, 15.2
// ---------------------------------------------------------------------------

/** The Req 14.8/14.9/15.2 rule restated independently of the implementation. */
function expectedActive(a: DestinationActivity): boolean {
  const failing =
    a.outcome.lastOutcome === "failure" &&
    (a.outcome.lastSuccessAt === null || a.now - a.outcome.lastSuccessAt > FAILING_GRACE_MS);
  return a.enabled && a.configured && a.entitled && !failing;
}

describe("Property 17: destination activity requires all four conditions", () => {
  it("is true if and only if enabled, configured, entitled, and not failing", () => {
    fc.assert(
      fc.property(arbActivity, (a) => {
        expect(isDestinationActive(a)).toBe(expectedActive(a));
      }),
      { numRuns: 300 },
    );
  });

  it("goes inactive when any single condition is flipped off", () => {
    fc.assert(
      fc.property(arbActivity, (a) => {
        expect(isDestinationActive({ ...a, enabled: false })).toBe(false);
        expect(isDestinationActive({ ...a, configured: false })).toBe(false);
        expect(isDestinationActive({ ...a, entitled: false })).toBe(false);
        expect(
          isDestinationActive({
            ...a,
            outcome: { ...a.outcome, lastOutcome: "failure", lastSuccessAt: null },
          }),
        ).toBe(false);

        // Necessity in the other direction: with all four satisfied it is active.
        expect(
          isDestinationActive({
            ...a,
            enabled: true,
            configured: true,
            entitled: true,
            outcome: { ...a.outcome, lastOutcome: "success", lastSuccessAt: a.now },
          }),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("treats a failure as terminal only once 72 hours have passed without a success", () => {
    fc.assert(
      fc.property(arbNow, arbSuccessAge, (now, age) => {
        const base = { enabled: true, configured: true, entitled: true, now };
        const withSuccessAge = (lastOutcome: DestinationOutcome["lastOutcome"]) => ({
          ...base,
          outcome: { lastOutcome, lastSuccessAt: now - age, lastFailureAt: now },
        });

        // Strictly *more* than the grace period makes the failure terminal.
        expect(isDestinationActive(withSuccessAge("failure"))).toBe(age <= FAILING_GRACE_MS);
        // A last outcome that is not a failure is never failing, however old the
        // last success is.
        expect(isDestinationActive(withSuccessAge("success"))).toBe(true);
        expect(isDestinationActive(withSuccessAge(null))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("pins the 72-hour boundary and the never-succeeded case", () => {
    const now = 1_700_000_000_000;
    const base = { enabled: true, configured: true, entitled: true, now };
    const failedWithSuccessAt = (lastSuccessAt: number | null) =>
      isDestinationActive({
        ...base,
        outcome: { lastOutcome: "failure" as const, lastSuccessAt, lastFailureAt: now },
      });

    expect(FAILING_GRACE_MS).toBe(72 * 3_600_000);
    // One ms inside the window: still active.
    expect(failedWithSuccessAt(now - (FAILING_GRACE_MS - 1))).toBe(true);
    // Exactly on the boundary: still active (the rule is "no success within 72h").
    expect(failedWithSuccessAt(now - FAILING_GRACE_MS)).toBe(true);
    // One ms past it: inactive.
    expect(failedWithSuccessAt(now - (FAILING_GRACE_MS + 1))).toBe(false);
    // Never succeeded, last outcome a failure: inactive immediately.
    expect(failedWithSuccessAt(null)).toBe(false);
  });
});
