// Resolution for food thumbnails.
//
// Preference order:
//   1. Our own generated illustration pack (~3,000 foods), served same-origin from
//      /foods/* out of a private GCS bucket. No licensing or attribution strings,
//      consistent botanical style, no runtime AI cost.
//   2. TheMealDB's static CDN — DEV ONLY fallback. Their free tier/test key is for
//      development & educational use and the artwork is user-contributed, so this
//      must stay off (or be properly licensed) for a commercial launch.
//      See docs/security-and-infra-todo.md.
//   3. A generated letter-avatar (handled by FoodImage).
//
// The model doesn't always name a food exactly the way the pack does ("Carrots" vs
// "Carrot", "Cilantro" vs "Coriander"), so we try a few slug variants before giving
// up — much cheaper than generating an image per synonym.

/** Must match slugify() in scripts/gen-food-images.mjs. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Genuine synonyms → the slug we actually generated. Regional names, abbreviations,
 * and common recognition outputs. Keys must already be slugified.
 */
const ALIASES: Record<string, string> = {
  // abbreviations / chemical names
  "monosodium-glutamate": "msg",
  "psyllium": "psyllium-husk",
  "soy-lecithin": "lecithin",
  "bicarbonate-of-soda": "baking-soda",
  "sodium-bicarbonate": "baking-soda",
  "corn-flour": "cornstarch",
  "corn-starch": "cornstarch",
  // regional naming
  aubergine: "eggplant",
  courgette: "zucchini",
  capsicum: "bell-pepper",
  rocket: "arugula",
  coriander: "cilantro",
  "coriander-leaves": "cilantro",
  "fresh-coriander": "cilantro",
  "spring-onions": "spring-onion",
  "scallion": "spring-onion",
  "scallions": "spring-onion",
  "green-onions": "green-onion",
  "garbanzo-beans": "chickpeas",
  "garbanzo": "chickpeas",
  "chick-peas": "chickpeas",
  "fava-beans": "broad-beans",
  "snap-peas": "snow-peas",
  "mangetout": "snow-peas",
  swede: "turnip",
  rutabaga: "turnip",
  "sweet-potatoes": "sweet-potato",
  yam: "sweet-potato",
  "spring-greens": "collard-greens",
  "chinese-cabbage": "napa-cabbage",
  "pak-choi": "bok-choy",
  "chilli": "chili",
  "chilli-flakes": "chili-flakes",
  "red-pepper-flakes": "chili-flakes",
  "prawns": "shrimp",
  prawn: "shrimp",
  "minced-beef": "ground-beef",
  "beef-mince": "ground-beef",
  "minced-pork": "ground-pork",
  "ground-meat": "ground-beef",
  "chicken-breast": "chicken",
  "chicken-breasts": "chicken",
  "whole-milk": "milk",
  "cows-milk": "milk",
  "double-cream": "cream",
  "heavy-cream": "cream",
  "single-cream": "cream",
  "curd-cheese": "cottage-cheese",
  "natural-yogurt": "yogurt",
  "plain-yogurt": "yogurt",
  yoghurt: "yogurt",
  "greek-yoghurt": "greek-yogurt",
  aubergines: "eggplant",
  "granulated-sugar": "sugar",
  "white-sugar": "sugar",
  "caster-sugar": "sugar",
  "table-salt": "salt",
  "sea-salt": "salt",
  "olive-oil-extra-virgin": "olive-oil",
  "extra-virgin-olive-oil": "olive-oil",
  "rapeseed-oil": "vegetable-oil",
  "canola-oil": "vegetable-oil",
  "sunflower-oil": "vegetable-oil",
  "plain-flour": "flour",
  "all-purpose-flour": "flour",
  "wheat-flour": "flour",
  "bread": "wheat-bread",
  "white-bread": "wheat-bread",
  "brown-bread": "wheat-bread",
  "noodles": "wheat-noodles",
  "spaghetti": "pasta",
  "macaroni": "pasta",
  "rice": "white-rice",
  "coffee-beans": "coffee",
  "tea": "black-tea",
};

/**
 * Candidate singular forms, best-effort and deliberately ambiguous: English plurals
 * don't reduce reliably ("leaves" -> leaf, but "chives" -> chive), so we return every
 * plausible form and let the pack lookup decide which one exists.
 */
function singularVariants(slug: string): string[] {
  if (!/s$/.test(slug)) return [];
  const out: string[] = [];
  if (/ies$/.test(slug)) out.push(slug.replace(/ies$/, "y"));
  if (/oes$/.test(slug)) out.push(slug.replace(/oes$/, "o")); // tomatoes, potatoes
  if (/ves$/.test(slug)) {
    out.push(slug.replace(/ves$/, "f")); // leaves -> leaf
    out.push(slug.replace(/ves$/, "fe")); // knives -> knife
  }
  if (/(ches|shes|sses|xes|zes)$/.test(slug)) out.push(slug.replace(/es$/, ""));
  out.push(slug.replace(/s$/, "")); // chives -> chive, cloves -> clove, carrots -> carrot
  if (/es$/.test(slug)) out.push(slug.replace(/es$/, ""));
  return out;
}

/** "carrot" -> "carrots" (some pack entries are plural, e.g. strawberries). */
function pluralize(slug: string): string | null {
  if (/s$/.test(slug)) return null;
  if (/y$/.test(slug)) return slug.replace(/y$/, "ies");
  if (/(ch|sh|ss|x)$/.test(slug)) return `${slug}es`;
  return `${slug}s`;
}

/**
 * Ordered, de-duplicated slug candidates to try for a food.
 *
 * When `canonical` is present (resolved server-side against the food dictionary at
 * recognition time) it's authoritative and goes first — the name-guessing below is
 * only a fallback for foods outside the dictionary and for events logged before it
 * existed.
 */
export function slugCandidates(name: string, canonical?: string): string[] {
  const base = slugify(name);
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    if (s && s.length > 1 && !out.includes(s)) out.push(s);
  };

  push(canonical);
  push(base);
  push(ALIASES[base]);
  for (const s of singularVariants(base)) {
    push(s);
    push(ALIASES[s]);
  }
  push(pluralize(base));
  // Multi-word names often have a usable head noun ("roma tomato" -> "tomato").
  const parts = base.split("-");
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    push(last);
    push(ALIASES[last]);
    for (const s of singularVariants(last)) {
      push(s);
      push(ALIASES[s]);
    }
  }
  return out;
}

/** Local illustration-pack URLs to try, in order (256px WebP with alpha). */
export function packUrls(name: string, canonical?: string): string[] {
  return slugCandidates(name, canonical).map((s) => `/foods/${s}.webp`);
}

/**
 * Whether the (unlicensed for commercial use) TheMealDB fallback is allowed.
 * Off unless VITE_MEALDB_FALLBACK=1, so production never depends on it.
 */
export const MEALDB_FALLBACK = import.meta.env.VITE_MEALDB_FALLBACK === "1";

/** TheMealDB ingredient thumbnail (dev-only fallback). */
export function mealDbUrl(name: string): string {
  const slug = name.trim().replace(/\s+/g, "_");
  return `https://www.themealdb.com/images/ingredients/${encodeURIComponent(slug)}-small.png`;
}
