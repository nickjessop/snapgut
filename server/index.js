import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { VertexAI } from "@google-cloud/vertexai";
import { getStore, isPro, entitlement, FREE_AI_LIMIT, metricDay } from "./store.js";
import {
  signToken,
  verifyToken,
  generateCode,
  hashCode,
  safeEqualHex,
} from "./auth.js";
import { sendCode } from "./email.js";
import { annotateIngredients, lookupSlug } from "./foodDict.js";
import { registerSyncRoutes, purgeEventData, logSyncRequest, errorLabel } from "./sync.js";
import { clientIp } from "./clientIp.js";
// Route resolution derived from the Route_Table (Requirement 2.1). Mounted at the
// bottom of this file, after every /api/* guard and handler (Requirement 2.8).
import { registerSiteRoutes } from "./routes.js";
// Route classes for the aggregate page-view counter, from the same Route_Table
// every other layer reads, so a new Marketing_Page is counted without an edit here.
import { isAppPath, isMarketingPath, LOGIN_PATH } from "../shared/site.js";
// Per-class Cache-Control, X-Robots-Tag, Content-Type, and Content-Security-Policy,
// from the design's route resolution table (Requirements 2.7, 8.6, 8.9, 11.1,
// 11.4, 11.5, 11.7, 12.1–12.5).
import { applySiteHeaders } from "./headers.js";
// The Plan_Catalog lives in shared/ so the pricing page and the billing routes
// read one definition (Requirements 7.6, 9.3, 9.8).
import { PLANS } from "../shared/plans.js";

const PORT = Number(process.env.PORT) || 8080;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
// Cheapest multimodal option; override with VERTEX_MODEL if needed.
const MODEL = process.env.VERTEX_MODEL || "gemini-2.5-flash-lite";
// Mock mode: return fake foods so you can test the full app without GCP.
// Auto-on when MOCK_AI=1 or when no project is configured.
const MOCK_AI = process.env.MOCK_AI === "1" || !PROJECT;

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

const IS_PROD = process.env.NODE_ENV === "production";

// Fail fast: a forgeable session secret in production is critical.
if (IS_PROD && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production (tokens are otherwise forgeable).");
}

// Fail fast: the Datastore_Backend defaults to an in-process map, which loses
// every account, entitlement, and rate-limit window on the next revision. A
// misconfigured revision must refuse to serve rather than take live sign-ups
// into a store that is about to disappear (Requirement 18.3).
if (IS_PROD && process.env.USERS_BACKEND !== "firestore") {
  throw new Error(
    'USERS_BACKEND must be "firestore" in production ' +
      "(the in-process store loses every account on the next revision)."
  );
}

// Whether `/api/billing/checkout` may take its simulated branch, which grants Pro
// — up to and including Lifetime — with no payment.
//
// Deliberately *not* a boot failure, unlike the two guards above. A missing Stripe
// key is Degraded, not Fatal (docs/configuration.md): billing disappearing costs
// upgrades, while refusing to boot costs logging, recognition, sync, and every
// marketing route as well. But "unreachable because the key happens to be
// mounted" is not a guarantee — the simulated grant must be impossible in
// production regardless of configuration, so it is gated on NODE_ENV here and the
// route answers 503 instead (Requirement 18.10, same spirit as 18.3).
const SIMULATE_CHECKOUT = !STRIPE_SECRET && !IS_PROD;

if (IS_PROD && !STRIPE_SECRET) {
  // Loud, once, at boot: the revision is serving with billing switched off. No
  // value is logged, only its absence.
  console.error(
    "billing disabled: STRIPE_SECRET_KEY is not set; " +
      "/api/billing/checkout, /portal and /webhook refuse rather than simulate."
  );
}

const app = new Hono();

// ---- security middleware ----
const MAX_BODY = 8 * 1024 * 1024; // 8 MB (a downscaled meal photo is ~1–2 MB base64)

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  if (IS_PROD) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  // Adds Cache-Control, X-Robots-Tag, Content-Type, and the Content-Security-Policy
  // for the class this path belongs to — the base policy everywhere, plus that
  // page's JSON-LD hashes on a Marketing_Page (Requirements 11.4, 11.5). The
  // policy lives in ./csp.js; nothing above is weakened and the /foods/*
  // immutable directive is deliberately left alone.
  applySiteHeaders(c);
});

// Reject oversized payloads early (mainly guards /api/recognize image uploads).
app.use("/api/*", async (c, next) => {
  if (Number(c.req.header("content-length") || 0) > MAX_BODY) {
    return c.json({ error: "payload_too_large" }, 413);
  }
  return next();
});

// ---- rate limiting (shared via the store, so it holds across instances) ----
// The Client_IP derivation lives in `./clientIp.js`, shared with the sync
// limiter, and honours TRUSTED_PROXY so a client-supplied forwarding header
// cannot mint a fresh bucket (Req 14.1, 14.1a, 14.2).

