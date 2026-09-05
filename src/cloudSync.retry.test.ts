import { describe, expect, it } from "vitest";
import {
  AUTO_RETRY_MIN_INTERVAL_MS,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  formatCursor,
  parseCursor,
  retryGate,
  type TriggerReason,
} from "./cloudSync";

// Feature: cloud-sync — task 8.8
//
// Unit tests for the two pure helpers task 8.7 added: the Sync_Cursor codec and
// the retry gate.
//
// _Requirements: 11.11, 19.8_
//
// The codec's contract is total in both directions — `parseCursor` answers `null`
// rather than throwing for every unusable token, and `formatCursor` never emits a
// token `parseCursor` refuses — so the tests here are a catalogue of malformed
// shapes plus the round trip.
//
// The gate's contract is that the answer is the *longer* of the two waits that
// apply, not a precedence chain, so each case below pins one corner of that
// maximum: a 429 longer than the 60 s floor, a 429 shorter than the remaining
// floor, the floor's exemption for user- and event-initiated triggers, the
// boundary at exactly 60 s, and the backwards-clock clamp.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An arbitrary but fixed "now"; nothing here depends on the wall clock. */
const NOW = 1_700_000_000_000;

/** Every reason exempt from the Req 11.11 floor (Req 11.1–11.4, 11.9). */
const USER_TRIGGERED: readonly TriggerReason[] = [
  "local-write",
  "cold-launch",
  "manual",
  "reconnect",
  "foreground",
];

function gate(input: {
  now?: number;
  lastFailureEndedAt?: number | null;
  rateLimitedUntil?: number | null;
  reason: TriggerReason;
}) {
  return retryGate({
    now: input.now ?? NOW,
    lastFailureEndedAt: input.lastFailureEndedAt ?? null,
    rateLimitedUntil: input.rateLimitedUntil ?? null,
    reason: input.reason,
  });
}

// ---------------------------------------------------------------------------
// Cursor codec — malformed and absent tokens
// ---------------------------------------------------------------------------

