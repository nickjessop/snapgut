/**
 * Warm the food illustrations the user is most likely to see next.
 *
 * The images are already cached properly — Workbox runtime-caches `/foods/*`
 * CacheFirst, and `imageCache.ts` remembers misses so a known 404 is not
 * re-requested. What is slow is the *first* sight of an uncached one, which is
 * every food in a fresh install and every newly logged food after that. A list of
 * thumbnails popping in one by one is the visible symptom.
 *
 * So this fills the cache during the moment after launch when the app is idle
 * anyway, ordered by how often the user actually logs each food. Nothing here
 * changes what is cached or for how long; it only changes *when*.
 *
 * Deliberately modest: a bounded number of requests, issued after first paint, at
 * low priority, and abandoned silently on any failure. A preloader that competes
 * with the screen the user is looking at is worse than no preloader.
 */

import { getEvents, confidentIngredients, foodKey, type MealEvent } from "./db";
import { packUrls } from "./foodImages";
import { isMissing } from "./imageCache";

/** How many distinct foods to warm. Past this the returns are not worth the bytes. */
const MAX_FOODS = 40;

/** Only the recent past predicts the next screen; older logs are noise here. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

let done = false;

/**
 * Request one image without rendering it. `new Image()` rather than `fetch` so the
 * browser treats it as a picture — it lands in the same cache the `<img>` will read
 * from, and it inherits image priority rather than competing as an XHR.
 */
function warm(url: string): void {
  const img = new Image();
  // Hints, not guarantees; both are ignored where unsupported.
  img.decoding = "async";
  img.loading = "lazy";
  (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
  img.src = url;
}

/**
 * Run once per session, after the first view has painted.
 *
 * Never rejects: this is an optimisation, and an optimisation that can break a
 * launch is a bug. An unavailable IndexedDB, an empty log, and a failed request all
 * end the same way — silently.
 */
export async function preloadFoodImages(): Promise<void> {
  if (done) return;
  done = true;

  try {
    const events = await getEvents();
    const since = Date.now() - WINDOW_MS;

    // Count how often each food appears, so the warm order matches what the user
    // actually eats rather than what they logged first.
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.type !== "meal" || e.createdAt < since) continue;
      for (const ing of confidentIngredients(e as MealEvent)) {
        const key = foodKey(ing);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FOODS);

    for (const [key] of ranked) {
      // Skip foods already known to have no illustration: re-requesting a 404 costs
      // a round trip and warms nothing.
      if (isMissing(key)) continue;
      // The first candidate only. `packUrls` returns slug variants to try in order,
      // and speculatively fetching every variant would mostly fetch 404s.
      const [url] = packUrls(key);
      if (url) warm(url);
    }
  } catch {
    /* an optimisation must never surface a failure */
  }
}

/**
 * Schedule the warm-up for a moment the main thread is free, so it cannot delay the
 * first paint it exists to improve. Falls back to a timeout where
 * `requestIdleCallback` is missing (notably Safari).
 */
export function schedulePreload(): void {
  const run = () => void preloadFoodImages();
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (typeof idle === "function") idle(run);
  else setTimeout(run, 1200);
}