// Cap auth abuse (email bombing / code brute force) per IP.
app.use("/api/auth/*", async (c, next) => {
  const store = await getStore();
  if (!(await store.rateLimit(`auth-ip:${clientIp(c)}`, 20, 60_000))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  return next();
});

// ---- aggregate counters ----
//
// Per-day totals per event name. No identifier is recorded anywhere in this
// path: not an IP, not a Session_Token, not a cookie, not a user agent, and no
// per-request row that could later be correlated. The store keeps
// `{ day, name, count }` and nothing else, so the data cannot answer "who" or
// "when" beyond the day, only "how many".
//
// That is a deliberate ceiling, not an oversight. It supports the launch funnel
// (visits → first log → sign-up → AI use) and cannot support anonymous cohort
// retention, which would need a per-device id. Retention is therefore measured
// only for accounts, from `createdAt` and `lastSeenDay` on the user record.
//
// Known limitation, worth remembering when reading the numbers: a page view is a
// request, so crawlers and preview bots are counted. Treat `view:*` as an upper
// bound and the client-reported log events as the honest signal.

/** Fire-and-forget: a counter must never delay or fail the response it counts. */
function count(name) {
  getStore()
    .then((store) => store.incMetric?.(name))
    .catch(() => {});
}

/** Count document loads by route class. Assets, `/api/*`, and errors are skipped. */
app.use("*", async (c, next) => {
  await next();
  if (c.req.method !== "GET" || c.res.status !== 200) return;
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/")) return;
  if (isMarketingPath(path)) count(`view:${path === "/" ? "home" : path.slice(1)}`);
  else if (isAppPath(path)) count("view:app");
  else if (path === LOGIN_PATH) count("view:login");
});

/**
 * The two events the Origin_Server cannot observe: a log was saved, and it was
 * this device's first. Logging writes to IndexedDB and never reaches the network,
 * so without this the effect of deferring sign-in would be invisible.
 *
 * Unauthenticated by design — the whole point is to count anonymous visitors —
 * so it is rate-limited per IP and accepts only the two names below. The IP is
 * used for the limit and is not recorded. See `src/metrics.ts` for the client
 * half and for what it deliberately does not send.
 */
const METRIC_EVENTS = new Set(["first_log", "log_saved"]);

/**
 * A client-reported build id, reduced to something safe to use as part of a
 * document key. Shared by every client on a deploy, so it identifies a release and
 * not a person — but it arrives from the client, so it is bounded and filtered to a
 * conservative character set rather than trusted.
 */
function safeBuild(value) {
  const raw = typeof value === "string" ? value : "";
  const clean = raw.replace(/[^A-Za-z0-9.+-]/g, "").slice(0, 32);
  return clean || "unknown";
}

app.post("/api/metrics", async (c) => {
  const store = await getStore();
  if (!(await store.rateLimit(`metrics-ip:${clientIp(c)}`, 60, 60_000))) {
    // Answered as success: a dropped counter is not the client's problem, and a
    // 429 here would surface as an error in a path that must never do that.
    return c.body(null, 204);
  }
  const body = await c.req.json().catch(() => null);
  const event = typeof body?.event === "string" ? body.event : "";
  if (METRIC_EVENTS.has(event)) {
    count(event);
    // Counted a second time under the build, so the plain name stays comparable
    // across releases while a regression can still be pinned to one.
    count(`${event}@${safeBuild(body?.build)}`);
  }
  return c.body(null, 204);
});

// ---- auth helpers ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bearer(c) {
  const h = c.req.header("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}
function sessionEmail(c) {
  return verifyToken(bearer(c));
}

let stripe = null;
async function getStripe() {
  if (!stripe) {
    const Stripe = (await import("stripe")).default;
    stripe = new Stripe(STRIPE_SECRET);
  }
  return stripe;
}

const MOCK_MEALS = [
  {
    dish: "Ramen bowl",
    confident: ["Wheat noodles", "Egg", "Kale", "Green onion"],
    maybe: ["Soy sauce", "Sesame oil"],
    maybeFromNote: ["Palm oil", "MSG", "Dried vegetables"],
  },
  {
    dish: "Grilled chicken plate",
    confident: ["Grilled chicken", "White rice", "Broccoli"],
    maybe: ["Olive oil", "Garlic"],
    maybeFromNote: ["Butter", "Salt"],
  },
  {
    dish: "Avocado toast",
    confident: ["Avocado", "Sourdough bread", "Poached egg"],
    maybe: ["Chili flakes", "Olive oil"],
    maybeFromNote: ["Wheat", "Butter"],
  },
  {
    dish: "Burger and fries",
    confident: ["Beef patty", "Burger bun", "Fries", "Lettuce"],
    maybe: ["Cheese", "Ketchup"],
    maybeFromNote: ["Onion", "Vegetable oil"],
  },
];

let model = null;
function getModel() {
  if (!model) {
    if (!PROJECT) {
      throw new Error("GOOGLE_CLOUD_PROJECT env var is not set");
    }
    const vertex = new VertexAI({ project: PROJECT, location: LOCATION });
    model = vertex.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });
  }
  return model;
}

