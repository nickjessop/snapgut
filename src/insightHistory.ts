/**
 * Past AI insights, kept on the device.
 *
 * They were generated and then thrown away: leave the Patterns tab and the narrative
 * was gone, with no way to see what it said last week or whether its read has
 * changed. For a product whose whole claim is noticing patterns over time, a
 * write-only insight is close to useless.
 *
 * Stored in the `meta` store under one key rather than in a store of their own, so
 * no schema version bump is needed — see the `MetaKey` note in `src/db.ts`. Bounded,
 * because this is a convenience record and not an archive: the cap is what keeps a
 * single `meta` row from growing without limit.
 */

import { getMeta, setMeta } from "./db";

/** One stored narrative. Mirrors the `/api/insights` response plus a timestamp. */
export interface PastInsight {
  /** Epoch ms the insight was generated. */
  at: number;
  headline: string;
  body: string;
  redFlag?: string;
  /** Meals and days behind it, so an old insight can be read in context. */
  mealCount?: number;
  dayCount?: number;
}

/** How many to keep. Past this the oldest are dropped. */
export const MAX_HISTORY = 30;

/** Two insights generated within this window are treated as the same one. */
const DEDUPE_MS = 60_000;

/** A defensive read: anything that is not a well-formed entry is discarded. */
function parse(raw: unknown): PastInsight[] {
  if (!Array.isArray(raw)) return [];
  const out: PastInsight[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) continue;
    if (typeof rec.headline !== "string" || typeof rec.body !== "string") continue;
    out.push({
      at: rec.at,
      headline: rec.headline,
      body: rec.body,
      redFlag: typeof rec.redFlag === "string" ? rec.redFlag : undefined,
      mealCount: typeof rec.mealCount === "number" ? rec.mealCount : undefined,
      dayCount: typeof rec.dayCount === "number" ? rec.dayCount : undefined,
    });
  }
  // Newest first, whatever order they were stored in.
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_HISTORY);
}

/** Every stored insight, newest first. Never rejects. */
export async function listInsights(): Promise<PastInsight[]> {
  try {
    return parse(await getMeta<unknown>("insightHistory"));
  } catch {
    // An unavailable IndexedDB must not break the Patterns view; the current
    // insight is still generated and shown, just not remembered.
    return [];
  }
}

/**
 * Record a newly generated insight. Returns the resulting list so the caller can
 * render without a second read.
 *
 * Deduplicated on a short window: Pro auto-generates on entering the tab, and React
 * effects can run twice, so the same narrative arriving twice within a minute is a
 * repeat rather than a new observation.
 */
export async function recordInsight(
  insight: Omit<PastInsight, "at">,
  now = Date.now()
): Promise<PastInsight[]> {
  const existing = await listInsights();

  const duplicate = existing.some(
    (p) =>
      p.headline === insight.headline &&
      p.body === insight.body &&
      Math.abs(p.at - now) < DEDUPE_MS
  );
  const next = duplicate
    ? existing
    : [{ at: now, ...insight }, ...existing].slice(0, MAX_HISTORY);

  if (!duplicate) {
    try {
      await setMeta("insightHistory", next);
    } catch {
      // Losing the record is acceptable; failing the insight the user asked for is
      // not. The narrative is already on screen either way.
    }
  }
  return next;
}

/** Forget every stored insight. Offered in Settings alongside the other data controls. */
export async function clearInsights(): Promise<void> {
  try {
    await setMeta("insightHistory", []);
  } catch {
    /* nothing stored, nothing to clear */
  }
}
