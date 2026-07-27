import { useState } from "react";
import { isMissing, markMissing } from "./imageCache";

// Deterministic pastel background for the fallback letter-avatar.
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 32%)`;
}

/**
 * Ingredient thumbnail from TheMealDB's free static image CDN, with a generated
 * letter-avatar fallback when the image isn't found (no broken-image icons).
 * See docs/research-and-insights.md for the DB research.
 */
export default function FoodImage({ name }: { name: string }) {
  const slug = name.trim().replace(/\s+/g, "_");
  // Skip the network entirely for images we've already learned are missing.
  const [failed, setFailed] = useState(() => isMissing(slug));
  const url = `https://www.themealdb.com/images/ingredients/${encodeURIComponent(slug)}-small.png`;

  if (failed) {
    return (
      <div className="food-avatar" style={{ background: colorFor(name) }}>
        {name.trim().charAt(0).toUpperCase() || "?"}
      </div>
    );
  }

  return (
    <img
      className="food-img"
      src={url}
      alt=""
      loading="lazy"
      onError={() => {
        markMissing(slug);
        setFailed(true);
      }}
    />
  );
}
