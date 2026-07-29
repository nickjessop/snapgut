#!/usr/bin/env node
/**
 * Coverage check: for a list of food names the recogniser might plausibly return,
 * report whether the illustration pack can resolve an image (including alias and
 * plural/singular variants). Run against the local ./food-pack directory.
 *
 *   node scripts/check-coverage.mjs
 *   node scripts/check-coverage.mjs "Aubergine" "Carrots" "MSG"
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(__dirname, "..", "food-pack");

// Mirror of src/foodImages.ts (kept in sync by hand; small enough to be fine).
const src = await readFile(path.join(__dirname, "..", "src", "foodImages.ts"), "utf8");
const aliasBlock = src.slice(src.indexOf("const ALIASES"), src.indexOf("/** \"Carrots\""));
const ALIASES = Object.fromEntries(
  [...aliasBlock.matchAll(/"?([a-z0-9-]+)"?\s*:\s*"([a-z0-9-]+)"/g)].map((m) => [m[1], m[2]])
);

const slugify = (n) =>
  n.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function singularVariants(s) {
  if (!/s$/.test(s)) return [];
  const out = [];
  if (/ies$/.test(s)) out.push(s.replace(/ies$/, "y"));
  if (/oes$/.test(s)) out.push(s.replace(/oes$/, "o"));
  if (/ves$/.test(s)) { out.push(s.replace(/ves$/, "f")); out.push(s.replace(/ves$/, "fe")); }
  if (/(ches|shes|sses|xes|zes)$/.test(s)) out.push(s.replace(/es$/, ""));
  out.push(s.replace(/s$/, ""));
  if (/es$/.test(s)) out.push(s.replace(/es$/, ""));
  return out;
}
const pluralize = (s) =>
  /s$/.test(s) ? null : /y$/.test(s) ? s.replace(/y$/, "ies")
  : /(ch|sh|ss|x)$/.test(s) ? `${s}es` : `${s}s`;

function candidates(name) {
  const base = slugify(name);
  const out = [];
  const push = (s) => { if (s && s.length > 1 && !out.includes(s)) out.push(s); };
  push(base);
  push(ALIASES[base]);
  for (const s of singularVariants(base)) { push(s); push(ALIASES[s]); }
  push(pluralize(base));
  const parts = base.split("-");
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    push(last); push(ALIASES[last]);
    for (const s of singularVariants(last)) { push(s); push(ALIASES[s]); }
  }
  return out;
}

const resolve = (name) => candidates(name).find((s) => existsSync(path.join(PACK, `${s}.webp`)));

// Names a recogniser realistically emits: regional spellings, plurals, cuts, additives.
const PROBES = [
  "MSG", "Monosodium glutamate", "Yeast extract", "Inulin", "Chicory root",
  "Psyllium", "Xanthan gum", "Guar gum", "Carrageenan", "Maltodextrin", "Gluten",
  "Basil", "Fresh basil", "Cilantro", "Coriander", "Coriander leaves", "Parsley",
  "Rosemary", "Thyme", "Oregano", "Sage", "Dill", "Chives", "Mint", "Tarragon",
  "Bay leaf", "Lemongrass", "Curry leaf", "Kaffir lime leaf",
  "Cumin", "Turmeric", "Smoked paprika", "Garam masala", "Asafoetida", "Sumac",
  "Star anise", "Cardamom", "Nutmeg", "Cloves", "Saffron", "Sichuan peppercorn",
  "Aubergine", "Courgette", "Capsicum", "Rocket", "Scallions", "Garbanzo beans",
  "Carrots", "Tomatoes", "Onions", "Potatoes", "Eggs", "Strawberries",
  "Chicken breast", "Minced beef", "Prawns", "Greek yoghurt", "Whole milk",
  "Heavy cream", "Extra virgin olive oil", "All-purpose flour", "Spaghetti",
  "Roma tomato", "Cherry tomatoes", "Red onion", "Spring onion", "Chilli flakes",
  "Chicken stock", "Bouillon cube", "Dashi", "Bonito flakes", "Sourdough starter",
  "Baking soda", "Cornstarch", "Soy lecithin", "Whey protein", "Food coloring",
];

const names = process.argv.slice(2).length ? process.argv.slice(2) : PROBES;
let hit = 0;
const misses = [];
for (const n of names) {
  const r = resolve(n);
  if (r) {
    hit++;
    const exact = r === slugify(n);
    console.log(`  ✓ ${n.padEnd(28)} -> ${r}${exact ? "" : "   (via variant/alias)"}`);
  } else {
    misses.push(n);
    console.log(`  ✗ ${n.padEnd(28)} -> no image (letter avatar)`);
  }
}
console.log(`\n${hit}/${names.length} resolved (${((hit / names.length) * 100).toFixed(1)}%)`);
if (misses.length) console.log(`Missing: ${misses.join(", ")}`);
