// @vitest-environment node
//
// Claim safety and price parity, asserted against the built Marketing_Site.
//
// Validates: Requirements 9.1, 9.2, 9.3
//
// Two guarantees live here, and both are deliberately checked against `dist/`
// rather than against the templates:
//
//   1. No Forbidden_Claim appears anywhere in a shipped Marketing_Page. The
//      phrase-pattern list below is the maintained list Requirement 9.2 asks
//      for, derived entry by entry from the "Claims we must not make" section of
//      `docs/positioning.md`.
//   2. Every price the pricing page displays equals its `shared/plans.js` value,
//      and no plan outside the Plan_Catalog appears.
//
// Why the built documents and not the sources. Copy reaches a page through the
// partial injection of `vite/partials.js`, the plan table of `vite/pricing.js`,
// and the flattening step of `vite/marketing.js`. A claim can therefore be
// introduced by a partial, a Route_Table title or description, or a catalog
// value — none of which a template scan would see. `src/pricing.plugin.test.ts`
// already covers the renderer in isolation (`formatPrice`, `renderPlans`, the
// marker transform, and the template's own freedom from figures); this file
// deliberately asserts none of that, and instead reads only the emitted
// `dist/pricing.html` to confirm what the shipped page actually says.
//
// Source comments do *not* ship: `vite/marketing.js` strips them from the
// flattened documents, so the editing notes in `marketing/` stay in the
// repository instead of being served to every visitor as an annotated map of the
// internals. That guarantee is asserted below, and the extraction still covers
// comment text so a regression in the stripping cannot also silently shrink this
// scan's corpus. Attribute-borne copy — the meta description, the OG and Twitter
// text, `alt` — is scanned because a crawler reads it as copy.
//
// ── The "Cloud sync available" entry, handled explicitly ────────────────────
//
// `docs/positioning.md` lists *"Cloud sync available."* under claims we must not
// make, with the reason "Not built." That was accurate when it was written. It no
// longer is: cross-device sync shipped as SnapGut Cloud (the `cloud-sync` spec),
// `/api/sync/*` is live, and Requirement 9.4 now *mandates* describing it as a
// Pro feature. The forbidden claim was availability-as-a-general-capability at a
// time when the capability did not exist; the capability exists, so that specific
// entry is obsolete and is retired here rather than silently dropped.
//
// What replaces it is the constraint that survived the change: the site must not
// misstate sync's availability in either direction. So this file scans for copy
// that offers sync on the free tier (false — a non-Pro session gets
// `upgrade_required`) and for copy that still calls it forthcoming (false — it
// shipped). Task 12.2 re-audits `docs/positioning.md` itself; this file does not
// edit it.
//
// ── Negation ───────────────────────────────────────────────────────────────
//
// Several forbidden claims are things the pages must *deny*: the footer states
// the product is not a medical device, does not diagnose, and is not an allergy
// test. A pattern for the diagnostic claim therefore matches the disclaimer that
// exists to prevent it. Each entry declares whether a negation cue earlier in the
// same clause clears a match, which is true exactly for the entries whose
// forbidden form is affirmative. Entries whose forbidden form is itself negative
// ("data never leaves your device", "no account needed") set it false, since
// there the negation is part of the claim.
//
// The trade-off: a forbidden claim smuggled into a clause that also carries an
// unrelated earlier negation would be missed. That is a contrived shape, and the
// alternative — no negation handling — makes the check fail on the very
// disclaimers Requirement 9.6 requires, which would get the check deleted.

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MARKETING_PAGES, NOT_FOUND_FILE } from "../shared/site.js";
import { PLANS, type PlanId } from "../shared/plans.js";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { formatPrice } from "../vite/pricing.js";

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

/** Every source a built Marketing_Page's text can come from. */
const CONTENT_SOURCES = [
  "marketing",
  "shared/site.js",
  "shared/plans.js",
  "vite/partials.js",
  "vite/pricing.js",
  "vite/marketing.js",
  "vite.config.ts",
];

/**
 * Build only when a built document is missing or older than the copy it is
 * rendered from, so a clean checkout works and a normal `npm test` after a build
 * pays nothing. Same guard as `src/pwa.offline.test.ts`.
 */
