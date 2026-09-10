// Coarse, keyword-based FODMAP / trigger tagging for free-text food names.
//
// Deliberately a heuristic, and the code says so where it matters: the food
// dictionary is consulted first and this keyword pass is the fallback, so a
// tag here is a guess about a name rather than a measurement of a portion.
// docs/fodmap-program.md explains what the grouping is for and what it cannot
// support; the obvious upgrade path is AI-returned tags with portion awareness.

export type TriggerGroup =
  | "fructans"
  | "gos"
  | "lactose"
  | "fructose"
  | "polyols"
  | "caffeine"
  | "alcohol"
  | "high_fat"
  | "spicy"
  | "carbonation"
  | "histamine";

export const TRIGGER_LABELS: Record<TriggerGroup, string> = {
  fructans: "Fructans",
  gos: "GOS",
  lactose: "Lactose",
  fructose: "Excess fructose",
  polyols: "Polyols",
  caffeine: "Caffeine",
  alcohol: "Alcohol",
  high_fat: "High fat",
  spicy: "Spicy",
  carbonation: "Carbonation",
  histamine: "High histamine",
};

// Whether a group is a FODMAP subgroup (vs a general trigger).
export const IS_FODMAP: Record<TriggerGroup, boolean> = {
  fructans: true,
  gos: true,
  lactose: true,
  fructose: true,
  polyols: true,
  caffeine: false,
  alcohol: false,
  high_fat: false,
  spicy: false,
  carbonation: false,
  histamine: false,
};

// keyword → groups. Matched as case-insensitive substrings against food names.
const KEYWORDS: { match: string[]; groups: TriggerGroup[] }[] = [
  { match: ["wheat", "bread", "pasta", "rye", "cereal", "cracker", "bagel", "noodle"], groups: ["fructans"] },
  { match: ["onion", "garlic", "leek", "shallot", "asparagus"], groups: ["fructans"] },
  { match: ["bean", "lentil", "chickpea", "hummus", "soy", "edamame"], groups: ["gos"] },
  { match: ["cashew", "pistachio"], groups: ["gos"] },
  { match: ["milk", "yogurt", "yoghurt", "ice cream", "custard", "latte", "cream cheese", "cottage"], groups: ["lactose"] },
  { match: ["cheese"], groups: ["lactose", "histamine"] },
  { match: ["apple", "pear", "mango", "watermelon", "honey", "corn syrup", "cherry"], groups: ["fructose"] },
  { match: ["apricot", "peach", "plum", "nectarine", "avocado", "mushroom", "cauliflower", "blackberry"], groups: ["polyols"] },
  { match: ["sorbitol", "mannitol", "xylitol", "sugar-free", "sugar free", "chewing gum"], groups: ["polyols"] },
  { match: ["coffee", "espresso", "black tea", "green tea", "energy drink", "cola"], groups: ["caffeine"] },
  { match: ["beer", "wine", "cocktail", "liquor", "whiskey", "vodka", "spirit"], groups: ["alcohol", "histamine"] },
  { match: ["fried", "fries", "burger", "pizza", "bacon", "chips", "butter", "creamy"], groups: ["high_fat"] },
  { match: ["chili", "chilli", "curry", "hot sauce", "jalapeno", "spicy", "sriracha"], groups: ["spicy"] },
  { match: ["soda", "sparkling", "seltzer", "carbonated", "cola", "champagne"], groups: ["carbonation"] },
  { match: ["fermented", "sauerkraut", "kimchi", "salami", "cured", "aged", "smoked", "anchovy", "vinegar", "kombucha"], groups: ["histamine"] },
];

const ALL_GROUPS = new Set<string>(Object.keys(TRIGGER_LABELS));

/**
 * Preferred path: trigger groups resolved server-side from the food dictionary at
 * recognition time and stored on the ingredient. Falls back to the keyword heuristic
 * below for foods outside the dictionary and for events logged before it existed.
 *
 * The heuristic is substring-based and therefore wrong in places ("almond milk"
 * matches "milk" -> lactose; "pineapple" matches "apple" -> fructose), which is
 * exactly why the dictionary takes precedence.
 */
export function tagsForIngredient(ing: { name: string; tags?: string[] }): TriggerGroup[] {
  if (ing.tags?.length) {
    return ing.tags.filter((t): t is TriggerGroup => ALL_GROUPS.has(t));
  }
  return tagFood(ing.name);
}

/** Keyword fallback: trigger groups a food name likely belongs to. */
export function tagFood(name: string): TriggerGroup[] {
  const n = name.toLowerCase();
  const groups = new Set<TriggerGroup>();
  for (const { match, groups: g } of KEYWORDS) {
    if (match.some((m) => n.includes(m))) g.forEach((x) => groups.add(x));
  }
  return [...groups];
}

/** Tag a list of foods and return unique groups across all of them. */
export function tagFoods(names: string[]): TriggerGroup[] {
  const groups = new Set<TriggerGroup>();
  names.forEach((name) => tagFood(name).forEach((g) => groups.add(g)));
  return [...groups];
}
