// Resolution for food thumbnails.
//
// Preference order:
//   1. Our own generated illustration pack in /public/foods (no licensing or
//      attribution strings attached, consistent botanical style, zero runtime cost).
//   2. TheMealDB's static CDN — DEV ONLY fallback. Their free tier/test key is for
//      development & educational use and the artwork is user-contributed, so this
//      must be off (or properly licensed) before a commercial launch.
//      See docs/security-and-infra-todo.md.
//   3. A generated letter-avatar (handled by FoodImage).

/** Must match slugify() in scripts/gen-food-images.mjs. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Local illustration-pack URL for a food name (256px WebP with alpha). */
export function packUrl(name: string): string {
  return `/foods/${slugify(name)}.webp`;
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
