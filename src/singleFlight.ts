// Shared single-flight scheduler.
//
// Extracted verbatim from `googleSheets.ts` so both sync destinations can share
// one implementation: the Sheets mirror (google-sheets-integration Req 5.4, 5.5)
// and SnapGut Cloud, where it sits underneath the eligibility gate that discards
// ineligible triggers rather than queuing them (cloud-sync Req 11.5).

/**
 * Wrap an async `body` in a single-flight guard that enforces Req 5.5:
 *
 * - When no run is in flight, a trigger starts one immediately.
 * - When a run is already in flight, a trigger schedules **at most one**
 *   additional run (regardless of how many triggers arrive) and returns the
 *   in-flight promise; the queued run starts only after the current body
 *   settles, so two bodies never execute concurrently.
 *
 * The guard cleans up its state even when `body` rejects, so a failed run never
 * wedges the scheduler: the queued rerun (if any) still executes, and once the
 * chain drains the next trigger starts fresh.
 *
 * This is a pure, deterministic helper (its only state is the returned closure),
 * which makes it straightforward to drive from the concurrency property test
 * (Property 8) with a controllable fake body.
 */
export function createSingleFlight(body: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued = false;

  const run = (): Promise<void> => {
    // `body()` may throw synchronously; keep that inside the promise chain so
    // the guard state is always cleaned up in `finally`.
    return Promise.resolve()
      .then(body)
      .finally(() => {
        if (queued) {
          // Exactly one queued rerun, collapsing any number of triggers that
          // arrived during this run into a single additional run.
          queued = false;
          inFlight = run();
        } else {
          inFlight = null;
        }
      });
  };

  return function trigger(): Promise<void> {
    if (inFlight === null) {
      inFlight = run();
    } else {
      // A run is already active — schedule at most one rerun and share the
      // currently in-flight promise with the caller.
      queued = true;
    }
    return inFlight;
  };
}
