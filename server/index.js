import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { VertexAI } from "@google-cloud/vertexai";

const PORT = Number(process.env.PORT) || 8080;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
// Cheapest multimodal option; override with VERTEX_MODEL if needed.
const MODEL = process.env.VERTEX_MODEL || "gemini-2.5-flash-lite";
// Mock mode: return fake foods so you can test the full app without GCP.
// Auto-on when MOCK_AI=1 or when no project is configured.
const MOCK_AI = process.env.MOCK_AI === "1" || !PROJECT;

// Optional shared-secret gate. If APP_TOKEN is set, requests must send a
// matching "x-app-token" header. Leave unset locally.
const APP_TOKEN = process.env.APP_TOKEN;

const app = new Hono();

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
    if (APP_TOKEN && c.req.header("x-app-token") !== APP_TOKEN) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const { image, mimeType, note } = await c.req.json();
    if (!image) return c.json({ error: "missing image" }, 400);

    if (MOCK_AI) {
      await new Promise((r) => setTimeout(r, 700)); // simulate latency
      return c.json(mockMeal(note));
    }

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

    const text =
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    let meal = { dish: "Meal", ingredients: [] };
    try {
      meal = sanitizeMeal(JSON.parse(text));
    } catch {
      // model returned non-JSON; leave default
    }
    return c.json(meal);
  } catch (err) {
    console.error("recognize error:", err);
    return c.json({ error: String(err?.message || err) }, 500);
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
    if (APP_TOKEN && c.req.header("x-app-token") !== APP_TOKEN) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const { summary } = await c.req.json();

    if (MOCK_AI) {
      await new Promise((r) => setTimeout(r, 600));
      return c.json(mockInsight(summary));
    }

    const focus = summary?.focus || "insufficient-data";
    const prompt = `${BASE_INSIGHT_PROMPT}\n\n${FOCUS_PROMPTS[focus] || FOCUS_PROMPTS["insufficient-data"]}\n\nSUMMARY:\n${JSON.stringify(summary)}`;

    const result = await getModel().generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const text =
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    let out;
    try {
      out = JSON.parse(text);
    } catch {
      out = { headline: "Insight", body: text };
    }
    return c.json(out);
  } catch (err) {
    console.error("insights error:", err);
    return c.json({ error: String(err?.message || err) }, 500);
  }
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Serve the built PWA (dist/) in production.
app.use("/*", serveStatic({ root: "./dist" }));
// SPA fallback so deep links load index.html.
app.get("*", serveStatic({ path: "./dist/index.html" }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`SnapGut server on http://localhost:${info.port}`);
});
