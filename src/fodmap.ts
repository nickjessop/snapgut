// Coarse, keyword-based FODMAP / trigger tagging for free-text food names.
// This is an MVP heuristic; see docs/research-and-insights.md for the upgrade
// path (AI-returned FODMAP tags + portion-aware red/amber/green).

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

/** Return the set of trigger groups a food name likely belongs to. */
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
