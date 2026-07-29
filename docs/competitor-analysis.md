# Competitor Analysis — SnapGut

Where SnapGut sits in the gut-health app market, what we genuinely do better, and
where we're exposed. Market data verified **28 July 2026**; store listings and prices
move fast, so re-check before using any of this in marketing.

> Scope note: this compares *product capability and positioning*. It is not a legal,
> trademark, or clinical-claims review.

---

## TL;DR

- **The diary category is crowded but weak.** Most trackers still make you type or
  search every food, and their "insights" are an opaque daily score.
- **Our real edge is two things stacked:** photo-first capture (seconds, not minutes)
  *plus* a correlation engine that is unusually honest — baseline-relative lift,
  exposure gates, confidence levels. Almost nobody else does the statistics properly.
- **Our real weakness is distribution, not features.** We're a PWA with no App Store
  presence in a market where competitors buy their way to the top of search.
- **The flagship gap is the guided FODMAP program.** It's designed but not built, and
  it's the thing that would move us from "nice tracker" to "path to feeling better."
- **A direct competitor already exists with our exact pitch:** [Fennly](https://fennly.app/)
  — photo meals, track feelings, surface likely triggers, explicitly non-diagnostic.

---

## The market has five distinct lanes

1. **Clinical reference** — Monash FODMAP. Owns the authoritative food data and the
   protocol. Dry, reference-first, not a habit product.
2. **Dietitian-led programs** — Belly Balance, Cara Care. Real clinical backing,
   sometimes reimbursed by insurers. Expensive, human-in-the-loop, slow to log.
3. **Gut-brain therapy** — Nerva, Mahana IBS. A different job entirely: they treat
   the gut-brain axis and deliberately *avoid* diet tracking. Mahana is FDA-authorized
   prescription software.
4. **Classic food/symptom diaries** — mySymptoms, Bowelle, Cara Care's tracker. Deep
   symptom taxonomies, manual entry, correlation analysis behind a subscription.
5. **The 2025–26 AI photo-scanner wave** — Gutly, Biome, GutBFF, GutSense, gut app,
   Gutrace, GutMind, HappyGut, Belly AI, Fennly, and many more. Photo a meal, get a
   score. Fast-moving, shallow, mostly subscription-only with no free tier.

We are technically in lane 5, but our data model and analysis belong in lane 4, and
our roadmap points at lane 1/2. That combination is the opportunity.

---

## Feature comparison — direct competitors

Legend: ✅ yes · ⚠️ partial / shallow · ❌ no · 🔜 designed, not built

| | **SnapGut** | Monash FODMAP | mySymptoms | Cara Care | Bowelle | Belly Balance | Gutly | Fennly | AI-scanner wave (Biome, GutBFF, gut app, GutSense…) |
|---|---|---|---|---|---|---|---|---|---|
| **Photo-first capture** | ✅ camera is home | ❌ | ❌ | ❌ | ❌ | ⚠️ scan | ✅ photo or note | ✅ | ✅ |
| **AI ingredient extraction** | ✅ Gemini Flash-Lite | ❌ | ❌ | ❌ | ❌ | ⚠️ | ✅ "GutAI" | ✅ | ✅ |
| **Speed to log a meal** | seconds | slow (search) | slow | medium | fast (manual) | medium | fast | fast | fast |
| **Symptom severity** | ✅ 3-point | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ mostly |
| **Bristol stool scale** | ✅ | ✅ bowel habits | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ some |
| **Stress / sleep (gut-brain)** | ✅ check-ins | ✅ stress | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ |
| **Timestamped, meal-independent events** | ✅ | ⚠️ diary-day | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ mostly day-based |
| **Lag-window correlation (30 min–48 h)** | ✅ configurable | ❌ | ✅ | ⚠️ best/worst days | ❌ visual only | ⚠️ | ⚠️ opaque | ⚠️ | ❌ |
| **Statistically gated trigger ranking** | ✅ baseline lift + exposure gates + confidence | ❌ | ⚠️ correlation, method opaque | ⚠️ | ❌ | ⚠️ | ❌ single "GutScore" | ⚠️ | ❌ score theatre |
| **AI narrative insights** | ✅ grounded in on-device evidence summary | ❌ | ❌ | ⚠️ | ❌ | ⚠️ coaching | ✅ | ✅ | ✅ |
| **Portion-aware FODMAP (red/amber/green)** | ❌ coarse keyword tags | ✅ gold standard, lab-tested | ❌ | ⚠️ | ❌ | ✅ dietitian-built | ⚠️ | ⚠️ | ❌ |
| **Guided 3-phase FODMAP program** | 🔜 designed | ✅ reintroduction in-app | ❌ | ✅ program | ❌ | ✅ full program | ⚠️ | ❌ | ❌ |
| **Snap-time "you're avoiding this" nudge** | 🔜 designed | ❌ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ safe/caution ratings |
| **Local-first, data on device** | ✅ IndexedDB | ⚠️ | ⚠️ | ❌ cloud | ⚠️ | ❌ cloud | ❌ cloud | ❌ | ❌ cloud |
| **Export (CSV/JSON)** | ✅ free | ⚠️ | ✅ clinician journals | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ mostly |
| **Clinician-ready report** | 🔜 | ⚠️ | ✅ | ✅ | ⚠️ share | ✅ | ⚠️ | ❌ | ❌ |
| **Cross-device sync** | ❌ (Sheets mirror 🔜) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Free tier that's actually usable** | ✅ logging + on-device stats free forever | ❌ paid app | ⚠️ 7-day trial | ⚠️ | ✅ free | ⚠️ 7-day trial | ⚠️ | ⚠️ | ❌ subscription-gated |
| **Platform** | PWA (iOS/Android/desktop) | iOS + Android | iOS + Android | iOS + Android | iOS only | iOS + Android | iOS + Android | app | iOS + Android |
| **App Store presence** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Clinical validation** | ❌ | ✅ university research | ⚠️ published data study | ✅ IBS-SSS outcomes | ❌ | ✅ dietitian/GI-developed | ❌ | ❌ | ❌ |
| **Price** | Free logging · Pro $4.99/mo · $29.99/yr · $79.99 lifetime | one-off ~A$12.99 | subscription (7-day trial) | subscription; reimbursed in DE | free | subscription (7-day trial) | subscription | subscription | subscription, typically $5–15/mo |

Adjacent, not directly competitive: **Nerva** (gut-brain hypnotherapy, ~NZ$219/yr,
no diet tracking by design), **Mahana IBS** (FDA-authorized prescription CBT, several
hundred dollars), **Zoe / Viome** (microbiome testing, £/$ hundreds), **Cronometer /
MyFitnessPal** (nutrient tracking, no symptom correlation).

---

## Where we genuinely win

1. **Capture friction.** Camera-as-home plus AI ingredient extraction. The classic
   diaries (mySymptoms, Monash) have better analysis or better data but make logging a
   chore, and adherence is the whole ballgame in a 6-week protocol.
2. **Honest correlation.** Our Foods ranking compares each food against the user's
   *own baseline* (lift ratio), requires ≥4 exposures and ≥3 symptom-follows before
   saying "Avoid," needs comparison meals without the food, and exposes confidence.
   The AI-scanner wave gives you a 0–100 score with no visible method. This is our most
   defensible technical asset and nobody markets it.
3. **Event model with lag windows and backdating.** Symptoms are timestamped and
   meal-independent, which matches the 30 min–48 h reality. Most day-bucketed
   competitors structurally cannot do this.
4. **Grounded AI.** Statistics on-device, compact evidence summary to the model,
   layered non-diagnostic prompts, red-flag escalation. Competitors' AI narrates vibes;
   ours narrates the user's actual numbers and is instructed not to invent any.
5. **Privacy and data ownership.** Local-first IndexedDB, free CSV/JSON export, no
   cloud log by default. A real differentiator in a category where everything else
   ships your bowel data to a server.
6. **Pricing structure.** Because marginal AI cost is ~$0.05/user/month, we can offer
   free logging forever and a $79.99 lifetime tier. Subscription-only competitors
   can't match that without hurting their model.

## Where we're behind

1. **No App Store presence.** Still our biggest single gap: the AI-scanner wave wins on
   store search and paid installs, and a PWA gets neither. Store listings also carry
   trust we have to earn another way. On iOS, web push needs the user to add the app to
   the home screen first, and "Add to Home Screen" is a real conversion cliff.
   Note the flip side — no download, no store account, and no 15–30% platform fee are
   genuine advantages we should market (see [`positioning.md`](./positioning.md)); the
   plan is native apps *in addition to* the web app, not instead of it. The gap is
   distribution, not capability.
2. **No portion-aware FODMAP data.** Monash's lab-tested red/amber/green is the moat.
   Our keyword tagging is coarse, so snap-time flags and elimination guidance will be
   "likely" rather than accurate until we license or assemble a dataset.
3. **The program isn't built.** Belly Balance and Monash both guide reintroduction
   today. Our designed version is better positioned (photo-first, AI-coached) but
   unbuilt features don't win users.
4. **No cross-device sync.** Local-first is a privacy win and a switching-cost loss.
   The Google Sheets mirror is one-way and still proposed.
5. **No clinician export yet.** mySymptoms and Cara Care both do this, and it's the
   thing that makes a tracker feel legitimate.
6. **No clinical validation or trust signals.** No trial, no dietitian byline, no
   university. Cara Care cites IBS-SSS outcomes; Belly Balance cites dietitian
   development and 100k+ users.
7. **Sign-in before first log.** Email gate ahead of value is friction the free
   competitors don't impose. Already flagged in `auth-and-credits.md` as optional.

---

## Threats worth watching

- **Fennly** — closest match to our positioning and naming direction. Assume feature
  parity on capture and trigger hints; differentiate on rigor, privacy, and the program.
- **Commodity photo-AI.** Meal recognition is no longer a moat; it's a $0.0002 API
  call anyone can wire up. The moat has to be the analysis, the program, and trust.
- **Monash extending the diary.** They own the data and the protocol. If they ship a
  modern capture flow, the reference-plus-program lane closes.
- **Category noise.** Dozens of near-identical "gut score" apps make users cynical.
  Being visibly rigorous is both a differentiator and a defense.

---

## Recommended positioning

Not "AI gut scanner" — that lane is commoditized and cynical. Position as:

> **The fast food diary that does the statistics properly, and then walks you
> through finding your actual triggers.**

Three proof points to lead with: seconds to log, patterns compared against your own
baseline rather than a made-up score, and a non-intrusive data model where the log
stays on your device and sync is your choice.

**Full positioning, message hierarchy, and a claim-by-claim accuracy audit live in
[`positioning.md`](./positioning.md).**

### Priority order to close the gap

1. **Ship the guided FODMAP reintroduction MVP** (`fodmap-program.md`) — the strongest
   differentiator we've designed, and the best Pro anchor.
2. **Solve distribution** — wrap the PWA for the App Store, or accept web-only and
   invest in SEO/content. Right now we're invisible.
3. **Clinician export** — cheap, high trust, unlocks word-of-mouth via dietitians.
4. **Market the correlation method** — "we won't call a food a trigger until the data
   earns it" is a genuinely differentiated claim in this category.
5. **Best vs worst days** — proven framing (Cara Care), already on the backlog.
6. **Let users log before sign-in** — removes the first-run cliff.

---

## Sources

- Monash FODMAP Diet app — [App Store listing](https://apps.apple.com/us/app/monash-fodmap-diet/id586149216) · [one-off pricing and download figures](https://www.monash.edu/news/articles/australias-own-low-fodmap-diet-going-strong-after-20-years)
- mySymptoms Food Diary — [App Store](https://apps.apple.com/us/app/mysymptoms-food-diary/id405231632) · [Google Play](https://play.google.com/store/apps/details?hl=en_AU&id=com.sglabs.mysymptoms)
- Cara Care — [product site](https://cara.care/en) · [App Store](https://apps.apple.com/us/app/cara-care-ibs-fodmap-tracker/id1133687886)
- Bowelle — [product site](http://www.bowelle.com/) · [App Store](https://apps.apple.com/nz/app/bowelle-the-ibs-tracker/id1436064640)
- Belly Balance — [App Store](https://apps.apple.com/au/app/belly-balance-ibs-fodmap/id949280275) · [UK site](https://bellybalance.co.uk/)
- Gutly — [App Store](https://apps.apple.com/us/app/gutly-fodmap-ibs-tracker/id1441942351)
- Fennly — [fennly.app](https://fennly.app/)
- AI-scanner wave — [Biome](https://apps.apple.com/us/app/biome-gut-health-improvement/id6738016955) · [GutBFF](https://apps.apple.com/us/app/gutbff-bloating-gut-health/id6746972409) · [gut app](https://apps.apple.com/au/app/gut-app-better-gut-health/id6744299849) · [GutSense](https://gutsense.health/) · [Gut Lens](https://gutlens.com/)
- Gut-brain lane — [Nerva](https://apps.apple.com/us/app/nerva-gut-brain-therapy/id1467398796) · [Nerva pricing reference](https://healthify.nz/apps/n/nerva-ibs-and-gut-hypnotherapy-app/) · [Mahana IBS pricing reference](https://www.singlecare.com/prescription/mahana-ibs) · [IBS app comparison](https://www.lin.health/insights/best-apps-ibs)
- Our own capability claims come from `README.md`, `docs/research-and-insights.md`,
  `docs/auth-and-credits.md`, `docs/fodmap-program.md`, and `docs/google-sheets-sync.md`.

_Competitor capabilities were assessed from public store listings and marketing pages,
not hands-on testing, so ⚠️ ratings are best-effort reads. Content synthesized and
rephrased from the above sources for licensing compliance._
