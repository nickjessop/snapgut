/**
 * The `rateLimits` expiry bound (Requirement 19.4): a counter document must not expire while
 * it can still affect a limit decision, because a counter that vanishes early silently raises
 * the limit.
 *
 * `rateLimitWindow` is the pure part of the Firestore `rateLimit()` write; the Timestamp
 * conversion and the live write are verified against the real database (task 10.5), not here.
 */

import { describe, expect, it } from "vitest";

// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { rateLimitWindow } from "../server/store.js";

const window_ = rateLimitWindow as (
  nowMs: number,
  windowMs: number
) => { bucket: number; expireAtMs: number };

// The windows actually in use: the auth throttle and per-IP/per-user sync limiters (60 s),
// and the per-email code request throttle (30 s).
const WINDOWS = [60_000, 30_000, 1_000];

describe("rateLimitWindow", () => {
  it("buckets an instant the same way rateLimit's document key does", () => {
    expect(window_(0, 60_000).bucket).toBe(0);
    expect(window_(59_999, 60_000).bucket).toBe(0);
    expect(window_(60_000, 60_000).bucket).toBe(1);
  });

  it("gives every instant in a window the identical expiry, so a merge never moves it", () => {
    const first = window_(60_000, 60_000).expireAtMs;
    const last = window_(119_999, 60_000).expireAtMs;
    expect(last).toBe(first);
  });

  it("never expires a document before the last instant that still reads it", () => {
    for (const windowMs of WINDOWS) {
      for (let i = 0; i < 200; i++) {
        const now = Math.floor(Math.random() * 2 ** 42);
        const { bucket, expireAtMs } = window_(now, windowMs);

        // The document is consulted by requests in [bucket, bucket + 1) windows; it stops
        // mattering at the end of its own window.
        const windowEnd = (bucket + 1) * windowMs;
        expect(expireAtMs).toBeGreaterThanOrEqual(windowEnd);
        expect(expireAtMs).toBeGreaterThan(now);

        // The last request that reads this document, and the first that does not.
        expect(window_(windowEnd - 1, windowMs).bucket).toBe(bucket);
        expect(window_(windowEnd, windowMs).bucket).toBe(bucket + 1);
      }
    }
  });

  it("keeps a whole window of slack for clock skew between an instance and Firestore", () => {
    for (const windowMs of WINDOWS) {
      const { bucket, expireAtMs } = window_(7 * windowMs + 13, windowMs);
      expect(expireAtMs - (bucket + 1) * windowMs).toBe(windowMs);
    }
  });
});
