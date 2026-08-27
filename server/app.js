// server/app.js — Every route, no listener. The whole server as a testable value.
//
// buildApp receives fully-opened dependencies and registers every route. The
// caller (server/main.js) is responsible for opening the datastore, creating the
// AI provider, and calling serve() on the returned app.

import { Hono } from "hono";
import { verifyToken, signToken, credentialMatches } from "./auth.js";
import { annotateIngredients, lookupSlug } from "./foodDict.js";
import { registerSyncRoutes, purgeEventData, logSyncRequest, errorLabel } from "./sync.js";
import { clientIp } from "./clientIp.js";
import { registerSiteRoutes } from "./routes.js";
import { applySiteHeaders } from "./headers.js";
import { readPackFile } from "./foodPack.js";

/**
 * Every route, no listener. The whole server as a testable value.
 * @param {{ config: import("./config.js").Config, store: object, eventStore: object,
 *           secret: string, ai: import("./ai/index.js").AiProvider,
 *           ready: { value: boolean } }} deps
 * @returns {Hono}
 */
export function buildApp(deps) {
  const { config, store, eventStore, secret, ai, ready } = deps;

  const app = new Hono();

  // ---- security middleware ----
  const MAX_BODY = 8 * 1024 * 1024; // 8 MB

  /**
   * Derive the request scheme from forwarding headers or the connection.
   * Returns "https" or "http".
   */
  function deriveScheme(c) {
    const proto = c.req.header("x-forwarded-proto");
    if (proto) return proto.split(",")[0].trim().toLowerCase();
    // Hono on node-server: c.req.raw does not expose TLS state, so fall back to http
    // when no forwarding header is present.
    return "http";
  }

  // Global REQUIRE_HTTPS guard — rejects any request whose derived scheme is not
  // https. This replaces the per-route check that was previously in server/sync.js.
  if (config.requireHttps) {
    app.use("*", async (c, next) => {
      if (deriveScheme(c) !== "https") {
        return c.json({ error: "https_required" }, 403);
      }
      return next();
    });
  }

  app.use("*", async (c, next) => {
    c._publicOrigin = config.publicOrigin;
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    // HSTS: only emit when the request actually arrived over HTTPS (Req 7.13).
    // A self-hosted instance does not control subdomains, so omit includeSubDomains.
    if (config.requireHttps && deriveScheme(c) === "https") {
      c.header("Strict-Transport-Security", "max-age=63072000");
    }
    applySiteHeaders(c);
  });

  // Reject oversized payloads early.
  app.use("/api/*", async (c, next) => {
    if (Number(c.req.header("content-length") || 0) > MAX_BODY) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    return next();
  });

  // ---- rate limiting ----
  app.use("/api/auth/*", async (c, next) => {
    if (!(await store.rateLimit(`auth-ip:${clientIp(c)}`, 20, 60_000))) {
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  });

  // ---- auth helpers ----
  function bearer(c) {
    const h = c.req.header("authorization") || "";
    return h.startsWith("Bearer ") ? h.slice(7) : null;
  }

  function sessionEmail(c) {
    return verifyToken(bearer(c), secret);
  }

  // ---- Health route (unauthenticated, Req 9.7) ----
  app.get("/api/health", (c) => c.json({ ready: ready.value, schema: 1 }));

  // ---- Recognize ----
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

  app.post("/api/recognize", async (c) => {
    try {
      const email = sessionEmail(c);
      if (!email) return c.json({ error: "unauthorized" }, 401);

      const { image, mimeType, note } = await c.req.json();
      if (!image) return c.json({ error: "missing image" }, 400);

      const prompt = recognizePrompt(note);
      const start = Date.now();
      let meal;
      try {
        const text = await ai.generate({
          prompt,
          image: { data: image, mimeType: mimeType || "image/jpeg" },
          json: true,
          signal: AbortSignal.timeout(config.ai.timeoutMs),
        });
        const elapsed = Date.now() - start;
        console.log("ai", { provider: ai.name, kind: "recognize", outcome: "ok", elapsedMs: elapsed });

        meal = { dish: "Meal", ingredients: [] };
        try {
          meal = sanitizeMeal(JSON.parse(text));
        } catch {
          // model returned non-JSON; leave default
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        const outcome = err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : "error";
        console.log("ai", { provider: ai.name, kind: "recognize", outcome, elapsedMs: elapsed });
        return c.json({ error: "ai_unavailable" }, 503);
      }

      meal.ingredients = await annotateIngredients(meal.ingredients, recordMissingFood);

      return c.json({ ...meal });
    } catch (err) {
      console.error("recognize error:", err);
      return c.json({ error: "server_error" }, 500);
    }
  });

  // ---- Insights ----
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

  app.post("/api/insights", async (c) => {
    try {
      const email = sessionEmail(c);
      if (!email) return c.json({ error: "unauthorized" }, 401);

      const { summary } = await c.req.json();

      const focus = summary?.focus || "insufficient-data";
      const prompt = `${BASE_INSIGHT_PROMPT}\n\n${FOCUS_PROMPTS[focus] || FOCUS_PROMPTS["insufficient-data"]}\n\nSUMMARY:\n${JSON.stringify(summary)}`;

      const start = Date.now();
      let out;
      try {
        const text = await ai.generate({
          prompt,
          json: true,
          signal: AbortSignal.timeout(config.ai.timeoutMs),
        });
        const elapsed = Date.now() - start;
        console.log("ai", { provider: ai.name, kind: "insights", outcome: "ok", elapsedMs: elapsed });

        try {
          out = JSON.parse(text);
        } catch {
          out = { headline: "Insight", body: text };
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        const outcome = err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : "error";
        console.log("ai", { provider: ai.name, kind: "insights", outcome, elapsedMs: elapsed });
        return c.json({ error: "ai_unavailable" }, 503);
      }

      return c.json({ ...out });
    } catch (err) {
      console.error("insights error:", err);
      return c.json({ error: "server_error" }, 500);
    }
  });

  // ---- Auth: single-credential password sign-in ----
  app.post("/api/auth/signin", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const password = body.password;

    if (
      !config.auth.password ||
      !password ||
      typeof password !== "string" ||
      password.length === 0 ||
      password.length > 256 ||
      !credentialMatches(password, config.auth.password, secret)
    ) {
      return c.json({ error: "signin_failed" }, 401);
    }

    const token = signToken(config.auth.email, secret);
    return c.json({ token, email: config.auth.email });
  });

  // ---- Me ----
  app.get("/api/me", async (c) => {
    const email = sessionEmail(c);
    if (!email) return c.json({ error: "unauthorized" }, 401);
    const user = (await store.getUser(email)) || (await store.upsertUser(email));
    return c.json({ email: user.email });
  });

  // ---- Account deletion ----
  app.post("/api/account/delete", async (c) => {
    const email = sessionEmail(c);
    if (!email) return c.json({ error: "unauthorized" }, 401);

    const purge = await purgeEventData(email, undefined, eventStore);
    if (!purge.ok) {
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

    try {
      await store.deleteUser(email);
    } catch (err) {
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

  // ---- Cloud sync ----
  registerSyncRoutes(app, { store, eventStore, secret });

  // ---- Food illustration pack ----
  app.get("/foods/:file", async (c) => {
    const file = c.req.param("file");
    const result = await readPackFile(config.foodPackDir, file);

    if (result.ok) {
      c.header("Content-Type", "image/webp");
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.body(result.bytes);
    }

    if (result.reason === "invalid") {
      return c.text("not found", 404);
    }

    if (result.reason === "missing") {
      const slug = file.replace(/\.webp$/, "");
      lookupSlug(slug)
        .then((hit) => hit && recordMissingFood(slug, "no_image"))
        .catch(() => {});
      return c.text("not found", 404);
    }

    // reason === "unreadable"
    console.error("food pack read error:", file);
    return c.text("unavailable", 502);
  });

  /**
   * Tally a food-image coverage gap. Fire-and-forget.
   */
  function recordMissingFood(slug, reason = "no_image") {
    Promise.resolve(store.recordMissingFood?.(slug, reason)).catch(() => {});
  }

  // ---- Site routes (must come after /api/* and /foods/*) ----
  registerSiteRoutes(app);

  return app;
}