describe("parseCursor rejects unusable tokens", () => {
  it("returns null for an absent token", () => {
    expect(parseCursor(null)).toBeNull();
    // A `meta` read for a key that was never written surfaces as `undefined`;
    // the guard is a `typeof` check precisely so that stays non-throwing.
    expect(parseCursor(undefined as unknown as string)).toBeNull();
  });

  it("returns null for a non-string value read back from storage", () => {
    for (const value of [0, 1, {}, [], true, Number.NaN] as unknown[]) {
      expect(parseCursor(value as string)).toBeNull();
    }
  });

  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["", "empty string"],
    ["1", "no separator"],
    ["12", "no separator, multiple digits"],
    ["1:2:3", "extra separator"],
    ["1::2", "doubled separator"],
    [":", "separator only"],
    [":2", "missing epoch"],
    ["1:", "missing sequence"],
    [" 1:2", "leading whitespace"],
    ["1:2 ", "trailing whitespace"],
    ["1: 2", "whitespace around the separator"],
    ["1:2\n", "trailing newline"],
    ["a:b", "non-numeric components"],
    ["1:b", "non-numeric sequence"],
    ["a:2", "non-numeric epoch"],
    ["-1:2", "signed epoch"],
    ["1:-2", "signed sequence"],
    ["+1:2", "explicitly signed epoch"],
    ["1.5:2", "fractional epoch"],
    ["1:2.5", "fractional sequence"],
    ["1e3:2", "exponential epoch"],
    ["0x1:2", "hex epoch"],
    ["Infinity:2", "non-finite epoch"],
    ["NaN:NaN", "NaN components"],
    ["1;2", "wrong separator"],
    ["1,2", "comma separator"],
  ];

  it.each(malformed)("returns null for %j (%s)", (token) => {
    expect(parseCursor(token)).toBeNull();
  });

  it("returns null for a component past Number.MAX_SAFE_INTEGER", () => {
    // Beyond the safe range the integer comparison the Sync_Service does on the
    // sequence would stop being exact, so an inexact token is no cursor at all.
    expect(parseCursor(`${Number.MAX_SAFE_INTEGER + 2}:0`)).toBeNull();
    expect(parseCursor(`0:${Number.MAX_SAFE_INTEGER + 2}`)).toBeNull();
    expect(parseCursor("99999999999999999999:0")).toBeNull();
  });

  it("never throws for any input", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      "",
      ":",
      "🙂:🙂",
      "\u0000:\u0000",
      "1:2:3:4",
      Symbol.iterator.toString(),
    ];
    for (const token of hostile) {
      expect(() => parseCursor(token as string)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Cursor codec — accepted tokens and the round trip
// ---------------------------------------------------------------------------

describe("parseCursor reads well-formed tokens", () => {
  it("reads the epoch and sequence as integers", () => {
    expect(parseCursor("0:0")).toEqual({ epoch: 0, sequence: 0 });
    expect(parseCursor("3:41")).toEqual({ epoch: 3, sequence: 41 });
    expect(parseCursor(`0:${Number.MAX_SAFE_INTEGER}`)).toEqual({
      epoch: 0,
      sequence: Number.MAX_SAFE_INTEGER,
    });
  });
});

describe("formatCursor always emits a parseable token", () => {
  it("round-trips ordinary counter values", () => {
    for (const [epoch, sequence] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [7, 1234],
      [0, Number.MAX_SAFE_INTEGER],
      [Number.MAX_SAFE_INTEGER, 0],
    ] as ReadonlyArray<readonly [number, number]>) {
      expect(parseCursor(formatCursor(epoch, sequence))).toEqual({ epoch, sequence });
    }
  });

  it("normalizes out-of-domain components rather than emitting an unreadable token", () => {
    // The values only ever come from the Sync_Service's own counters, so this is
    // a totality guard: the codec must not be the thing that loses a cursor.
    const hostile: ReadonlyArray<readonly [number, number]> = [
      [-1, -1],
      [-0.5, 2.9],
      [Number.NaN, 4],
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [1e30, 1e30],
    ];
    for (const [epoch, sequence] of hostile) {
      const parsed = parseCursor(formatCursor(epoch, sequence));
      expect(parsed).not.toBeNull();
      expect(Number.isSafeInteger(parsed!.epoch)).toBe(true);
      expect(Number.isSafeInteger(parsed!.sequence)).toBe(true);
      expect(parsed!.epoch).toBeGreaterThanOrEqual(0);
      expect(parsed!.sequence).toBeGreaterThanOrEqual(0);
    }
  });

  it("truncates towards zero and floors negatives at 0", () => {
    expect(formatCursor(2.9, 3.9)).toBe("2:3");
    expect(formatCursor(-5, -5)).toBe("0:0");
  });
});

// ---------------------------------------------------------------------------
// Retry gate — nothing outstanding
// ---------------------------------------------------------------------------

describe("retryGate with no wait outstanding", () => {
  it("allows every reason when the last cycle did not fail and no 429 is live", () => {
    for (const reason of [...USER_TRIGGERED, "auto-retry"] as TriggerReason[]) {
      expect(gate({ reason })).toEqual({ allowed: true, waitMs: 0 });
    }
  });

  it("allows a trigger once an expired 429 wait has elapsed", () => {
    expect(gate({ reason: "manual", rateLimitedUntil: NOW - 1 })).toEqual({
      allowed: true,
      waitMs: 0,
    });
    // The boundary: the wait ends *at* `rateLimitedUntil`, so that instant passes.
    expect(gate({ reason: "manual", rateLimitedUntil: NOW })).toEqual({
      allowed: true,
      waitMs: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Retry gate — the Requirement 11.11 automatic-retry floor
// ---------------------------------------------------------------------------

describe("retryGate enforces the 60 s automatic-retry floor", () => {
  it("blocks an auto-retry for the full interval after the failed cycle ended", () => {
    expect(gate({ reason: "auto-retry", lastFailureEndedAt: NOW })).toEqual({
      allowed: false,
      waitMs: AUTO_RETRY_MIN_INTERVAL_MS,
    });
    expect(
      gate({ reason: "auto-retry", lastFailureEndedAt: NOW - 20_000 }),
    ).toEqual({ allowed: false, waitMs: 40_000 });
    expect(
      gate({ reason: "auto-retry", lastFailureEndedAt: NOW - (AUTO_RETRY_MIN_INTERVAL_MS - 1) }),
    ).toEqual({ allowed: false, waitMs: 1 });
  });

  it("allows an auto-retry at exactly 60 s after the failure", () => {
    expect(
      gate({ reason: "auto-retry", lastFailureEndedAt: NOW - AUTO_RETRY_MIN_INTERVAL_MS }),
    ).toEqual({ allowed: true, waitMs: 0 });
    expect(
      gate({ reason: "auto-retry", lastFailureEndedAt: NOW - (AUTO_RETRY_MIN_INTERVAL_MS + 1) }),
    ).toEqual({ allowed: true, waitMs: 0 });
  });

  it("measures the floor from the end of the failed cycle, so waiting it out passes", () => {
    const blocked = gate({ reason: "auto-retry", lastFailureEndedAt: NOW - 15_000 });
    expect(blocked.allowed).toBe(false);
    expect(
      gate({
        reason: "auto-retry",
        now: NOW + blocked.waitMs,
        lastFailureEndedAt: NOW - 15_000,
      }),
    ).toEqual({ allowed: true, waitMs: 0 });
  });

  it("exempts every user- and event-initiated reason from the floor", () => {
    // Req 11.11 only applies while no trigger from Req 11.1–11.4 or 11.9 has
    // occurred since the failure; each of these reasons *is* such a trigger.
    for (const reason of USER_TRIGGERED) {
      expect(gate({ reason, lastFailureEndedAt: NOW })).toEqual({
        allowed: true,
        waitMs: 0,
      });
    }
  });

  it("clamps a backwards clock jump to at most a full 60 s", () => {
    // The device clock moved back, so the recorded failure timestamp sits in the
    // future. Without the clamp the retry would be parked for the whole jump.
    for (const jump of [1, 60_001, 86_400_000, 10 * 365 * 86_400_000]) {
      expect(gate({ reason: "auto-retry", lastFailureEndedAt: NOW + jump })).toEqual({
        allowed: false,
        waitMs: AUTO_RETRY_MIN_INTERVAL_MS,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Retry gate — the Requirement 19.8 rate-limit wait
// ---------------------------------------------------------------------------

describe("retryGate enforces the 429 wait", () => {
  it("blocks every reason while a 429 wait is live, 'Sync now' included", () => {
    for (const reason of [...USER_TRIGGERED, "auto-retry"] as TriggerReason[]) {
      expect(gate({ reason, rateLimitedUntil: NOW + 12_000 })).toEqual({
        allowed: false,
        waitMs: 12_000,
      });
    }
  });

  it("blocks a non-auto reason exempt from the floor but subject to a live 429", () => {
    for (const reason of USER_TRIGGERED) {
      // Floor irrelevant (exempt), 429 live: the 429 alone decides.
      expect(
        gate({ reason, lastFailureEndedAt: NOW, rateLimitedUntil: NOW + 3_000 }),
      ).toEqual({ allowed: false, waitMs: 3_000 });
    }
  });

  it("takes precedence when the 429 wait is longer than 60 s", () => {
    // Req 11.11: "SHALL apply instead the wait imposed by Requirement 19.8
    // WHERE that wait is longer than 60 seconds."
    const rateLimitWait = 120_000;
    expect(
      gate({
        reason: "auto-retry",
        lastFailureEndedAt: NOW - 1_000, // floor has 59 s left
        rateLimitedUntil: NOW + rateLimitWait,
      }),
    ).toEqual({ allowed: false, waitMs: rateLimitWait });

    // Also longer than a floor that has only just started.
    expect(
      gate({
        reason: "auto-retry",
        lastFailureEndedAt: NOW,
        rateLimitedUntil: NOW + rateLimitWait,
      }),
    ).toEqual({ allowed: false, waitMs: rateLimitWait });
  });

  it("leaves the floor in force when the 429 wait is shorter than the remaining floor", () => {
    // The two waits compose as a maximum, so an expired 429 does not release an
    // automatic retry early.
    expect(
      gate({
        reason: "auto-retry",
        lastFailureEndedAt: NOW - 10_000, // floor has 50 s left
        rateLimitedUntil: NOW + 5_000,
      }),
    ).toEqual({ allowed: false, waitMs: 50_000 });

    // The same input, exempt from the floor, waits out only the 429.
    expect(
      gate({
        reason: "manual",
        lastFailureEndedAt: NOW - 10_000,
        rateLimitedUntil: NOW + 5_000,
      }),
    ).toEqual({ allowed: false, waitMs: 5_000 });
  });

  it("reports a wait that, once elapsed, lets the same input through", () => {
    const input = {
      reason: "auto-retry" as TriggerReason,
      lastFailureEndedAt: NOW - 30_000,
      rateLimitedUntil: NOW + 90_000,
    };
    const blocked = gate(input);
    expect(blocked).toEqual({ allowed: false, waitMs: 90_000 });
    expect(gate({ ...input, now: NOW + blocked.waitMs })).toEqual({
      allowed: true,
      waitMs: 0,
    });
  });

  it("treats an unmeasurable 429 deadline as the default wait", () => {
    // A wait this module cannot measure is one it has not seen elapse, so it
    // falls back to the 60 s Req 19.8 imposes when a 429 reports no seconds.
    expect(
      gate({ reason: "manual", rateLimitedUntil: Number.POSITIVE_INFINITY }),
    ).toEqual({ allowed: false, waitMs: DEFAULT_RATE_LIMIT_WAIT_MS });
    expect(gate({ reason: "manual", rateLimitedUntil: Number.NaN })).toEqual({
      allowed: false,
      waitMs: DEFAULT_RATE_LIMIT_WAIT_MS,
    });
  });
});
