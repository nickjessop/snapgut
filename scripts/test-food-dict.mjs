// Sanity-check canonicalisation + tagging against the built dictionary.
//   node scripts/test-food-dict.mjs
import { canonicalize, annotateIngredients } from "../server/foodDict.js";

const CASES = [
  // [input, expected canonical (null = expected miss)]
  ["Tomato", "tomato"],
  ["Tomatoes", "tomato"],
  ["Roma tomatoes", "tomato"],
  ["Cherry tomatoes", "tomato"],
  ["Aubergine", "eggplant"],
  ["Courgette", "zucchini"],
  ["Cilantro", "cilantro"],
  ["Coriander leaves", "cilantro"],
  ["Garbanzo beans", "chickpeas"],
  ["Prawns", "shrimp"],
  ["MSG", "msg"],
  ["Monosodium glutamate", "msg"],
  ["Chives", "chive"],
  ["Cloves", "clove"],
  ["Rolled oats", "oats"],
  ["Whole wheat bread", "wheat-bread"],
  // Cuts keep their own entry (own illustration, own tags) — not merged into "chicken".
  ["Chicken breast", "chicken-breast"],
  ["Almond milk", "almond-milk"],
];

// Tag correctness — these were WRONG under the old substring heuristic.
const TAG_CASES = [
  ["Almond milk", "lactose", false],
  ["Pineapple", "fructose", false],
  ["Butternut squash", "high_fat", false],
  ["Milk", "lactose", true],
  ["Apple", "fructose", true],
  ["Coffee", "caffeine", true],
  ["Onion", "fructans", true],
];

let pass = 0;
let fail = 0;

console.log("=== canonicalisation ===");
for (const [input, expected] of CASES) {
  const hit = await canonicalize(input);
  const got = hit?.canonical ?? null;
  const ok = got === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${input.padEnd(22)} -> ${got ?? "(miss)"}${ok ? "" : `   expected ${expected}`}`);
}

console.log("\n=== tags (old heuristic got these wrong) ===");
for (const [input, tag, shouldHave] of TAG_CASES) {
  const hit = await canonicalize(input);
  const has = !!hit?.tags?.includes(tag);
  const ok = has === shouldHave;
  ok ? pass++ : fail++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${input.padEnd(22)} ${shouldHave ? "has" : "no "} ${tag.padEnd(9)} tags=${JSON.stringify(hit?.tags ?? [])}`
  );
}

console.log("\n=== annotateIngredients (what /api/recognize returns) ===");
const annotated = await annotateIngredients([
  { name: "Wheat noodles", confidence: "confident" },
  { name: "Almond milk", confidence: "confident" },
  { name: "Definitely Not A Real Food", confidence: "maybe" },
]);
console.log(JSON.stringify(annotated, null, 2));
const passthrough = annotated[2].canonical === undefined;
passthrough ? pass++ : fail++;
console.log(passthrough ? "  ✓ unknown food passes through untouched" : "  ✗ unknown food was mangled");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
