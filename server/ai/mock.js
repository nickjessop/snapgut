// Mock AI provider — returns synthetic output with no network call.
// Preserves the MOCK_MEALS recognition array and the mockInsight template logic
// from the original mock path in server/index.js.

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

/**
 * Derive a plausible structured meal from a random MOCK_MEALS entry.
 * If the prompt mentions a note context, fold maybeFromNote items into ingredients.
 * @param {string} prompt
 * @returns {object}
 */
function mockMeal(prompt) {
  const base = MOCK_MEALS[Math.floor(Math.random() * MOCK_MEALS.length)];
  const meal = {
    dish: base.dish,
    ingredients: base.confident.map((name) => ({ name, confidence: "confident" })),
  };
  // Detect whether the prompt carries a user note (the recognition prompt includes it
  // as `The user added this context about the meal: "..."`)
  const hasNote = /context about the meal/.test(prompt);
  if (hasNote) {
    base.maybeFromNote.forEach((name) =>
      meal.ingredients.push({ name, confidence: "maybe" })
    );
    if (/ramen|instant|packet|pack/i.test(prompt)) meal.dish = "Instant ramen";
  } else {
    base.maybe.forEach((name) => meal.ingredients.push({ name, confidence: "maybe" }));
  }
  return meal;
}

/**
 * Generate a mock insight response based on the prompt content.
 * Extracts a summary object from the prompt JSON when possible.
 * @param {string} prompt
 * @returns {object}
 */
function mockInsight(prompt) {
  // Try to extract the summary JSON that follows the prompt text.
  // The insight endpoint sends: system prompt + "\n\nSUMMARY:\n" + JSON.stringify(summary)
  let s = {};
  try {
    const match = prompt.match(/SUMMARY[:\s]*(\{[\s\S]*\})/i);
    if (match) s = JSON.parse(match[1]);
  } catch {
    // couldn't parse — use empty summary
  }

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

/**
 * Determine whether the prompt is a recognition request (has image context or
 * mentions food recognition) vs an insight request.
 * @param {{ prompt: string, image?: { data: string, mimeType: string } }} req
 * @returns {boolean}
 */
function isRecognitionRequest(req) {
  if (req.image) return true;
  // The recognition prompt starts with "You are a food recognition assistant"
  return /food recognition/i.test(req.prompt);
}

/**
 * Create the mock AI provider. No network calls, returns within 1000ms.
 * @param {{ model?: string }} opts
 * @returns {import("./index.js").AiProvider}
 */
export function createMockProvider({ model }) {
  return {
    name: "mock",
    model: model || "mock",
    async generate(req) {
      // Respect abort signal
      if (req.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }

      // Small random delay for realism (≤ 50ms), well under the 1000ms limit
      const delay = Math.floor(Math.random() * 50);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        if (req.signal) {
          if (req.signal.aborted) {
            clearTimeout(timer);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          req.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true }
          );
        }
      });

      if (isRecognitionRequest(req)) {
        const meal = mockMeal(req.prompt);
        return JSON.stringify(meal);
      } else {
        const insight = mockInsight(req.prompt);
        return JSON.stringify(insight);
      }
    },
  };
}
