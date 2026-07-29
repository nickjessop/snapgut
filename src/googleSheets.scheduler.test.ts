import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createSingleFlight } from "./singleFlight";

// Feature: google-sheets-integration, Property 8: At most one sync runs, with at most one queued rerun
//
// For any number of sync triggers arriving while a sync is already in flight, the
// single-flight scheduler never runs two syncs concurrently (the observed
// concurrent-run count never exceeds one) and schedules at most one additional
// run after the in-flight one completes.
//
// Validates: Requirements 5.5

// --- controllable "deferred" promise: resolved manually by the test ---
interface Deferred {
  readonly promise: Promise<void>;
  resolve: () => void;
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Fully drain the microtask queue (the scheduler chains several
// .then()/.finally() hops per run). A macrotask tick guarantees every pending
// microtask has settled before we inspect state.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Build a controllable fake sync body plus a concurrency counter.
 *
 * On entry the body bumps a live-run counter (tracking the max ever observed)
 * and a total run counter, then parks on a manually-resolved deferred so the
 * test controls exactly when each body completes. `running` is decremented only
 * when that deferred settles.
 */
function makeFakeBody() {
  let running = 0;
  let maxConcurrent = 0;
  let runCount = 0;
  const bodies: Deferred[] = []; // one entry per started-but-unsettled body

  const body = (): Promise<void> => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    runCount++;
    const d = makeDeferred();
    bodies.push(d);
    return d.promise.finally(() => {
      running--;
    });
  };

  return {
    body,
    bodies,
    get maxConcurrent() {
      return maxConcurrent;
    },
    get runCount() {
      return runCount;
    },
  };
}

/**
 * Drive the scheduler for a single in-flight cycle: start one run, let its body
 * become active, fire `k` additional triggers while it is in flight, then release
 * bodies one at a time (flushing between) until everything settles.
 */
async function driveSingleCycle(k: number): Promise<{ maxConcurrent: number; runCount: number }> {
  const fake = makeFakeBody();
  const trigger = createSingleFlight(fake.body);

  // Start run 1 and let its body actually begin executing (running === 1).
  const p1 = trigger();
  await flush();

  // Fire k more triggers while run 1's body is genuinely in flight.
  for (let i = 0; i < k; i++) trigger();

  // Release bodies one at a time. Resolving the in-flight body lets the queued
  // rerun (if any) start and push a new deferred, which the next iteration
  // releases in turn.
  let guard = 0;
  while (fake.bodies.length > 0 && guard++ < k + 20) {
    const d = fake.bodies.shift()!;
    d.resolve();
    await flush();
  }

  await p1;
  return { maxConcurrent: fake.maxConcurrent, runCount: fake.runCount };
}

// arbTriggerSchedule: the number of triggers that arrive while a run is in
// flight (0 exercises the no-rerun case; 1..20 exercise collapsing many
// triggers into a single queued rerun).
const arbTriggerSchedule = fc.integer({ min: 0, max: 20 });

describe("createSingleFlight (Property 8: at most one sync runs, with at most one queued rerun)", () => {
  it("never runs bodies concurrently and schedules at most one queued rerun", async () => {
    await fc.assert(
      fc.asyncProperty(arbTriggerSchedule, async (k) => {
        const { maxConcurrent, runCount } = await driveSingleCycle(k);

        // (1) Two bodies never run concurrently.
        expect(maxConcurrent).toBeLessThanOrEqual(1);

        // (2) Exactly the initial run plus at most one queued rerun:
        //     k >= 1 collapses any number of in-flight triggers into a single
        //     rerun (total 2); k === 0 runs only the initial body (total 1).
        expect(runCount).toBe(k >= 1 ? 2 : 1);
      }),
      { numRuns: 100 },
    );
  });

  // --- concrete example cases ---

  it("runs exactly once when no trigger arrives during the in-flight run (k = 0)", async () => {
    const { maxConcurrent, runCount } = await driveSingleCycle(0);
    expect(runCount).toBe(1);
    expect(maxConcurrent).toBe(1);
  });

  it("runs exactly twice when one trigger arrives during the in-flight run (k = 1)", async () => {
    const { maxConcurrent, runCount } = await driveSingleCycle(1);
    expect(runCount).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it("collapses five in-flight triggers into a single rerun (k = 5)", async () => {
    const { maxConcurrent, runCount } = await driveSingleCycle(5);
    expect(runCount).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it("keeps collapsing across chained reruns without ever overlapping", async () => {
    const fake = makeFakeBody();
    const trigger = createSingleFlight(fake.body);

    // Run 1 starts and its body is in flight.
    const p1 = trigger();
    await flush();
    expect(fake.bodies.length).toBe(1);

    // Trigger while run 1 is in flight → queue run 2.
    trigger();
    // Complete run 1 → run 2 (the queued rerun) starts.
    fake.bodies.shift()!.resolve();
    await flush();
    expect(fake.bodies.length).toBe(1);
    expect(fake.runCount).toBe(2);

    // Trigger again while run 2 is in flight → queue run 3.
    trigger();
    // Complete run 2 → run 3 starts.
    fake.bodies.shift()!.resolve();
    await flush();
    expect(fake.bodies.length).toBe(1);
    expect(fake.runCount).toBe(3);

    // Complete run 3 with no pending trigger → the chain drains.
    fake.bodies.shift()!.resolve();
    await flush();
    await p1;

    expect(fake.bodies.length).toBe(0);
    expect(fake.runCount).toBe(3);
    expect(fake.maxConcurrent).toBe(1);
  });

  it("starts a fresh run for a trigger that arrives after the scheduler has drained", async () => {
    const fake = makeFakeBody();
    const trigger = createSingleFlight(fake.body);

    // First cycle: single run, no reruns.
    const p1 = trigger();
    await flush();
    fake.bodies.shift()!.resolve();
    await flush();
    await p1;
    expect(fake.runCount).toBe(1);

    // A later, independent trigger starts a brand-new run (not a queued rerun).
    const p2 = trigger();
    await flush();
    expect(fake.bodies.length).toBe(1);
    fake.bodies.shift()!.resolve();
    await flush();
    await p2;

    expect(fake.runCount).toBe(2);
    expect(fake.maxConcurrent).toBe(1);
  });
});
