// Data store for users, entitlement, and auth codes.
// - dev (default): in-memory (resets on restart) — fine for local testing.
// - prod: Firestore when USERS_BACKEND=firestore (uses ADC like Vertex AI).
//
// Entitlement model (no credits): a user is either Pro (unlimited AI) or on a
// free trial of FREE_AI_LIMIT AI actions shared across snaps + insight generations.

const BACKEND = process.env.USERS_BACKEND === "firestore" ? "firestore" : "memory";
export const FREE_AI_LIMIT = Number(process.env.FREE_AI_LIMIT ?? 10);

const norm = (email) => String(email || "").trim().toLowerCase();

function newUser(email) {
  return { email: norm(email), pro: false, proUntil: null, freeAiUsed: 0, createdAt: Date.now() };
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

// ---- in-memory ----
function memoryStore() {
  const users = new Map();
  const codes = new Map();
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
    async setPro(email, proUntil) {
      const u = users.get(norm(email));
      if (!u) return null;
      u.pro = true;
      u.proUntil = proUntil ?? null; // null = lifetime
      return u;
    },
    async incFreeAi(email) {
      const u = users.get(norm(email));
      if (!u) return 0;
      u.freeAiUsed += 1;
      return u.freeAiUsed;
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
  };
}

// ---- Firestore ----
async function firestoreStore() {
  const { Firestore, FieldValue } = await import("@google-cloud/firestore");
  const db = new Firestore();
  const usersCol = db.collection("users");
  const codesCol = db.collection("authCodes");
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
    async setPro(email, proUntil) {
      const ref = usersCol.doc(norm(email));
      await ref.set({ pro: true, proUntil: proUntil ?? null }, { merge: true });
      return (await ref.get()).data();
    },
    async incFreeAi(email) {
      const ref = usersCol.doc(norm(email));
      await ref.update({ freeAiUsed: FieldValue.increment(1) });
      return (await ref.get()).data()?.freeAiUsed ?? 0;
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
  };
}

let storePromise = null;
export function getStore() {
  if (!storePromise) {
    storePromise = BACKEND === "firestore" ? firestoreStore() : Promise.resolve(memoryStore());
  }
  return storePromise;
}

export { norm, BACKEND };
