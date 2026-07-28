import { useState } from "react";
import { isMissing, markMissing } from "./imageCache";
import { packUrl, mealDbUrl, slugify, MEALDB_FALLBACK } from "./foodImages";

// Deterministic background for the fallback letter-avatar.
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 32%)`;
}

/**
 * Ingredient thumbnail. Tries our own illustration pack first, then (in dev only)
 * TheMealDB, then falls back to a generated letter-avatar so we never render a
 * broken-image icon. See src/foodImages.ts for why the order matters.
 */
export default function FoodImage({ name }: { name: string }) {
  const slug = slugify(name);
  const sources = [packUrl(name), ...(MEALDB_FALLBACK ? [mealDbUrl(name)] : [])];

  // Skip straight to the avatar for foods we've already learned have no image.
  const [idx, setIdx] = useState(() => (isMissing(slug) ? sources.length : 0));

  if (idx >= sources.length) {
    return (
      <div className="food-avatar" style={{ background: colorFor(name) }}>
        {name.trim().charAt(0).toUpperCase() || "?"}
      </div>
    );
  }

  return (
    <img
      className="food-img"
      src={sources[idx]}
      alt=""
      loading="lazy"
      onError={() => {
        const next = idx + 1;
        if (next >= sources.length) markMissing(slug); // exhausted every source
        setIdx(next);
      }}
    />
  );
}