function recognizePrompt(note) {
  return `You are a food recognition assistant for a gut-health app. Analyze the meal photo
and identify the dish and its ingredients, separated by how sure you are.

${note ? `The user added this context about the meal: "${note}". Use it to correct the dish name and to add likely ingredients that aren't visible (e.g. an instant ramen pack implies wheat noodles, palm oil, MSG, dried vegetables).` : ""}

Return ONLY compact JSON in exactly this shape:
{
  "dish": "short dish name",
  "ingredients": [
    { "name": "ingredient", "confidence": "confident" | "maybe" }
  ]
}

Rules:
- "confident" = clearly visible in the photo OR explicitly implied by the user's note.
- "maybe" = plausible given the dish/context but not clearly visible.
- Use short, common, singular ingredient names (e.g. "Egg", "Kale", "Wheat noodles").
- Max 10 ingredients total. If there is no food, return {"dish":"","ingredients":[]}.`;
}

function sanitizeMeal(parsed) {
  const dish = typeof parsed?.dish === "string" && parsed.dish ? parsed.dish : "Meal";
  const ingredients = Array.isArray(parsed?.ingredients)
    ? parsed.ingredients
        .filter((i) => i && typeof i.name === "string")
        .map((i) => ({
          name: i.name,
          confidence: i.confidence === "maybe" ? "maybe" : "confident",
        }))
        .slice(0, 10)
    : [];
  return { dish, ingredients };
}

// Mock: derive a plausible structured meal, folding the note into "maybe" items.
function mockMeal(note) {
  const base = MOCK_MEALS[Math.floor(Math.random() * MOCK_MEALS.length)];
  const meal = {
    dish: base.dish,
    ingredients: base.confident.map((name) => ({ name, confidence: "confident" })),
  };
  if (note) {
    base.maybeFromNote.forEach((name) =>
      meal.ingredients.push({ name, confidence: "maybe" })
    );
    if (/ramen|instant|packet|pack/i.test(note)) meal.dish = "Instant ramen";
  } else {
    base.maybe.forEach((name) => meal.ingredients.push({ name, confidence: "maybe" }));
  }
  return meal;
}

app.post("/api/recognize", async (c) => {
  try {
    const email = sessionEmail(c);
    if (!email) return c.json({ error: "unauthorized" }, 401);

    const store = await getStore();
    const user = (await store.getUser(email)) || (await store.upsertUser(email));
    const pro = isPro(user);
    if (!pro && (user.freeAiUsed ?? 0) >= FREE_AI_LIMIT) {
      return c.json({ error: "upgrade_required", entitlement: entitlement(user) }, 402);
    }

    const { image, mimeType, note } = await c.req.json();
    if (!image) return c.json({ error: "missing image" }, 400);

    let meal;
    if (MOCK_AI) {
      await new Promise((r) => setTimeout(r, 700)); // simulate latency
      meal = mockMeal(note);
    } else {
      const result = await getModel().generateContent({
        contents: [
          {
            role: "user",
            parts: [
              { text: recognizePrompt(note) },
              { inlineData: { mimeType: mimeType || "image/jpeg", data: image } },
            ],
          },
        ],
      });
      const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      meal = { dish: "Meal", ingredients: [] };
      try {
        meal = sanitizeMeal(JSON.parse(text));
      } catch {
        // model returned non-JSON; leave default
      }
    }

    // Resolve each ingredient to a canonical food id (+ trigger tags) once, here, so
    // images / scoring / FODMAP tagging downstream all join on the same key. Coverage
    // gaps are reported with the canonical id (or "unknown" for foods missing from
    // the dictionary) — see recordMissingFood.
    meal.ingredients = await annotateIngredients(meal.ingredients, recordMissingFood);

    if (!pro) await store.incFreeAi(email); // count a free-trial use
    count("ai_recognize");
    return c.json({ ...meal, entitlement: entitlement(await store.getUser(email)) });
  } catch (err) {
    console.error("recognize error:", err);
    return c.json({ error: "server_error" }, 500);
  }
});

// ---- Insights: layered prompts over an on-device evidence summary ----

const BASE_INSIGHT_PROMPT = `You are a careful, evidence-based gut-health analyst inside a food/symptom
tracking app. You are given a SUMMARY of one person's own logged data (already
aggregated on their device). Your job is to help them notice patterns and decide
what to explore next.

Hard rules:
- Describe ASSOCIATIONS, never causation. Never diagnose or name a disease as
  their condition. Do not say "you have IBS/SIBO/etc."
- Ground every claim in the numbers provided. Never invent data.
- Reference general, well-established mechanisms where relevant (FODMAP groups,
  the gut-brain axis, histamine, meal timing) in plain language.
- Be encouraging and concise. Suggest ONE concrete, safe next step (often a
  structured single-variable self-test).
- If symptoms are severe/persistent, gently suggest discussing with a clinician.

Return ONLY compact JSON:
{"headline": "short takeaway", "body": "2-4 short paragraphs", "redFlag": "optional; only if red-flag symptoms are implied"}`;

const FOCUS_PROMPTS = {
  "fodmap-suspect": `Focus: the data suggests certain FODMAP groups may track with symptoms.
Explain the relevant FODMAP group(s) simply and propose a structured
reintroduction-style test: eat that single group in isolation for a few days and
watch symptoms, keeping everything else stable.`,
  "histamine-suspect": `Focus: systemic symptoms (skin, flushing, headache, palpitations) appear
