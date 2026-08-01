/**
 * Plain-language reference for the trigger groups the app names.
 *
 * The Patterns view labels an association by its trigger group — "Fructans",
 * "Polyols", "High histamine" — which are terms most people meet for the first time
 * in an app like this one. Showing a word nobody can define is worse than showing
 * nothing: it reads as authority without content.
 *
 * Editorial rules these entries follow, and must keep following:
 *
 *  - **Associative, never causal or diagnostic.** "Often reported alongside", not
 *    "causes". Nothing here may read as a diagnosis, an intolerance test, or a
 *    treatment recommendation — the same line `docs/positioning.md` draws for the
 *    marketing copy, for the same regulatory reason.
 *  - **Honest about our own precision.** Group membership comes from the food
 *    dictionary where it exists and a coarse keyword match otherwise, so every entry
 *    says the tagging is approximate rather than implying lab-grade data. We do not
 *    have Monash's portion-aware measurements and must not sound like we do.
 *  - **No elimination advice.** Cutting food groups out is a clinician's call, and
 *    `docs/positioning.md` forbids us implying otherwise.
 *
 * Static content, so it costs no request and works offline.
 */

import { IS_FODMAP, TRIGGER_LABELS, type TriggerGroup } from "./fodmap";

export interface TriggerInfo {
  /** One line, the answer to "what is this". */
  summary: string;
  /** Where it commonly turns up, in ordinary food terms. */
  found: string;
  /** Why it may show up beside symptoms, stated mechanistically, not causally. */
  why: string;
}

export const TRIGGER_INFO: Record<TriggerGroup, TriggerInfo> = {
  fructans: {
    summary:
      "A chain-shaped carbohydrate that the small intestine cannot break down, so it travels on to the large intestine largely intact.",
    found: "Wheat, rye and barley, and onion, garlic, leek and asparagus.",
    why: "Gut bacteria ferment it, which produces gas. That is a normal process — it is simply more noticeable for some people than others, and bloating and wind are the sensations most often reported alongside it.",
  },
  gos: {
    summary:
      "Galacto-oligosaccharides — another chain-shaped carbohydrate humans lack the enzyme to digest.",
    found: "Legumes: beans, lentils and chickpeas, plus soy foods, cashews and pistachios.",
    why: "Like fructans it is fermented rather than absorbed, so gas and bloating are the sensations most commonly reported near it. This is the reason beans have the reputation they do.",
  },
  lactose: {
    summary:
      "The sugar in milk. Digesting it needs the enzyme lactase, and how much of it people keep into adulthood varies a great deal.",
    found: "Milk, yoghurt, ice cream, custard and soft cheeses. Hard and aged cheeses hold much less.",
    why: "Undigested lactose draws water into the bowel and is fermented, so loose stools, cramping and wind are commonly reported alongside it.",
  },
  fructose: {
    summary:
      "Fruit sugar, in amounts beyond what the small intestine absorbs comfortably. The threshold differs from person to person.",
    found: "Apple, pear, mango, watermelon, cherries, honey and high-fructose corn syrup.",
    why: "Whatever is not absorbed continues into the large intestine, where it draws in water and is fermented. Bloating and looser stools are the usual reports.",
  },
  polyols: {
    summary:
      "Sugar alcohols — sweet, only partly absorbed, and present naturally as well as added.",
    found:
      "Stone fruit such as apricot, peach and plum, plus avocado, mushroom and cauliflower; and as sorbitol, mannitol or xylitol in sugar-free gum and sweets.",
    why: "They pull water into the bowel and ferment, which is why sugar-free products sometimes carry a laxative warning on the packet.",
  },
  caffeine: {
    summary: "A stimulant that also speeds up movement through the colon.",
    found: "Coffee, espresso, black and green tea, cola and energy drinks.",
    why: "It increases gut motility and stomach acid, so urgency, looser stools and reflux are the sensations most often reported near it. It also affects sleep, and short sleep has its own association with gut symptoms.",
  },
  alcohol: {
    summary: "A gut irritant that also affects how quickly the stomach empties.",
    found: "Beer, wine, spirits and cocktails.",
    why: "It can irritate the gut lining and loosen stools, and several drinks — particularly wine and beer — are also high in histamine, so two possible associations often overlap in the same glass.",
  },
  high_fat: {
    summary: "Large amounts of fat in one sitting, rather than fat as such.",
    found: "Fried food, chips, burgers, pizza, bacon, butter and creamy sauces.",
    why: "Fat slows stomach emptying and prompts a stronger bile and gut-contraction response, so fullness, nausea, reflux and cramping are commonly reported after a heavy meal. Portion size tends to matter more here than the specific food.",
  },
  spicy: {
    summary: "Capsaicin and related compounds, which act on heat and pain receptors in the gut.",
    found: "Chilli, hot sauce, jalapeño, sriracha and many curries.",
    why: "Those receptors line the digestive tract as well as the mouth, so burning, cramping and urgency are commonly reported. Sensitivity varies widely and often changes with regular exposure.",
  },
  carbonation: {
    summary:
      "Dissolved carbon dioxide, swallowed along with the drink and released as gas once it reaches the stomach.",
    found: "Fizzy drinks, sparkling water, seltzer, cola, beer and champagne.",
    why: "The gas has to leave somewhere, so belching, pressure and a bloated feeling are commonly reported. It is the simplest of these groups to test, because a flat version of the same drink is a fair comparison.",
  },
  histamine: {
    summary:
      "A compound that accumulates in food as it ages, ferments or is cured. Everyone handles some; how much varies from person to person.",
    found:
      "Aged cheese, cured and smoked meats, fermented foods such as sauerkraut and kimchi, vinegar, anchovies, kombucha, wine and beer.",
    why: "Histamine is involved in the body's inflammatory signalling, so reports beside it often include symptoms outside the gut — flushing, headache, skin changes or a racing heart — as well as digestive ones. The evidence here is less settled than for the FODMAP groups above, so it is better read as a lead worth watching than as a finding.",
  },
};

/** Reverse index from the displayed label back to its group. */
const BY_LABEL: Record<string, TriggerGroup> = Object.fromEntries(
  (Object.keys(TRIGGER_INFO) as TriggerGroup[]).map((g) => [TRIGGER_LABELS[g], g])
);

/**
 * The group a displayed label belongs to, or `null`.
 *
 * `EvidenceSummary.associations` carries the human label rather than the group id,
 * and that shape is sent to `/api/insights` — so this maps back instead, rather than
 * changing a payload for the sake of the UI.
 */
export function groupForLabel(label: string): TriggerGroup | null {
  return BY_LABEL[label] ?? null;
}

/** Reference entry for a displayed label, or `null` where there is none. */
export function infoForLabel(
  label: string
): (TriggerInfo & { label: string; isFodmap: boolean }) | null {
  const group = groupForLabel(label);
  if (!group) return null;
  return { ...TRIGGER_INFO[group], label: TRIGGER_LABELS[group], isFodmap: IS_FODMAP[group] };
}
