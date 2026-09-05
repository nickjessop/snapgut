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

// Memoise the PROMISE, not the value: a meal canonicalises its ingredients in
// parallel, so caching only the resolved value would let every concurrent caller
// race past the check and re-read the file.
let dictPromise = null;

/** Load (and memoise) the dictionary. A missing file is non-fatal: we degrade to null. */
function load() {
  if (!dictPromise) {
    dictPromise = readFile(DICT_PATH, "utf8")
      .then((raw) => {
        const d = JSON.parse(raw);
        console.log(
          `food dict v${d.version}: ${Object.keys(d.foods).length} foods, ` +
            `${Object.keys(d.synonyms).length} synonyms`
        );
        return d;
      })
      .catch((err) => {
        console.warn(
          `food dict unavailable (${err.code || err.message}) — skipping canonicalisation`
        );
        return null;
      });
  }
  return dictPromise;
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
 * Look up an exact canonical slug (no variant guessing).
 * Returns { canonical, display, tags, img } or null if it isn't a canonical food.
 */
export async function lookupSlug(slug) {
  const d = await load();
  if (!d) return null;
  const e = d.foods[slug];
  if (!e) return null;
  return { canonical: slug, display: e.display, tags: e.tags || [], img: !!e.img };
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
 * foods pass through untouched (the client still renders the raw name).
 *
 * `onGap(slug, reason)` reports coverage problems as we resolve, which is a far
 * cleaner signal than watching image 404s:
 *   - "no_image": a known food we simply haven't illustrated yet → generate it.
 *   - "unknown":  not in the dictionary at all → add it to the food list first.
 * One report per food occurrence, using the canonical id where we have one.
 */
export async function annotateIngredients(ingredients, onGap) {
  if (!Array.isArray(ingredients)) return [];
  return Promise.all(
    ingredients.map(async (ing) => {
      const hit = await canonicalize(ing?.name);
      if (!hit) {
        const slug = slugify(ing?.name);
        if (slug) onGap?.(slug, "unknown");
        return ing;
      }
      if (!hit.img) onGap?.(hit.canonical, "no_image");
      return {
        ...ing,
        canonical: hit.canonical,
        ...(hit.tags.length ? { tags: hit.tags } : {}),
      };
    })
  );
}
