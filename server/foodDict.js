// Canonical food dictionary — the single join key for food data.
//
// Built offline by scripts/gen-food-dict.mjs into food-dict.json:
//   foods:    slug -> { display, tags[], img? }
//   synonyms: slug -> canonical slug
//
// Recognition canonicalises each ingredient once (server-side), and everything
// downstream joins on the canonical id: the illustration pack, food scoring/
// aggregation, and FODMAP/trigger tags. That replaces the old approach of guessing
// slugs per-render and substring-matching keywords for tags (which produced real
// errors like "almond milk" -> lactose and "pineapple" -> fructose).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DICT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "food-dict.json");

let dict = null;

/** Load (and memoise) the dictionary. Missing file is non-fatal: we degrade to null. */
async function load() {
  if (dict !== null) return dict;
  try {
    dict = JSON.parse(await readFile(DICT_PATH, "utf8"));
    console.log(
      `food dict v${dict.version}: ${Object.keys(dict.foods).length} foods, ` +
        `${Object.keys(dict.synonyms).length} synonyms`
    );
  } catch (err) {
    console.warn(`food dict unavailable (${err.code || err.message}) — skipping canonicalisation`);
    dict = false;
  }
  return dict;
}

export function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Plausible singular forms. English plurals don't reduce reliably ("leaves" -> leaf
 * but "chives" -> chive), so return every candidate and let the lookup decide.
 */
function singularVariants(slug) {
  if (!/s$/.test(slug)) return [];
  const out = [];
  if (/ies$/.test(slug)) out.push(slug.replace(/ies$/, "y"));
  if (/oes$/.test(slug)) out.push(slug.replace(/oes$/, "o"));
  if (/ves$/.test(slug)) {
    out.push(slug.replace(/ves$/, "f"));
    out.push(slug.replace(/ves$/, "fe"));
  }
  if (/(ches|shes|sses|xes|zes)$/.test(slug)) out.push(slug.replace(/es$/, ""));
  out.push(slug.replace(/s$/, ""));
  if (/es$/.test(slug)) out.push(slug.replace(/es$/, ""));
  return out;
}

/** Ordered slug candidates for a free-text food name. */
function candidates(name) {
  const base = slugify(name);
  const out = [];
  const push = (s) => {
    if (s && s.length > 1 && !out.includes(s)) out.push(s);
  };
  push(base);
  for (const s of singularVariants(base)) push(s);
  if (!/s$/.test(base)) push(`${base}s`);

  const parts = base.split("-");
  // Drop leading qualifiers: "roma tomato" -> "tomato", "fresh basil" -> "basil".
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join("-");
    push(tail);
    for (const s of singularVariants(tail)) push(s);
  }
  // Drop trailing qualifiers: "coriander leaves" -> "coriander",
  // "tomato slices" -> "tomato". Longest prefix first.
  for (let i = parts.length - 1; i >= 1; i--) {
    const head = parts.slice(0, i).join("-");
    push(head);
    for (const s of singularVariants(head)) push(s);
  }
  return out;
}

/**
 * Resolve a free-text food name to its canonical entry.
 * Returns { canonical, display, tags, img } or null when unknown.
 */
export async function canonicalize(name) {
  const d = await load();
  if (!d) return null;

  for (const slug of candidates(name)) {
    const direct = d.foods[slug];
    if (direct) {
      return { canonical: slug, display: direct.display, tags: direct.tags || [], img: !!direct.img };
    }
    const via = d.synonyms[slug];
    if (via && d.foods[via]) {
      const e = d.foods[via];
      return { canonical: via, display: e.display, tags: e.tags || [], img: !!e.img };
    }
  }
  return null;
}

/**
 * Annotate recognised ingredients with their canonical id and trigger tags. Unknown
 * foods pass through untouched (the client still renders the raw name, and the /foods
 * 404 telemetry tells us what to add to the next batch).
 */
export async function annotateIngredients(ingredients) {
  if (!Array.isArray(ingredients)) return [];
  return Promise.all(
    ingredients.map(async (ing) => {
      const hit = await canonicalize(ing?.name);
      if (!hit) return ing;
      return {
        ...ing,
        canonical: hit.canonical,
        ...(hit.tags.length ? { tags: hit.tags } : {}),
      };
    })
  );
}