alongside higher-histamine foods (aged/fermented/cured/alcohol). Explain histamine
intolerance as a possibility to explore, and suggest a short low-histamine trial.`,
  "meal-timing": `Focus: symptoms appear more after late-evening eating. Explain the meal-timing/
digestion angle and suggest shifting the largest meal earlier as a test.`,
  "gut-brain": `Focus: symptoms don't track clearly with specific foods, which can point toward
the gut-brain axis (stress, sleep, routine). Suggest logging stress/sleep and note
that food may not be the main driver.`,
  "insufficient-data": `Focus: there isn't enough data yet. Encourage logging a handful more meals and
symptoms so patterns can emerge. Keep it light and motivating.`,
};

function mockInsight(summary) {
  const s = summary || {};
  const focus = s.focus || "insufficient-data";
  const top = s.topSymptoms?.[0]?.label;
  const assoc = s.associations?.[0];
  const templates = {
    "insufficient-data": {
      headline: "Keep logging — patterns are coming",
      body: `You've logged ${s.mealCount ?? 0} meals and ${s.symptomCount ?? 0} symptom check-ins so far. A few more days will let me line up meals against the symptoms that follow them and surface reliable associations.`,
    },
    "fodmap-suspect": {
      headline: assoc
        ? `${assoc.trigger} keeps showing up with ${assoc.symptom}`
        : "A FODMAP group may be involved",
      body: `In your logs, ${assoc ? `${assoc.trigger.toLowerCase()} appeared with ${assoc.symptom.toLowerCase()} ${assoc.count} times (${Math.round((assoc.confidence ?? 0) * 100)}% of the time you ate it)` : "some high-FODMAP foods line up with symptom days"}. FODMAPs are fermentable carbs that can draw water and produce gas in the gut.\n\nTry a simple self-test: for the next 3–4 days, keep meals steady but isolate that one group, and watch whether ${top ? top.toLowerCase() : "symptoms"} follow. That's the same logic as a FODMAP reintroduction.\n\nThis is a pattern, not a diagnosis — worth bringing to a dietitian if it holds up.`,
    },
    "histamine-suspect": {
      headline: "Systemic symptoms are tracking with aged/fermented foods",
      body: `Your logs show whole-body symptoms (like flushing, skin, or headache) alongside higher-histamine foods such as aged cheese, cured meat, fermented items, or alcohol. That combination sometimes points to histamine sensitivity rather than classic FODMAP gas.\n\nAs a test, try a few lower-histamine days and see if those systemic symptoms ease. Keep logging so we can tell the two patterns apart.`,
    },
    "meal-timing": {
      headline: "Late meals may be driving next-day bloating",
      body: `Symptoms show up more often when you eat later in the evening. Digestion slows at night, which can leave you feeling bloated the next morning.\n\nTry moving your largest meal a few hours earlier for a week and watch whether ${top ? top.toLowerCase() : "symptoms"} settle.`,
    },
    "gut-brain": {
      headline: "Food isn't the obvious driver — look wider",
      body: `Your symptoms don't line up cleanly with specific foods yet. That can point toward the gut-brain axis, where stress and sleep influence gut symptoms.\n\nTry adding a quick stress/sleep note to your logs so we can check that angle next.`,
    },
  };
  return templates[focus] || templates["insufficient-data"];
}

app.post("/api/insights", async (c) => {
  try {
    const email = sessionEmail(c);
    if (!email) return c.json({ error: "unauthorized" }, 401);

    const store = await getStore();
    const user = (await store.getUser(email)) || (await store.upsertUser(email));
    const pro = isPro(user);
    if (!pro && (user.freeAiUsed ?? 0) >= FREE_AI_LIMIT) {
      return c.json({ error: "upgrade_required", entitlement: entitlement(user) }, 402);
    }

    const { summary } = await c.req.json();

    let out;
    if (MOCK_AI) {
      await new Promise((r) => setTimeout(r, 600));
      out = mockInsight(summary);
    } else {
      const focus = summary?.focus || "insufficient-data";
      const prompt = `${BASE_INSIGHT_PROMPT}\n\n${FOCUS_PROMPTS[focus] || FOCUS_PROMPTS["insufficient-data"]}\n\nSUMMARY:\n${JSON.stringify(summary)}`;
      const result = await getModel().generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      try {
        out = JSON.parse(text);
      } catch {
        out = { headline: "Insight", body: text };
      }
    }

    if (!pro) await store.incFreeAi(email);
    count("ai_insights");
    return c.json({ ...out, entitlement: entitlement(await store.getUser(email)) });
  } catch (err) {
    console.error("insights error:", err);
    return c.json({ error: "server_error" }, 500);
  }
});

// ---- Auth (email + verification code) ----

app.post("/api/auth/request", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email || !EMAIL_RE.test(email)) return c.json({ error: "invalid_email" }, 400);
    const key = email.trim().toLowerCase();

    const store = await getStore();
    // Per-email throttle (shared): at most one code request per 30s.
    if (!(await store.rateLimit(`auth-email:${key}`, 1, 30_000))) {
      return c.json({ error: "too_soon" }, 429);
    }

    const code = generateCode();
    await store.setCode(key, {
      hash: hashCode(code),
      expiresAt: Date.now() + 10 * 60_000,
      attempts: 0,
    });
    const res = await sendCode(key, code);
    // In dev (no Resend), return the code so the client can auto-fill.
    return c.json({ ok: true, dev: res.dev === true, code: res.dev ? res.code : undefined });
  } catch (err) {
    console.error("auth/request error:", err);
    return c.json({ error: "server_error" }, 500);
  }
});

