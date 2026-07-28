// Data store for users, credits, and auth codes.
// - dev (default): in-memory (resets on restart) — fine for local testing.
// - prod: Firestore when USERS_BACKEND=firestore (uses ADC like Vertex AI).

const BACKEND = process.env.USERS_BACKEND === "firestore" ? "firestore" : "memory";
const FREE_CREDITS = Number(process.env.FREE_CREDITS ?? 5);

const norm = (email) => String(email || "").trim().toLowerCase();

// ---- in-memory ----
function memoryStore() {
  const users = new Map(); // email -> { email, credits, createdAt }
  const codes = new Map(); // email -> { hash, expiresAt, attempts, lastSentAt }

  return {
    async getUser(email) {
      return users.get(norm(email)) || null;
    },
    async upsertUser(email) {
      const key = norm(email);
      let u = users.get(key);
      if (!u) {
        u = { email: key, credits: FREE_CREDITS, createdAt: Date.now() };
        users.set(key, u);
      }
      return u;
    },
    async addCredits(email, n) {
      const u = users.get(norm(email));
      if (!u) return null;
      u.credits += n;
      return u.credits;
    },
    async deductCredit(email) {
      const u = users.get(norm(email));
      if (!u || u.credits <= 0) return null;
      u.credits -= 1;
      return u.credits;
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
      const key = norm(email);
      const ref = usersCol.doc(key);
      const snap = await ref.get();
      if (snap.exists) return snap.data();
      const u = { email: key, credits: FREE_CREDITS, createdAt: Date.now() };
      await ref.set(u);
      return u;
    },
    async addCredits(email, n) {
      const ref = usersCol.doc(norm(email));
      await ref.update({ credits: FieldValue.increment(n) });
      return (await ref.get()).data()?.credits ?? null;
    },
    async deductCredit(email) {
      const ref = usersCol.doc(norm(email));
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const credits = snap.data()?.credits ?? 0;
        if (credits <= 0) return null;
        tx.update(ref, { credits: credits - 1 });
        return credits - 1;
      });
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

export { FREE_CREDITS, norm, BACKEND };
