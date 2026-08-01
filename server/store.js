// Data store for users, entitlement, auth codes, and rate limits.
// Backends (USERS_BACKEND): "memory" (dev, default) | "firestore" (prod).
//
// Entitlement model (no credits): a user is either Pro (unlimited AI) or on a
// free trial of FREE_AI_LIMIT AI actions shared across snaps + insight generations.
//
// rateLimit() lives in the store so limits/throttles are SHARED across Cloud Run
// instances (in-memory backend is per-process and only suitable for local dev).

const BACKEND = process.env.USERS_BACKEND === "firestore" ? "firestore" : "memory";

export const FREE_AI_LIMIT = Number(process.env.FREE_AI_LIMIT ?? 10);

const norm = (email) => String(email || "").trim().toLowerCase();

/**
 * How long a Coverage_Tally entry outlives its last sighting before Firestore expires it.
 * Every `recordMissingFood` write pushes it out again, so a food that is still being logged
 * never expires and one that stopped being logged ages out (Requirement 19.3).
 */
const MISSING_FOOD_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * How long a daily metric bucket is kept. Long enough to read a launch cohort
 * months later, and bounded so the collection cannot grow without limit.
 *
 * Unlike `rateLimits`, these documents hold no personal data at all — a UTC day,
 * an event name, and an integer — so the expiry is housekeeping rather than a
 * privacy control, and a missing TTL policy is a storage cost rather than a
 * disclosure. `expireAt` is written regardless so a policy can be added later
 * without a migration.
 */
const METRIC_TTL_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months