app.post("/api/auth/verify", async (c) => {
  try {
    const { email, code } = await c.req.json();
    if (!email || !code) return c.json({ error: "missing" }, 400);
    const key = email.trim().toLowerCase();
    const store = await getStore();
    const rec = await store.getCode(key);
    if (!rec || Date.now() > rec.expiresAt) return c.json({ error: "expired" }, 400);
    if (rec.attempts >= 5) return c.json({ error: "too_many_attempts" }, 429);

    if (!safeEqualHex(rec.hash, hashCode(code))) {
      await store.setCode(key, { ...rec, attempts: rec.attempts + 1 });
      return c.json({ error: "wrong_code" }, 400);
    }

    await store.clearCode(key);
    const existing = await store.getUser(key);
    const user = await store.upsertUser(key);
    // A first verification is a sign-up; a later one is a returning visitor
    // signing in on a new device or after clearing storage. Counting them apart
    // is what makes the funnel readable — repeat sign-ins would otherwise look
    // like growth.
    count(existing ? "signin_return" : "signup_new");
    return c.json({ token: signToken(key), email: key, ...entitlement(user) });
  } catch (err) {
    console.error("auth/verify error:", err);
    return c.json({ error: "server_error" }, 500);
  }
});

app.get("/api/me", async (c) => {
  const email = sessionEmail(c);
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const store = await getStore();
  const user = (await store.getUser(email)) || (await store.upsertUser(email));
  // The client calls this once per launch, so it is the natural place to record a
  // day-granular last-seen — the one field account retention is computed from. A
  // same-day repeat writes the identical value. Fire-and-forget: a failed write
  // must not turn a session check into an error.
  void store.touchUser?.(email).catch(() => {});
  return c.json({ email: user.email, ...entitlement(user) });
});

// Delete everything the service holds for the user: stored Event_Records and
// Tombstones first, then the user record (entitlement + auth code). Local device
// data (IndexedDB, token) is wiped client-side after this succeeds.
//
// The order is the requirement, not a preference (Req 17.1). Removing the user
// record first would drop the entitlement that `/api/sync/*` checks, leaving the
// stored events unreachable through any authenticated path — orphaned data with no
// way left to ask for its deletion. Purging first means a failure anywhere leaves
// an account that still works and a request the client can simply repeat, and
// repeating is safe: a purge of an already-empty user succeeds (Req 17.2).
app.post("/api/account/delete", async (c) => {
  const email = sessionEmail(c);
  if (!email) return c.json({ error: "unauthorized" }, 401);

  // Step 1 — events. On failure: no user record removed, entitlement intact,
  // Session_Token still valid, and an error status so the client retains its local
  // data and offers a retry rather than wiping (Req 17.2, 17.7, 18.11).
  const purge = await purgeEventData(email);
  if (!purge.ok) {
    // One redacted line, same shape as the sync routes: the reason is one of
    // `purgeEventData`'s two fixed codes, never a store error's message, and no
    // Event_Record content or token can reach it (Req 18.4, 18.5).
    logSyncRequest({
      method: c.req.method,
      path: c.req.path,
      status: 500,
      records: 0,
      user: email,
      reason: `delete_incomplete_${purge.reason}`,
    });
    return c.json({ error: "delete_incomplete" }, 500);
  }

  // Step 2 — the user record. Only now, and success only after this returns.
  const store = await getStore();
  try {
    await store.deleteUser(email);
  } catch (err) {
    // The events are gone; the account is not. Reported as incomplete so the
    // client keeps its local copy and retries, which then only has step 2 left.
    // Logged by the error's *class name* alone — not its message, not its stack,
    // and not the thrown value, either of which a store is free to build out of
    // the data it was handed (Req 18.5).
    logSyncRequest({
      method: c.req.method,
      path: c.req.path,
      status: 500,
      records: purge.deleted,
      user: email,
      reason: "delete_incomplete_user_record",
      error: errorLabel(err),
    });
    return c.json({ error: "delete_incomplete" }, 500);
  }

  logSyncRequest({
    method: c.req.method,
    path: c.req.path,
    status: 200,
    records: purge.deleted,
    user: email,
    reason: "deleted",
  });
  return c.json({ ok: true, deleted: purge.deleted });
});

// ---- Billing (Stripe; dev-simulated without keys) ----

function proUntilFor(plan) {
  const p = PLANS[plan];
  return p?.durationMs == null ? null : Date.now() + p.durationMs;
}

app.get("/api/billing/plans", (c) =>
  c.json(
    Object.entries(PLANS).map(([id, p]) => ({
      id,
      price: p.price,
      label: p.label,
      caption: p.caption,
      per: p.per,
    }))
  )
);

