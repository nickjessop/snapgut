# FODMAP Program — Design (future flagship feature)

A guided, opt-in program that turns SnapGut from a passive tracker into a
**structured path to finding your triggers**. Status: **planned, not built.**

> Framing: educational / self-guided, not medical advice. Low-FODMAP is a
> therapeutic diet ideally done with a dietitian and is time-limited. Keep the
> non-diagnostic disclaimers, nudge toward professional support, and screen out
> disordered-eating risk (a restrictive protocol is inappropriate there).

---

## What the protocol is
Low-FODMAP (developed at Monash) is the most evidence-backed dietary approach for
IBS. It's a **time-limited, 3-phase experiment** to find *your* triggers:

1. **Elimination (2–6 wks):** cut high-FODMAP foods → symptoms settle → calm baseline.
2. **Reintroduction (6–8 wks):** challenge **one FODMAP subgroup at a time** with a
   standard test food in escalating doses over ~3 days, washout between, logging
   symptoms. This is the scientifically valuable part (most people skip/botch it).
3. **Personalization:** keep only real triggers, re-expand tolerated foods → a
   personal safe/limit list.

FODMAP subgroups + representative test foods:
- **Fructans** — wheat bread, garlic
- **GOS (galacto-oligosaccharides)** — chickpeas, almonds
- **Lactose** — milk, yogurt
- **Excess fructose** — honey, mango
- **Sorbitol** — avocado, blackberries
- **Mannitol** — mushrooms, cauliflower

## Why it's the flagship argument
- **The actual job-to-be-done:** users want a path to feeling better with a
  deliverable (personal trigger report), not just pattern observation.
- **Retention:** a multi-week program with a daily task gives a reason to open the
  app daily for weeks — the engine of habit-app retention.
- **Built on our existing engine:** reintroduction = structured n-of-1 experiments
  measured by symptom logging, which is exactly what our event timeline + FODMAP
  ingredient tagging + lag-window correlation already compute.
- **Differentiation + legitimacy:** Monash's app is a dry clinical reference/diary;
  competitors are passive diaries. A photo-first, AI-assisted, guided reintroduction
  coach is an unfilled niche.
- **Monetization:** "Unlock the guided FODMAP program" is a far stronger Pro anchor
  than "unlimited AI snaps." Outcome-oriented → reviews + word of mouth.

## How it works (mapped to the app)
- **Phase state machine** per user (phase, current challenge, day N) stored with events.
- **Elimination:** "what to avoid" guide + daily symptom check-in; when the on-device
  symptom trend flattens, prompt to start reintroductions.
- **Reintroduction:** app schedules challenges (subgroup → test food → escalating
  doses over 3 days, washouts between). Each challenge is tagged events on the
  existing timeline; the lag-window + severity engine yields a verdict per challenge:
  **tolerated / dose-limited / reactive**.
- **Personalization:** compile results into a personal FODMAP report; enrich the
  Foods tab with tolerances.

## ⭐ Snap-time FODMAP heads-up (the "gentle call-out")
When a user is in the **elimination phase**, use the meal-recognition result to warn
them, gently, if their dish likely contains foods they should be avoiding.

- **How:** recognition already returns confident/maybe ingredients; we already tag
  ingredients to FODMAP groups (`src/fodmap.ts`). On the MealDetails screen, if the
  active program phase is "elimination" (or a group is under active challenge/washout),
  flag matching ingredients.
- **UX:** a soft, non-judgy banner under the dish, e.g.
  *"Heads up — onion & garlic are high in fructans, which you're avoiding right now."*
  Highlight the specific ingredient chips (a small "high-FODMAP" tag). Never block the
  log; it's a nudge, not a gate. Tone: supportive, not scolding.
- **Smart, not noisy:** only flag during elimination/washout; during a *challenge* for
  group X, don't flag group X (that's the point), but do flag *other* groups that
  would confound the test — a genuinely useful "this could muddy your results" note.
- **Reuses everything:** no new detection — just the existing ingredient tagging +
  the meal flow + the program phase state. Low effort, high delight, and it makes the
  program feel alive between challenges.
- **Accuracy caveat:** our keyword tagging is coarse; frame as "likely/probably" and
  let users dismiss. A licensed food-level FODMAP dataset (Monash) would sharpen this.

## UX integration (minimal new surfaces)
- **Entry point:** a "Find my triggers" program card at the top of **Insights** (or a
  small Program banner on Logs). No new nav tab — keep [Logs] [+] [Insights].
- **Daily task banner** on Logs (same pattern as the backup nudge): today's challenge
  + one-tap "log reaction."
- **Snap-time heads-up** in MealDetails (above).
- **Reuses:** event timeline (challenges = tagged events), FODMAP tagging (avoid-flags
  + test foods), insights correlation (verdicts), layered AI prompts (Pro coaching).
- **Opt-in + Pro-gated:** passive tracking stays the default; the program is premium.

## Caveats / risks
- Medical framing + disordered-eating screening (above).
- **Dependency:** accurate food-level FODMAP data for elimination guidance. Monash's
  dataset is the gold standard but licensed; open lists vary. Current tagging is coarse.
- Multi-week adherence/drop-off → nudge quality matters (don't nag).
- Not everyone's goal → keep optional.

## Recommended MVP
Start with **Reintroduction only** — highest value, most defensible, and least
data-hungry (uses a small curated set of standard test foods per subgroup, no giant
food DB). Offer a simple elimination checklist as a lead-in. Add the **snap-time
heads-up** alongside (cheap, reuses existing tagging) so elimination still feels
guided. Full elimination food guidance later, if we license/assemble a FODMAP dataset.

### Build sketch (when we do it)
- `program.ts` (client): phase model, challenge schedule, verdict logic over events.
- Program card + daily-task banner components; MealDetails FODMAP flag.
- Extend `fodmap.ts` tags → per-subgroup test-food catalog.
- Personal report screen (reuses Foods/insights styling).
- Store: persist program state (local; syncs with future cloud sync).
- Pro gate + disclaimers + optional DE-risk screen at onboarding into the program.