/** The UTC day an instant belongs to, as `YYYY-MM-DD`. */
export function metricDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The `rateLimits` document a request at `nowMs` belongs to, and the instant that document
 * may be deleted (Requirement 19.4).
 *
 * `rateLimit()` counts per fixed window: a request at instant `t` reads and writes the
 * document keyed `<key>:<floor(t / windowMs)>`. So the document for bucket `b` is consulted
 * only by requests in `[b * windowMs, (b + 1) * windowMs)` and stops being able to affect a
 * limit decision at exactly `(b + 1) * windowMs`, when the key changes and a fresh document
 * takes over.
 *
 * The expiry here is `(b + 2) * windowMs` — one whole window past the earliest instant that
 * would be correct. The margin is deliberate: `b` comes from the calling instance's clock
 * while the deletion is scheduled against Firestore's, and expiring a counter early silently
 * raises the limit (an attacker's requests stop being counted), whereas expiring it late
 * costs one small document for one extra window. Both errors are not equally bad, so the
 * bound is set on the safe side.
 *
 * Derived from the bucket rather than from `nowMs`, so every write within a window computes
 * the identical value and the merge never moves the expiry.
 */
export function rateLimitWindow(nowMs, windowMs) {
  const bucket = Math.floor(nowMs / windowMs);
  return { bucket, expireAtMs: (bucket + 2) * windowMs };
}

function newUser(email) {
  return {
    email: norm(email),
    pro: false,
    proUntil: null,
    freeAiUsed: 0,
    stripeCustomerId: null,
    createdAt: Date.now(),
    // Last time this account was seen by `/api/me`, rounded to the day. Retention
    // for accounts is measurable from this and `createdAt` without any new
    // identifier, because an account already is one. Day granularity is
    // deliberate: it answers "did they come back" without recording a schedule.
    lastSeenDay: metricDay(),
  };
}

/** True if the user currently has Pro (lifetime = null proUntil; else not expired). */
export function isPro(user) {
  if (!user?.pro) return false;
  return user.proUntil == null || user.proUntil > Date.now();
}

/** Public entitlement snapshot for the client. */
export function entitlement(user) {
  return {
    pro: isPro(user),
    proUntil: user?.proUntil ?? null,
    freeAiUsed: user?.freeAiUsed ?? 0,
    freeAiLimit: FREE_AI_LIMIT,
  };
}

// ---- in-memory (dev) ----
function memoryStore() {
  const users = new Map();
  const codes = new Map();
  const rl = new Map(); // key -> timestamps[]
  const missing = new Map(); // food slug -> { slug, count, lastSeen }
  const metrics = new Map(); // `${day}:${name}` -> { day, name, count }
  return {
    async incMetric(name, day = metricDay()) {
      const key = `${day}:${name}`;
      const rec = metrics.get(key) || { day, name, count: 0 };
      rec.count += 1;
      metrics.set(key, rec);
    },
    async listMetrics(sinceDay) {
      return [...metrics.values()]
        .filter((m) => !sinceDay || m.day >= sinceDay)
        .sort((a, b) => (a.day === b.day ? a.name.localeCompare(b.name) : a.day < b.day ? 1 : -1));
    },
    async touchUser(email, day = metricDay()) {
      const u = users.get(norm(email));
      if (u) u.lastSeenDay = day;
    },
    async userStats(dayCutoffs) {
      const all = [...users.values()];
      const count = (from) => all.filter((u) => (u.lastSeenDay ?? "") >= from).length;
      return {
        total: all.length,
        seenSince: Object.fromEntries(
          Object.entries(dayCutoffs).map(([label, day]) => [label, count(day)])
        ),
        createdSince: Object.fromEntries(
          Object.entries(dayCutoffs).map(([label, day]) => [
            label,
            all.filter((u) => metricDay(u.createdAt ?? 0) >= day).length,
          ])
        ),
      };
    },
    async recordMissingFood(slug, reason = "no_image") {
      const rec = missing.get(slug) || { slug, count: 0, lastSeen: 0, reason };
      rec.count += 1;
      rec.lastSeen = Date.now();
      rec.reason = reason;
      missing.set(slug, rec);
    },
    async listMissingFoods(limit = 200) {
      return [...missing.values()].sort((a, b) => b.count - a.count).slice(0, limit);
    },
    async getUser(email) {
      return users.get(norm(email)) || null;
    },
    /**
     * The user a Stripe object belongs to, by the customer id recorded the first
     * time a real checkout completed. A renewal webhook (`invoice.paid`) carries a
     * customer id rather than an address, so this is the only reliable join from a
     * Stripe event back to an account.
     */
    async getUserByStripeCustomerId(customerId) {
      const id = String(customerId || "");
      if (!id) return null;
      for (const u of users.values()) if (u.stripeCustomerId === id) return u;
      return null;
    },
    async upsertUser(email) {
      const key = norm(email);
      let u = users.get(key);
      if (!u) {
        u = newUser(key);
        users.set(key, u);
      }
      return u;
    },
    async setPro(email, proUntil, customerId) {
      const u = users.get(norm(email));
      if (!u) return null;
      u.pro = true;
      u.proUntil = proUntil ?? null;
      if (customerId) u.stripeCustomerId = customerId;
      return u;
    },
    async incFreeAi(email) {
      const u = users.get(norm(email));
      if (!u) return 0;
      u.freeAiUsed += 1;
      return u.freeAiUsed;
    },
    async deleteUser(email) {
      const key = norm(email);
      users.delete(key);
      codes.delete(key);
    },
    async getCode(email) {
      return codes.get(norm(email)) || null;
    },
    async setCode(email, rec) {
      codes.set(norm(email), rec);
    },
    async clearCode(email) {
      codes.delete(norm(email));
    },
    async rateLimit(key, max, windowMs) {
      const now = Date.now();
      const arr = (rl.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      rl.set(key, arr);
      return arr.length <= max;
    },
  };
}

// ---- Firestore (prod) ----
async function firestoreStore() {
  const { Firestore, FieldValue, Timestamp } = await import("@google-cloud/firestore");
  const db = new Firestore();
  const usersCol = db.collection("users");
  const codesCol = db.collection("authCodes");
  const rlCol = db.collection("rateLimits");
  const missingCol = db.collection("missingFoods");
  const metricsCol = db.collection("metrics");
  return {
    /**
     * One document per UTC day per event name, holding a count and nothing else.
     * No identifier, no session, no per-request row — so the collection cannot be
     * mined for a visitor's behaviour even in principle, only for daily totals.
     */
    async incMetric(name, day = metricDay()) {
      const now = Date.now();
      await metricsCol.doc(`${day}:${name}`).set(
        {
          day,
          name,
          count: FieldValue.increment(1),
          expireAt: Timestamp.fromMillis(now + METRIC_TTL_MS),
        },
        { merge: true }
      );
    },
    /**
     * Ordered newest day first. `day` is a lexicographically sortable
     * `YYYY-MM-DD`, so the range filter and the ordering are the same field and
     * Firestore's automatic single-field index serves both — no composite index.
     */
    async listMetrics(sinceDay) {
      let q = metricsCol.orderBy("day", "desc");
      if (sinceDay) q = metricsCol.where("day", ">=", sinceDay).orderBy("day", "desc");
      const snap = await q.limit(2000).get();
      return snap.docs.map((d) => {
        const { expireAt, ...rest } = d.data();
        return rest;
      });
    },
    /**
     * Day-granular last-seen. Written on `/api/me`, which the client calls once
     * per launch, so this is one small merge per session rather than per request.
     * A same-day repeat writes the identical value, which keeps it idempotent.
     */
    async touchUser(email, day = metricDay()) {
      await usersCol.doc(norm(email)).set({ lastSeenDay: day }, { merge: true });
    },
    async userStats(dayCutoffs) {
      const total = (await usersCol.count().get()).data().count;
      const countWhere = async (field, from) =>
        (await usersCol.where(field, ">=", from).count().get()).data().count;
      const seenSince = {};
      const createdSince = {};
      for (const [label, day] of Object.entries(dayCutoffs)) {
        seenSince[label] = await countWhere("lastSeenDay", day);
        // `createdAt` is epoch ms, so the cutoff is converted rather than compared
        // as a string. Both are single-field range filters.
        createdSince[label] = (
          await usersCol.where("createdAt", ">=", Date.parse(`${day}T00:00:00Z`)).count().get()
        ).data().count;
      }
      return { total, seenSince, createdSince };
    },
    /**
     * A logged food we can't illustrate. `reason` is "no_image" (a known canonical
     * food we haven't drawn yet) or "unknown" (not in the food dictionary at all).
     * Aggregate counts only — slug, reason, tally, timestamp; never linked to a user.
     *
     * `expireAt` is a Firestore `Timestamp`, which is the only type the TTL policy on this
     * collection acts on, and is refreshed on every write.
     */
    async recordMissingFood(slug, reason = "no_image") {
      const now = Date.now();
      await missingCol.doc(slug).set(
        {
          slug,
          reason,
          count: FieldValue.increment(1),
          lastSeen: now,
          expireAt: Timestamp.fromMillis(now + MISSING_FOOD_TTL_MS),
        },
        { merge: true }
      );
    },
    /**
     * Ordered by `count` descending, which Firestore's automatic single-field index serves
     * — every field is indexed ascending and descending by default, so no composite index
     * is declared for it (Requirement 19.6, verified with
     * `gcloud firestore indexes composite list`, which is empty).
     *
     * `expireAt` is stripped so the response carries the documented four fields and matches
     * the in-memory backend, rather than leaking a serialised Timestamp into
     * `/api/admin/missing-foods`.
     */
    async listMissingFoods(limit = 200) {
      const snap = await missingCol.orderBy("count", "desc").limit(limit).get();
      return snap.docs.map((d) => {
        const { expireAt, ...rest } = d.data();
        return rest;
      });
    },
    async getUser(email) {
      const snap = await usersCol.doc(norm(email)).get();
      return snap.exists ? snap.data() : null;
    },
    /**
     * The user a Stripe object belongs to, by recorded customer id (see the
     * in-memory twin above for why this join exists).
     *
     * Index: a single-field equality filter is served by Firestore's automatic
     * single-field index, so no composite index is needed as written. Two things
     * would change that — adding a second filter or an `orderBy`, or a
     * single-field index exemption on the `users` collection (which would need an
     * explicit index for `stripeCustomerId` instead). A missing index surfaces as
     * a FAILED_PRECONDITION on the query, which the webhook reports as a 500 so
     * Stripe retries rather than the renewal being silently dropped.
     */
    async getUserByStripeCustomerId(customerId) {
      const id = String(customerId || "");
      if (!id) return null;
      const snap = await usersCol.where("stripeCustomerId", "==", id).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
    },
    async upsertUser(email) {
      const ref = usersCol.doc(norm(email));
      const snap = await ref.get();
      if (snap.exists) return snap.data();
      const u = newUser(email);
      await ref.set(u);
      return u;
    },
    async setPro(email, proUntil, customerId) {
      const ref = usersCol.doc(norm(email));
      const patch = { pro: true, proUntil: proUntil ?? null };
      if (customerId) patch.stripeCustomerId = customerId;
      await ref.set(patch, { merge: true });
      return (await ref.get()).data();
    },
    async incFreeAi(email) {
      const ref = usersCol.doc(norm(email));
      await ref.update({ freeAiUsed: FieldValue.increment(1) });
      return (await ref.get()).data()?.freeAiUsed ?? 0;
    },
    async deleteUser(email) {
      const key = norm(email);
      await usersCol.doc(key).delete();
      await codesCol.doc(key).delete();
    },
    async getCode(email) {
      const snap = await codesCol.doc(norm(email)).get();
      return snap.exists ? snap.data() : null;
    },
    async setCode(email, rec) {
      await codesCol.doc(norm(email)).set(rec);
    },
    async clearCode(email) {
      await codesCol.doc(norm(email)).delete();
    },
    /**
     * Fixed-window counter shared across instances. `expireAt` must be a Firestore
     * `Timestamp` — a number is ignored by the TTL policy, so the collection would grow
     * forever (Requirement 19.3). See `rateLimitWindow` for why the expiry is derived from
     * the bucket and not from the clock.
     */
    async rateLimit(key, max, windowMs) {
      const { bucket, expireAtMs } = rateLimitWindow(Date.now(), windowMs);
      const ref = rlCol.doc(`${key}:${bucket}`);
      const count = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const n = (snap.data()?.count ?? 0) + 1;
        tx.set(ref, { count: n, expireAt: Timestamp.fromMillis(expireAtMs) }, { merge: true });
        return n;
      });
      return count <= max;
    },
  };
}

let storePromise = null;
export function getStore() {
  if (!storePromise) {
    storePromise =
      BACKEND === "firestore" ? firestoreStore() : Promise.resolve(memoryStore());
  }
  return storePromise;
}

export { norm, BACKEND };