app.post("/api/billing/checkout", async (c) => {
  const email = sessionEmail(c);
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const { plan } = await c.req.json().catch(() => ({}));
  const chosen = PLANS[plan] ? plan : "annual";

  if (!STRIPE_SECRET) {
    // Production never simulates: granting Pro without payment is a revenue and
    // trust problem, whereas an unavailable upgrade is a degraded product. Answer
    // before touching the store, so the refusal cannot write entitlement.
    if (!SIMULATE_CHECKOUT) return c.json({ error: "billing_unavailable" }, 503);
    // Dev only: simulate a successful purchase → grant Pro immediately.
    const user = await (await getStore()).setPro(email, proUntilFor(chosen));
    return c.json({ simulated: true, ...entitlement(user) });
  }

  const p = PLANS[chosen];
  const origin = c.req.header("origin") || `https://${c.req.header("host")}`;
  const s = await getStripe();
  const session = await s.checkout.sessions.create({
    mode: p.mode, // subscription | payment
    customer_email: email,
    line_items: [{ price: process.env[p.priceEnv], quantity: 1 }],
    success_url: `${origin}/?upgraded=1`,
    cancel_url: `${origin}/?upgraded=0`,
    metadata: { email, plan: chosen },
  });
  return c.json({ url: session.url });
});