const buildIfStale = () => {
  const documents = [...MARKETING_PAGES.map((page) => page.file), NOT_FOUND_FILE];
  const builtAt = documents.map((file) => {
    const built = path.join(distDir, file);
    return existsSync(built) ? statSync(built).mtimeMs : 0;
  });
  const newestSource = Math.max(
    ...CONTENT_SOURCES.map((entry) => statSync(path.join(repoRoot, entry)).mtimeMs),
  );
  if (Math.min(...builtAt) > newestSource) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
};

// ── Text extraction ────────────────────────────────────────────────────────

const COMMENT = /<!--([\s\S]*?)-->/g;
const TAG = /<[^>]+>/g;
const COPY_ATTRIBUTE = /\b(?:content|alt|aria-label|title)\s*=\s*"([^"]*)"/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&ldquo;": '"',
  "&rdquo;": '"',
  "&mdash;": "—",
  "&ndash;": "–",
  "&nbsp;": " ",
  "&copy;": "(c)",
};

/**
 * A clause boundary. Commas are deliberately *not* boundaries: negation and its
 * object are routinely separated by one ("that is an association, not a
 * diagnosis"). Dashes are, because they separate independent clauses in this
 * site's copy.
 */
const CLAUSE_BOUNDARY = /[.!?;:]+/;

const normalize = (text: string) =>
  Object.entries(ENTITIES)
    .reduce((acc, [entity, char]) => acc.split(entity).join(char), text)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, ";")
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * Everything in a built document a reader or a crawler can end up seeing: the
 * body text, the copy carried in attributes, and the HTML comments that ship
 * with it. Parts are joined with a clause boundary so a negation in one cannot
 * clear a match in another.
 */
const readableText = (html: string): string => {
  const parts: string[] = [];
  for (const [, body] of html.matchAll(COMMENT)) parts.push(body);
  const visible = html.replace(COMMENT, " ");
  for (const [, value] of visible.matchAll(COPY_ATTRIBUTE)) parts.push(value);
  parts.push(visible.replace(TAG, " "));
  return normalize(parts.join(" ; "));
};

const NEGATION =
  /\b(?:not|never|no|none|nothing|nor|neither|cannot|can't|won't|wouldn't|don't|doesn't|didn't|isn't|aren't|without|rather than|instead of|refuses?|refused)\b/;

// ── The maintained Forbidden_Claim list ────────────────────────────────────

interface ForbiddenClaim {
  /** Stable id, used in failure messages. */
  readonly id: string;
  /** The entry in "Claims we must not make" this is derived from. */
  readonly entry: string;
  /** Whether an earlier negation in the same clause clears a match. */
  readonly negationClears: boolean;
  readonly patterns: readonly RegExp[];
  /** Copy that must trip this entry, so a pattern cannot rot into a no-op. */
  readonly caughtSamples: readonly string[];
}

