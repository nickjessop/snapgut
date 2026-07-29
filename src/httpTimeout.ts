// Shared timeout-aware `fetch`.
//
// Extracted verbatim from `googleSheets.ts` so both sync destinations can share
// one implementation: the Sheets/Drive REST layer
// (google-sheets-integration Req 10.1) and SnapGut Cloud, where every push and
// pull request is bounded by a genuine 30 s abort (cloud-sync Req 6.8, 7.5).
//
// This is the only timeout helper the Cloud module uses. `googleSheets.ts` keeps
// its own `withTimeout` promise race for the GIS token flow, whose pending
// callback cannot be cancelled; a plain race is the best that flow can do.

/**
 * Perform a `fetch` bounded by a real timeout with genuine cancellation.
 *
 * Unlike a plain promise race (which merely abandons the work), this wires an
 * {@link AbortController} signal directly into `fetch`, so when the `ms` budget
 * elapses the in-flight request is actually aborted. On timeout it rejects with
 * an `Error` carrying `onTimeoutMessage`; any caller-supplied `init.signal`
 * abort still propagates as the underlying fetch rejection.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
  onTimeoutMessage = "Google API request timed out",
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new Error(onTimeoutMessage);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
