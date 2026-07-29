#!/usr/bin/env node
/**
 * Expand scripts/food-list.txt with a Gemini *text* model (cents, not dollars —
 * this generates NAMES only, no images).
 *
 * Walks a fixed set of categories, asks for food/ingredient names in each, then
 * merges into the list de-duplicated by slug so it's safe to re-run and grow the
 * pack incrementally.
 *
 * Usage:
 *   node scripts/gen-food-list.mjs --target 3000        # grow the list to ~3000 names
 *   node scripts/gen-food-list.mjs --target 3000 --dry-run
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIST_FILE = path.join(__dirname, "food-list.txt");

const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const MODEL = process.env.TEXT_MODEL || "gemini-2.5-flash";
const HOST =
  LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;

/** Categories to enumerate. Broad coverage of what people actually log. */
const CATEGORIES = [
  "common fruits, including varieties (e.g. specific apple and citrus cultivars)",
  "tropical and less-common fruits",
  "berries",
  "dried fruits",
  "leafy greens and salad leaves",
  "root vegetables and tubers",
  "brassicas and cruciferous vegetables",
  "squashes, gourds and pumpkins",
  "alliums (onion/garlic family)",
  "peppers and chillies",
  "mushrooms and edible fungi",
  "sea vegetables and seaweeds",
  "legumes, beans, peas and pulses",
  "grains, cereals and pseudocereals",
  "breads and baked goods",
  "pasta and noodle types",
  "rice varieties and rice dishes",
  "breakfast cereals and porridges",
  "cow-milk dairy products",
  "cheeses from around the world",
  "yogurts and cultured dairy",
  "non-dairy milks and dairy alternatives",
  "eggs and egg dishes",
  "poultry cuts and poultry dishes",
  "beef and veal cuts",
  "pork cuts and pork products",
  "lamb, goat and game meats",
  "cured and processed meats",
  "fish fillets and whole fish",
  "shellfish and seafood",
  "plant-based proteins and meat substitutes",
  "nuts and nut butters",
  "seeds",
  "cooking oils and fats",
  "vinegars",
  "sauces and condiments",
  "spice blends and seasonings",
  "individual dried spices",
  "fresh herbs",
  "sweeteners, sugars and syrups",
  "sugar alcohols and artificial sweeteners",
  "chocolate and cocoa products",
  "biscuits, cookies and sweet snacks",
  "cakes, pastries and desserts",
  "ice creams and frozen desserts",
  "savoury snacks and crisps",
  "coffee drinks and preparations",
  "teas and herbal infusions",
  "soft drinks, juices and cordials",
  "beers, wines, spirits and cocktails",
  "fermented and pickled foods",
  "soups, broths and stews",
  "salads and salad dishes",
  "sandwiches, wraps and burgers",
  "pizza styles and toppings",
  "Italian dishes",
  "Mexican and Latin American dishes",
  "Chinese dishes",
  "Japanese dishes",
  "Korean dishes",
  "Thai and Vietnamese dishes",
  "Indian and South Asian dishes",
  "Middle Eastern and North African dishes",
  "Greek and Mediterranean dishes",
  "French dishes",
  "British and Irish dishes",
  "American diner and comfort foods",
  "Caribbean and African dishes",
  "German, Polish and Eastern European dishes",
  "Spanish and Portuguese dishes",
  "breakfast foods and brunch dishes",
  "street foods worldwide",
  "dumplings and filled doughs worldwide",
  "grilled and barbecued dishes",
  "casseroles and baked dishes",
  "rice bowls and grain bowls",
  "protein bars, shakes and supplements",
  "baby foods and purees",
  "gluten-free specialty products",
  "low-FODMAP friendly foods",
  "high-FODMAP trigger foods",
  "high-histamine foods",
  "prebiotic and probiotic foods",
  "canned and tinned goods",
  "frozen convenience foods",
  "takeaway and fast-food items",
  "garnishes and toppings",
  "spreads, jams and preserves",
  "flours and baking ingredients",
  "stocks, bouillons and cooking bases",
];

function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
  const args = { target: 3000, dryRun: false, perCategory: 45 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") args.target = Number(argv[++i]);
    else if (argv[i] === "--per-category") args.perCategory = Number(argv[++i]);
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function askForFoods(client, project, category, count, avoid) {
  const url =
    `https://${HOST}/v1/projects/${project}/locations/${LOCATION}` +
    `/publishers/google/models/${MODEL}:generateContent`;

  const prompt =
    `List ${count} distinct real food or ingredient names in the category: ${category}.\n\n` +
    `Rules:\n` +
    `- Only names a person would log after eating, in singular form.\n` +
    `- Each must be a concrete, visually depictable food (no vague terms like "healthy food").\n` +
    `- Use common English names. Keep each under 4 words.\n` +
    `- No brand names or trademarks.\n` +
    `- No duplicates and none of these already-covered items: ${avoid.slice(0, 60).join(", ")}.\n\n` +
    `Return ONLY a JSON array of strings.`;

  const res = await client.request({
    url,
    method: "POST",
    data: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 1, responseMimeType: "application/json" },
    },
  });

  const text = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "[]";
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const original = await readFile(LIST_FILE, "utf8");
  const existing = new Map(); // slug -> name
  for (const line of original.split("\n")) {
    const name = line.trim();
    if (!name || name.startsWith("#")) continue;
    existing.set(slugify(name), name);
  }
  console.log(`Current list: ${existing.size} foods · target ${args.target}`);

  if (existing.size >= args.target) {
    console.log("Target already met.");
    return;
  }
  if (args.dryRun) {
    console.log(`Would query ${CATEGORIES.length} categories × ~${args.perCategory} names.`);
    console.log("Cost: text-only, well under $1 total.");
    return;
  }

  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const project = process.env.GOOGLE_CLOUD_PROJECT || (await auth.getProjectId());
  const client = await auth.getClient();

  const added = [];
  let round = 0;
  while (existing.size < args.target && round < 4) {
    round++;
    console.log(`\n--- pass ${round} ---`);
    for (const category of CATEGORIES) {
      if (existing.size >= args.target) break;
      let names = [];
      try {
        names = await askForFoods(
          client,
          project,
          category,
          args.perCategory,
          [...existing.values()].slice(-60)
        );
      } catch (e) {
        console.warn(`  ! ${category}: ${e.message}`);
        continue;
      }
      let fresh = 0;
      for (const raw of names) {
        const name = raw.trim().replace(/\s+/g, " ");
        const slug = slugify(name);
        if (!slug || slug.length < 2 || existing.has(slug)) continue;
        if (name.length > 40) continue;
        existing.set(slug, name);
        added.push(name);
        fresh++;
        if (existing.size >= args.target) break;
      }
      console.log(`  ${category.slice(0, 46).padEnd(46)} +${fresh} (total ${existing.size})`);
    }
  }

  // Rewrite: keep the original curated file intact, append the new names.
  const appendix =
    `\n# ---------------------------------------------------------------\n` +
    `# Auto-expanded by scripts/gen-food-list.mjs (${new Date().toISOString().slice(0, 10)})\n` +
    `# ---------------------------------------------------------------\n` +
    added.join("\n") +
    "\n";
  await writeFile(LIST_FILE, original.trimEnd() + "\n" + appendix);

  console.log(`\nAdded ${added.length} new foods. List is now ${existing.size}.`);
  console.log(`Image cost if you generate all of them: ~$${(existing.size * 0.039).toFixed(2)} USD`);
}

main().catch((e) => {
  console.error(`Failed: ${e.message}`);
  process.exit(1);
});
