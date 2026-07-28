// Data store for users, entitlement, auth codes, and rate limits.
// Backends (USERS_BACKEND): "memory" (dev, default) | "supabase" | "firestore".
//
// Entitlement model (no credits): a user is either Pro (unlimited AI) or on a
// free trial of FREE_AI_LIMIT AI actions shared across snaps + insight generations.
//
// rateLimit() lives in the store so limits/throttles are SHARED across Cloud Run
// instances (in-memory backend is per-process and only suitable for local dev).

const BACKEND =
  process.env.USERS_BACKEND === "supabase"
    ? "supabase"
    : process.env.USERS_BACKEND === "firestore"
    ? "firestore"
    : "memory";

export const FREE_AI_LIMIT = Number(process.env.FREE_AI_LIMIT ?? 10);

const norm = (email) => String(email || "").trim().toLowerCase();

function newUser(email) {
  return {
    email: norm(email),
    pro: false,
    proUntil: null,
    freeAiUsed: 0,
    stripeCustomerId: null,
    createdAt: Date.now(),
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
  return {
    async getUser(email) {
      return users.get(norm(email)) || null;
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

// ---- Supabase (prod) ----
async function supabaseStore() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const mapUser = (r) =>
    r && {
      email: r.email,
      pro: !!r.pro,
      proUntil: r.pro_until ?? null,
      freeAiUsed: r.free_ai_used ?? 0,
      stripeCustomerId: r.stripe_customer_id ?? null,
      createdAt: r.created_at,
    };

  return {
    async getUser(email) {
      const { data } = await sb.from("users").select("*").eq("email", norm(email)).maybeSingle();
      return mapUser(data);
    },
    async upsertUser(email) {
      const key2 = norm(email);
      const existing = await this.getUser(key2);
      if (existing) return existing;
      const row = { email: key2, pro: false, pro_until: null, free_ai_used: 0, created_at: Date.now() };
      // ignoreDuplicates handles a race where another instance inserted first
      await sb.from("users").upsert(row, { onConflict: "email", ignoreDuplicates: true });
      return (await this.getUser(key2)) || mapUser(row);
    },
    async setPro(email, proUntil, customerId) {
      const patch = { pro: true, pro_until: proUntil ?? null };
      if (customerId) patch.stripe_customer_id = customerId;
      await sb.from("users").update(patch).eq("email", norm(email));
      return this.getUser(email);
    },
    async incFreeAi(email) {
      const { data } = await sb.rpc("inc_free_ai", { p_email: norm(email) });
      return data ?? 0;
    },
    async deleteUser(email) {
      const key2 = norm(email);
      await sb.from("users").delete().eq("email", key2);
      await sb.from("auth_codes").delete().eq("email", key2);
    },
    async getCode(email) {
      const { data } = await sb.from("auth_codes").select("*").eq("email", norm(email)).maybeSingle();
      return data && { hash: data.hash, expiresAt: data.expires_at, attempts: data.attempts };
    },
    async setCode(email, rec) {
      await sb.from("auth_codes").upsert(
        { email: norm(email), hash: rec.hash, expires_at: rec.expiresAt, attempts: rec.attempts },
        { onConflict: "email" }
      );
    },
    async clearCode(email) {
      await sb.from("auth_codes").delete().eq("email", norm(email));
    },
    async rateLimit(key2, max, windowMs) {
      const { data, error } = await sb.rpc("rate_limit_hit", {
        p_key: key2,
        p_max: max,
        p_window_seconds: Math.ceil(windowMs / 1000),
      });
      if (error) return true; // fail-open on limiter errors (don't lock users out)
      return data === true;
    },
  };
}

// ---- Firestore (alt prod) ----
async function firestoreStore() {
  const { Firestore, FieldValue } = await import("@google-cloud/firestore");
  const db = new Firestore();
  const usersCol = db.collection("users");
  const codesCol = db.collection("authCodes");
  const rlCol = db.collection("rateLimits");
  return {
    async getUser(email) {
      const snap = await usersCol.doc(norm(email)).get();
      return snap.exists ? snap.data() : null;
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
    async rateLimit(key, max, windowMs) {
      const bucket = Math.floor(Date.now() / windowMs);
      const ref = rlCol.doc(`${key}:${bucket}`);
      const count = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const n = (snap.data()?.count ?? 0) + 1;
        tx.set(ref, { count: n, expireAt: Date.now() + windowMs }, { merge: true });
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
      BACKEND === "supabase"
        ? supabaseStore()
        : BACKEND === "firestore"
        ? firestoreStore()
        : Promise.resolve(memoryStore());
  }
  return storePromise;
}

export { norm, BACKEND };