const FORBIDDEN_CLAIMS: readonly ForbiddenClaim[] = [
  {
    id: "data-never-leaves",
    entry: '"Your data never leaves your device." Photos are transmitted for recognition.',
    negationClears: false,
    patterns: [
      /\b(?:data|log|logs|photos?|entries|everything)\s+never\s+leaves?\b/,
      /\bnever\s+leaves?\s+(?:your|the)\s+(?:device|phone|browser)\b/,
      /\bnothing\s+(?:ever\s+)?leaves\s+(?:your|the)\s+(?:device|phone|browser)\b/,
      /\b100\s?%\s+(?:private|local|on[- ]device|offline)\b/,
      /\b(?:stays?|stayed|remains?)\s+(?:entirely|completely|wholly|only|always)\s+on\s+your\s+(?:device|phone)\b/,
      /\b(?:photos?|images?|pictures?)\s+never\s+leave\b/,
      /\bwe\s+(?:never|don't)\s+(?:see|receive)\s+your\s+(?:photos?|meals?)\b/,
    ],
    caughtSamples: [
      "Your data never leaves your device.",
      "Everything stays entirely on your device, always.",
      "100% private — nothing ever leaves your phone.",
    ],
  },
  {
    id: "no-account-needed",
    entry: '"No account needed." Untrue until the deferred sign-in work lands.',
    negationClears: false,
    patterns: [
      /\bno\s+(?:account|sign[- ]?up|signup|sign[- ]?in|email|registration)\s+(?:needed|required|necessary|at all)\b/,
      /\bno\s+account\b(?=[\s,.;:!?]|$)/,
      /\bwithout\s+(?:an?\s+)?(?:account|sign[- ]?up|signing\s+up|signing\s+in)\b/,
      /\bstart\s+logging\s+(?:before|without)\b/,
      /\bskip\s+(?:the\s+)?(?:sign[- ]?up|sign[- ]?in|account)\b/,
    ],
    caughtSamples: [
      "No account needed — just open the app.",
      "Start logging without an account.",
      "Skip the sign-up and get going.",
    ],
  },
  {
    id: "sync-availability-misstated",
    entry:
      '"Cloud sync available." Retired: sync shipped as a Pro feature (see the header note). ' +
      "What is enforced instead is that its availability is not misstated in either direction.",
    negationClears: false,
    patterns: [
      // Offered on the free tier — `/api/sync/*` answers `upgrade_required`.
      /\b(?:cloud\s+sync|snapgut\s+cloud)\s+(?:sync\s+)?(?:is\s+)?(?:free|included|for\s+everyone)\b/,
      /\bfree\s+(?:cross[- ]device\s+)?cloud\s+sync\b/,
      /\b(?:cloud\s+)?sync\s+(?:is\s+)?(?:free|included)\s+(?:on|with)\s+(?:the\s+)?free\b/,
      /\b(?:cloud\s+)?sync\s+on\s+(?:the\s+)?free\s+(?:plan|tier|account)\b/,
      // Still described as forthcoming — it shipped.
      /\b(?:cloud\s+sync|snapgut\s+cloud)\s+(?:sync\s+)?(?:is\s+)?(?:coming\s+soon|not\s+yet|forthcoming|on\s+the\s+roadmap|planned)\b/,
      /\b(?:coming\s+soon|not\s+yet\s+available)\s*[:,-]?\s*(?:cloud\s+sync|snapgut\s+cloud)\b/,
    ],
    caughtSamples: [
      "Free cloud sync on every plan.",
      "Cloud sync is included for everyone.",
      "SnapGut Cloud is coming soon.",
    ],
  },
  {
    id: "diagnostic-or-causal",
    entry: "Anything diagnostic, allergy-test-shaped, or causal. Associations, not causation.",
    negationClears: true,
    patterns: [
      /\bdiagnos(?:e|es|ed|ing|is|tic|tics)\b/,
      /\b(?:allergy|allergies|intolerance|sensitivity)\s+test(?:s|ing)?\b/,
      /\btests?\s+(?:you\s+)?for\s+(?:allergies|intolerances)\b/,
      /\bidentif(?:y|ies)\s+your\s+(?:allergies|intolerances|triggers)\b/,
      /\bmedical\s+device\b/,
      /\b(?:clinically|medically)\s+(?:proven|validated|approved)\b/,
      /\b(?:causes?|caused|causing)\s+(?:your|the|a|one)\s+(?:symptoms?|bloating|pain|flare)\b/,
      /\bthe\s+cause\s+of\s+your\s+(?:symptoms?|bloating|pain)\b/,
      /\bproof\s+that\b/,
      /\bprov(?:es|en)\s+(?:that\s+)?\w+\s+causes?\b/,
      /\btells?\s+you\s+which\s+foods?\s+(?:you\s+are\s+)?(?:allergic|intolerant)\b/,
    ],
    caughtSamples: [
      "SnapGut diagnoses the cause of your symptoms.",
      "A built-in intolerance test for every meal.",
      "It is proof that dairy causes your bloating.",
      "A clinically proven medical device.",
    ],
  },
  {
    id: "accurate-fodmap-data",
    entry: '"Accurate FODMAP data." Our tagging is coarse keyword matching.',
    negationClears: true,
    patterns: [
      /\b(?:accurate|precise|exact|reliable|lab[- ]tested|portion[- ]aware|certified|validated)\s+fodmap\b/,
      /\bfodmap\s+(?:data|values|content|levels?)\s+(?:is|are)\s+(?:accurate|precise|exact|reliable)\b/,
      /\bmonash[- ](?:grade|quality|level|accurate)\b/,
      /\bfodmap\s+(?:certified|lab[- ]tested)\b/,
    ],
    caughtSamples: [
      "Accurate FODMAP data for every ingredient.",
      "Our FODMAP values are precise.",
    ],
  },
  {
    id: "identical-to-native",
    entry: '"Identical to a native app." iOS web apps get tighter limits.',
    negationClears: true,
    patterns: [
      /\b(?:identical|indistinguishable)\s+(?:to|from)\s+(?:a\s+)?native\b/,
      /\b(?:exactly|just)\s+like\s+(?:a\s+)?native\s+app\b/,
      /\bas\s+(?:good|capable|fast)\s+as\s+(?:a\s+)?native\s+app\b/,
      /\bthe\s+same\s+as\s+(?:a\s+)?native\s+app\b/,
      /\bno\s+different\s+(?:to|from)\s+(?:a\s+)?native\s+app\b/,
    ],
    caughtSamples: [
      "It is identical to a native app.",
      "Runs just like a native app on iOS.",
    ],
  },
  {
    id: "we-will-remind-you",
    entry: '"We\'ll remind you to log." No notifications are implemented.',
    negationClears: true,
    patterns: [
      /\b(?:we|snapgut|the\s+app)\s*(?:'ll|will|can)?\s*remind\s+you\b/,
      /\bremind(?:s|ers?)?\s+you\s+to\s+log\b/,
      /\b(?:daily\s+)?reminder\s+notifications?\b/,
      /\b(?:push\s+)?notifications?\s+(?:keep|nudge|prompt)\s+you\b/,
      /\bwe(?:'ll)?\s+(?:nudge|ping|prompt)\s+you\b/,
    ],
    caughtSamples: [
      "We'll remind you to log your dinner.",
      "Daily reminder notifications keep the habit going.",
    ],
  },
  {
    id: "data-cannot-be-lost",
    entry: '"Your data can\'t be lost." Browser storage can be evicted.',
    negationClears: false,
    patterns: [
      /\b(?:data|log|logs|entries)\s+(?:can't|cannot|can\s+not|could\s+not|couldn't|won't|will\s+never|are\s+never)\s+be\s+lost\b/,
      /\bnever\s+lose\s+(?:your|any)\s+(?:data|log|entries|meals?)\b/,
      /\byour\s+data\s+is\s+safe\s+(?:forever|for\s+good|permanently)\b/,
      /\b(?:permanent|guaranteed|indestructible)\s+(?:storage|backup)\b/,
      /\bstored\s+(?:forever|permanently)\b/,
      /\bnothing\s+(?:is\s+)?ever\s+lost\b/,
    ],
    caughtSamples: [
      "Your data can't be lost.",
      "Guaranteed storage — you'll never lose any entries.",
    ],
  },
];

/** A match that the entry's negation rule did not clear. */
interface ClaimHit {
  readonly document: string;
  readonly claim: string;
  readonly pattern: string;
  readonly clause: string;
}

/**
 * Scan one document's readable text against the whole list. Matching is per
 * clause, so a negation cue is only credited when it precedes the match inside
 * the same clause.
 */
const scanForClaims = (documentName: string, text: string): ClaimHit[] => {
  const hits: ClaimHit[] = [];
  for (const clause of text.split(CLAUSE_BOUNDARY)) {
    for (const claim of FORBIDDEN_CLAIMS) {
      for (const pattern of claim.patterns) {
        const match = pattern.exec(clause);
        if (!match) continue;
        if (claim.negationClears && NEGATION.test(clause.slice(0, match.index))) continue;
        hits.push({
          document: documentName,
          claim: claim.id,
          pattern: String(pattern),
          clause: clause.trim(),
        });
      }
    }
  }
  return hits;
};

// ── Price parity helpers ───────────────────────────────────────────────────

/** One plan card as `vite/pricing.js` emits it, keyed by its catalog id. */
const PLAN_CARD = /<li\b[^>]*data-plan="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g;

/** Any currency figure, wherever it appears in a document. */
const CURRENCY_FIGURE = /\$\d[\d,]*(?:\.\d{1,2})?/g;

const planIds = Object.keys(PLANS) as PlanId[];

/** Figures the Plan_Catalog authorises: each price, plus any inside `per`. */
const catalogFigures = new Set<string>([
  ...planIds.map((id) => formatPrice(PLANS[id].price) as string),
  ...planIds.flatMap((id) => PLANS[id].per.match(CURRENCY_FIGURE) ?? []),
]);

const marketingDocuments = [...MARKETING_PAGES.map((page) => page.file), NOT_FOUND_FILE];

const built = new Map<string, string>();
const readable = new Map<string, string>();

beforeAll(() => {
  buildIfStale();
  for (const file of marketingDocuments) {
    const html = readFileSync(path.join(distDir, file), "utf8");
    built.set(file, html);
    readable.set(file, readableText(html));
  }
}, 120_000);

describe("the built Marketing_Site contains no Forbidden_Claim (R9.1, R9.2)", () => {
  it.each(marketingDocuments)("%s", (file) => {
    expect(scanForClaims(file, readable.get(file)!)).toEqual([]);
  });

  it.each(marketingDocuments)("%s ships no source comment", (file) => {
    // The sources are heavily commented — which requirement a section serves,
    // which wording is approved, which internals a sentence was checked against.
    // None of that belongs in a public response body.
    expect(built.get(file)).not.toContain("<!--");
  });

  it("scans the copy carried in attributes", () => {
    const home = MARKETING_PAGES.find((page) => page.path === "/")!;
    expect(readable.get("index.html")).toContain(home.description.toLowerCase());
  });
});

describe("the phrase patterns still catch what they are for (R9.2)", () => {
  for (const claim of FORBIDDEN_CLAIMS) {
    it(`${claim.id} matches its sample copy`, () => {
      for (const sample of claim.caughtSamples) {
        const hits = scanForClaims("sample", normalize(sample));
        expect(
          hits.map((hit) => hit.claim),
          `"${sample}" should trip ${claim.id}`,
        ).toContain(claim.id);
      }
    });
  }

  it("lets the disclaimers Requirement 9.6 asks for through", () => {
    const approved = [
      "SnapGut is not a medical device, it does not diagnose anything, and it is not an allergy or intolerance test.",
      "That is an association, not a diagnosis, and it is not an allergy or intolerance test.",
      "A pattern in your log is a place to look — not proof that one food caused one symptom.",
      "The analysis is associative rather than diagnostic.",
      "Your log stays on your device. Photos are sent only to identify a meal, and we do not keep them.",
      "Cross-device sync with SnapGut Cloud is a Pro feature.",
      "No profile, no quiz — just an email.",
      "No download, no app store account, no hundred-megabyte install.",
    ];
    for (const sentence of approved) {
      expect(scanForClaims("approved", normalize(sentence)), sentence).toEqual([]);
    }
  });
});

describe("the built pricing page's prices equal the Plan_Catalog's (R9.3)", () => {
  const cards = () => {
    const html = built.get("pricing.html")!;
    PLAN_CARD.lastIndex = 0;
    return new Map([...html.matchAll(PLAN_CARD)].map(([, id, body]) => [id, body]));
  };

  it.each(planIds)("%s displays its catalog price, label, and caption", (id) => {
    const body = cards().get(id);
    expect(body, `no card for plan "${id}" in the built pricing page`).toBeTruthy();
    const plan = PLANS[id];
    expect(body).toContain(formatPrice(plan.price));
    expect(body).toContain(plan.label);
    expect(body).toContain(plan.caption);
    expect(body).toContain(plan.per);
  });

  it("displays no plan absent from the Plan_Catalog", () => {
    expect([...cards().keys()].sort()).toEqual([...planIds].sort());
  });

  it("holds exactly one card in the plan table, per catalog entry", () => {
    const table = built
      .get("pricing.html")!
      .split("</ul>")
      .find((chunk) => chunk.includes("data-plan="))!;
    expect(table.match(/<li\b/g) ?? []).toHaveLength(planIds.length);
  });

  it("shows no currency figure the Plan_Catalog does not authorise", () => {
    const figures = built.get("pricing.html")!.match(CURRENCY_FIGURE) ?? [];
    expect(figures.length).toBeGreaterThan(0);
    expect([...new Set(figures)].filter((figure) => !catalogFigures.has(figure))).toEqual([]);
  });

  it("shows every catalog price somewhere on the page", () => {
    const html = built.get("pricing.html")!;
    for (const id of planIds) expect(html).toContain(formatPrice(PLANS[id].price));
  });
});

describe("no other Marketing_Page names a price (R9.3)", () => {
  // A figure anywhere else is by definition hand-written: only the pricing page
  // renders from the Plan_Catalog, so a second copy can only drift.
  it.each(marketingDocuments.filter((file) => file !== "pricing.html"))("%s", (file) => {
    expect(built.get(file)!.match(CURRENCY_FIGURE) ?? []).toEqual([]);
  });
});