// Stripe customer billing portal (manage/cancel a subscription). Requires a live
// Stripe key and a stored customer id (set the first time a real checkout completes).
app.post("/api/billing/portal", async (c) => {
  const email = sessionEmail(c);
  if (!email) return c.json({ error: "unauthorized" }, 401);
  if (!STRIPE_SECRET) return c.json({ error: "billing_disabled" }, 400);

  const store = await getStore();
  const user = await store.getUser(email);
  if (!user?.stripeCustomerId) return c.json({ error: "no_customer" }, 400);

  const origin = c.req.header("origin") || `https://${c.req.header("host")}`;
  const s = await getStripe();
  const session = await s.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${origin}/`,
  });
  return c.json({ url: session.url });
});

// ---- Stripe webhook ----
//
// Three events matter, and only three:
//
//   checkout.session.completed  — the first grant, for all three plans. Carries
//     our own `metadata.email`/`metadata.plan`, so the grant length comes from the
//     Plan_Catalog (`proUntilFor`), and `lifetime` lands as `proUntil: null`.
//   invoice.paid                — every renewal after that. Carries a customer id,
//     not an address, hence the `stripeCustomerId` lookup in the store.
//   customer.subscription.deleted — the subscription is over; stop renewing.
//
// Deliberately NOT handled: `invoice.payment_failed`. A failed charge does not
// change what the customer has already paid for — `proUntil` is already the end of
// the paid period, and it expires on its own. Stripe's own retry schedule then
// either recovers (a later `invoice.paid` extends) or gives up and cancels, which
// arrives as `customer.subscription.deleted`. Revoking on the first failed retry
// would take Pro away from someone whose card succeeds two days later. Dunning
// email is Stripe's job, not ours. Everything else falls through to a 200 below.
//
// Idempotency: Stripe retries deliveries and can deliver the same event twice, so
// every write here is a *set to an absolute instant derived from the Stripe
// object*, never an increment of what we hold. `invoice.paid` sets `proUntil` to
// the end of the period the invoice paid for; a second delivery of that same
// invoice computes the same instant and the write is a no-op. That is why no
// processed-event table is needed: the operations are idempotent by construction
// rather than by bookkeeping. The two clamps below (`Math.max` on renewal,
// `Math.min` on cancellation) keep that true when deliveries arrive out of order.

/** A Stripe Unix timestamp (seconds) as epoch ms, or null if it isn't one. */
function stripeMs(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/** Lifetime = Pro with no expiry. Nothing recurring may ever put a date on it. */
function isLifetime(user) {
  return Boolean(user?.pro) && user?.proUntil == null;
}

/**
 * The account a Stripe object belongs to.
 *
 * By recorded customer id first — that is what a renewal invoice carries. The
 * fallback matters for one real case: on a brand-new subscription, `invoice.paid`
 * can be delivered before (or concurrently with) the `checkout.session.completed`
 * that records the customer id, so the id is not linked yet. The invoice still
 * carries the address Checkout collected, and the caller writes the customer id
 * back through `setPro`, so the fallback is needed at most once per customer.
 */
async function billingUser(store, obj) {
  const byCustomer = obj?.customer ? await store.getUserByStripeCustomerId(obj.customer) : null;
  if (byCustomer) return byCustomer;
  return obj?.customer_email ? await store.getUser(obj.customer_email) : null;
}

/** End of the period a subscription is currently paid through, in epoch ms. */
function subscriptionPeriodEnd(sub) {
  // `current_period_end` sat on the subscription in older API versions and moved
  // onto each item in the 2025-03 versions; accept either rather than pinning a
  // version here.
  const top = stripeMs(sub?.current_period_end);
  if (top != null) return top;
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  const ends = items.map((i) => stripeMs(i?.current_period_end)).filter((ms) => ms != null);
  return ends.length ? Math.max(...ends) : null;
}

/** The subscription id an invoice belongs to, across API-version shapes. */
function invoiceSubscriptionId(invoice) {
  const ref = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription;
  if (typeof ref === "string") return ref;
  return typeof ref?.id === "string" ? ref.id : null;
}

/**
 * The instant an invoice has paid through, in epoch ms.
 *
 * The line items on the event payload are the authoritative record of what was
 * bought — a subscription line's `period.end` is the end of the period this
 * payment covers — and reading them needs no extra API call. When they are absent
 * (a shape we don't recognise), fall back to asking Stripe for the subscription's
 * current period end. Both are absolute instants, which is what keeps a repeat
 * delivery from granting anything extra.
 */
async function invoicePaidThrough(invoice) {
  const lines = Array.isArray(invoice?.lines?.data) ? invoice.lines.data : [];
  const ends = lines.map((l) => stripeMs(l?.period?.end)).filter((ms) => ms != null);
  if (ends.length) return Math.max(...ends);

  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return null;
  const s = await getStripe();
  return subscriptionPeriodEnd(await s.subscriptions.retrieve(subId));
}

/** A renewal was paid: hold Pro until the end of the period it paid for. */
async function onInvoicePaid(store, invoice) {
  const user = await billingUser(store, invoice);
  if (!user) return "renewal_unknown_customer";
  if (isLifetime(user)) return "renewal_lifetime_untouched";

  const paidThrough = await invoicePaidThrough(invoice);
  if (paidThrough == null) return "renewal_no_period";

  // Never shorten: a delayed delivery of an older invoice must not pull a
  // further-out expiry back. Combined with the absolute `paidThrough`, this makes
  // repeat and out-of-order deliveries converge on the same value.
  const held = typeof user.proUntil === "number" ? user.proUntil : 0;
  await store.setPro(user.email, Math.max(paidThrough, held), invoice.customer || undefined);
  return "renewal_extended";
}

/**
 * The subscription ended: stop extending, and let the period already paid for run
 * out rather than cutting access off at the moment the event arrives.
 *
 * Both ways this event is reached argue for the same thing. A voluntary cancel in
 * the billing portal is `cancel_at_period_end`, so Stripe sends this *at* the
 * period end — "run out the period" and "revoke now" coincide, and the customer
 * keeps exactly what they paid for. An involuntary cancel after repeated payment
 * failure arrives only once Stripe's retry schedule is exhausted, weeks past the
 * period end, so the paid-through instant is already in the past and Pro is
 * already gone: no grace period is being handed to a non-paying customer.
 *
 * `Math.min` is the whole revocation: it can only bring the expiry in, never push
 * it out, so a duplicate delivery — or one that lands after a renewal we already
 * processed — settles on the same instant.
 */
async function onSubscriptionDeleted(store, sub) {
  const user = await billingUser(store, sub);
  if (!user) return "cancel_unknown_customer";
  // A lifetime purchase is not what this subscription sold, so it is not this
  // event's to revoke.
  if (isLifetime(user)) return "cancel_lifetime_untouched";

  const paidThrough = subscriptionPeriodEnd(sub) ?? stripeMs(sub?.ended_at) ?? Date.now();
  const held = typeof user.proUntil === "number" ? user.proUntil : paidThrough;
  await store.setPro(user.email, Math.min(held, paidThrough));
  return "cancel_scheduled";
}

/**
 * One line per delivery: the event type and what we did about it.
 *
 * The vocabulary is fixed and derived here — no customer id, no email, no amount,
 * and never the event object, whose `data.object` is a full Stripe record. Same
 * reasoning as `logSyncRequest`: a caught error contributes its class name only.
 */
function logBillingEvent(type, outcome, error) {
  const safe = (v) =>
    String(v)
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 60);
  const line =
    `billing event=${safe(type)} outcome=${safe(outcome)}` + (error ? ` error=${safe(error)}` : "");
  if (error) console.error(line);
  else console.log(line);
}

app.post("/api/billing/webhook", async (c) => {
  if (!STRIPE_SECRET) return c.json({ error: "billing_disabled" }, 400);
  const sig = c.req.header("stripe-signature");
  const raw = await c.req.text();
  let evt;
  try {
    const s = await getStripe();
    evt = s.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return c.text("bad signature", 400);
  }

  const store = await getStore();
  let outcome = "ignored";
  try {
    switch (evt.type) {
      case "checkout.session.completed": {
        const obj = evt.data.object;
        const m = obj.metadata || {};
        if (m.email) {
          await store.setPro(m.email, proUntilFor(m.plan), obj.customer || undefined);
          outcome = "checkout_granted";
        } else {
          outcome = "checkout_no_metadata";
        }
        break;
      }
      case "invoice.paid":
        outcome = await onInvoicePaid(store, evt.data.object);
        break;
      case "customer.subscription.deleted":
        outcome = await onSubscriptionDeleted(store, evt.data.object);
        break;
      default:
        // Everything Stripe sends that we don't act on is acknowledged, so it is
        // not redelivered for days against a handler that will never want it.
        outcome = "ignored";
    }
  } catch (err) {
    // A store or Stripe API failure mid-grant is the one case worth a retry: the
    // writes above are idempotent, so redelivery is safe, and swallowing it would
    // silently drop a renewal and expire a paying customer.
    logBillingEvent(evt.type, "error", errorLabel(err));
    return c.json({ error: "webhook_error" }, 500);
  }

  logBillingEvent(evt.type, outcome);
  return c.json({ received: true });
});

app.get("/api/health", (c) => c.json({ ok: true }));

// ---- Cloud sync (own module so tests can mount it without a listener) ----
registerSyncRoutes(app);

// ---- Food illustration pack ----
// Served same-origin out of a PRIVATE GCS bucket (org policy forbids public
// buckets, and same-origin means no CSP img-src change). The pack is thousands of
// small immutable WebPs, so it's kept out of the repo/container and edge-cached by
// Cloud CDN on the load balancer via the long Cache-Control below — the Edge runs in
// origin-headers mode, so this header is the whole cache policy (infra/loadbalancer.ts).
const FOOD_PACK_BUCKET = process.env.FOOD_PACK_BUCKET || "REDACTED-GCP-PROJECT-pack";
let bucket = null;
async function getFoodBucket() {
  if (!bucket) {
    const { Storage } = await import("@google-cloud/storage");
    bucket = new Storage().bucket(FOOD_PACK_BUCKET);
  }
  return bucket;
}

app.get("/foods/:file", async (c) => {
  const file = c.req.param("file");
  // Only ever serve the generated pack filenames (no traversal, no other objects).
  if (!/^[a-z0-9-]+\.webp$/.test(file)) return c.text("not found", 404);
  try {
    const [buf] = await (await getFoodBucket()).file(`foods/${file}`).download();
    c.header("Content-Type", "image/webp");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(buf);
  } catch (err) {
    if (err?.code === 404) {
      // Secondary signal (mainly for events logged before canonicalisation existed).
      // The client probes several slug variants per food, so only count slugs that are
      // real canonical foods — otherwise every guess would pollute the tally.
      const slug = file.replace(/\.webp$/, "");
      lookupSlug(slug)
        .then((hit) => hit && recordMissingFood(slug, "no_image"))
        .catch(() => {});
      return c.text("not found", 404); // client falls back to an avatar
    }
    console.error("food pack error:", err?.message);
    return c.text("unavailable", 502);
  }
});

/**
 * Tally a food-image coverage gap. Aggregate only — slug, reason, count and
 * timestamp, never linked to a user (food names are health-adjacent).
 * Fire-and-forget so a logging hiccup never affects the response.
 */
function recordMissingFood(slug, reason = "no_image") {
  getStore()
    .then((store) => store.recordMissingFood?.(slug, reason))
    .catch(() => {});
}

// Ops: which logged foods have no illustration yet (drives the next generation
// batch). Requires ADMIN_TOKEN; returns aggregate counts only, no user data.
app.get("/api/admin/missing-foods", async (c) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return c.json({ error: "not_configured" }, 404);
  if (c.req.header("x-admin-token") !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const store = await getStore();
  const limit = Math.min(Number(c.req.query("limit") || 200), 1000);
  return c.json({ missing: (await store.listMissingFoods?.(limit)) ?? [] });
});

/**
 * Ops: the launch funnel. Requires ADMIN_TOKEN. Returns daily aggregate counts
 * and account totals — no email, no IP, no per-visitor row, nothing that
 * identifies anyone.
 *
 * `?days=N` bounds the window (default 30). `accounts.seenSince` and
 * `accounts.createdSince` together give retention for accounts: how many exist,
 * how many were created inside a window, and how many have been seen inside one.
 * Anonymous retention is deliberately absent — see the note on the counter
 * middleware above for why.
 */
app.get("/api/admin/metrics", async (c) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return c.json({ error: "not_configured" }, 404);
  if (c.req.header("x-admin-token") !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const store = await getStore();
  const days = Math.min(Math.max(Number(c.req.query("days") || 30), 1), 400);
  const dayMs = 86_400_000;
  const dayAgo = (n) => metricDay(Date.now() - n * dayMs);

  const events = (await store.listMetrics?.(dayAgo(days))) ?? [];
  // Roll the daily rows up per event name so the response leads with the totals
  // and keeps the per-day series underneath it.
  const totals = {};
  for (const e of events) totals[e.name] = (totals[e.name] ?? 0) + (e.count ?? 0);

  let accounts = null;
  try {
    accounts = await store.userStats?.({
      d2: dayAgo(2),
      d7: dayAgo(7),
      d30: dayAgo(30),
    });
  } catch (err) {
    // A count aggregation can fail on a missing index; the daily counters are the
    // more important half and must still be readable.
    console.error("metrics userStats error:", err?.message);
  }

  return c.json({ since: dayAgo(days), totals, accounts, events });
});

// ---- Route_Table resolution (must come after every /api/* route above) ----
// Marketing pages, the App_Shell at /login and /app/*, real files in dist/, the
// trailing-slash 301, and a terminal 404 carrying the not-found document. The
// old `app.get("*", …App_Shell)` catch-all is gone: it answered every typo with
// the sign-in form and status 200 (Requirements 2.2–2.6, 2.9, 3.8).
registerSiteRoutes(app);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`SnapGut server on http://localhost:${info.port}`);
});
