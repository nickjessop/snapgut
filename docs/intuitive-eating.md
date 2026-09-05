# Intuitive Eating — Design Philosophy

Can SnapGut be both a GI investigation tool *and* a teacher of intuitive eating?
Yes — if intuitive eating is the governing philosophy rather than a bolted-on course.
Companion to `docs/fodmap-program.md`.

> ⚠️ Non-therapeutic by design. Intuitive eating here is an *educational framing and a
> set of product constraints*, never a treatment for disordered eating. We screen and
> refer; we do not treat. The psychological evidence base for IE is solid; the
> physiological/symptom-relief evidence is not — so we never claim IE reduces symptoms.
>
> ⚠️ **Don't conflate two things §4b puts next to each other.** Exposure-based CBT is a
> clinician-delivered treatment with trial evidence for reducing IBS symptom severity.
> Intuitive eating is not that, and we are not delivering either. IE and exposure CBT point
> in the *same direction* — toward eating the feared food — which is why the IE literature
> and the GI literature agree here. That shared direction justifies our design choices; it
> does not license a symptom claim of any kind.

---

## 1. The answer, in short

**Investigation is an episode. Intuitive eating is the steady state.**

This isn't our framing — it's a documented paradox in the IBS literature. Biesiekierski
et al. (*Aliment Pharmacol Ther*, 2022) set exclusion diets against exposure-based CBT and
found **both have proven efficacy while being conceptually opposite**: one tells you to
avoid suspect foods, the other tells you to eat them. Their conclusion is that clinicians
should be fluent in both, and that there is minimal evidence on which works best for whom.
That is the product problem, stated by gastroenterologists, four years before we asked it.

The two look opposed because investigation requires temporarily *increased* food
vigilance (systematic exposure, hypothesis testing, some restriction) while IE requires
*decreased* vigilance and unconditional permission. In the same moment they conflict.
Sequentially they don't — and the reason matters:

For someone with real GI symptoms, unconditional permission isn't reachable by decision.
You can't will yourself into trusting food while every meal is a coin flip. What drives
the restriction is **uncertainty**, and IE has no mechanism for resolving uncertainty —
it can only ask you to tolerate it. Investigation *does* resolve it. Proper investigation
is therefore not the enemy of intuitive eating in this population, it's the
**prerequisite**. The narrower and better-evidenced your avoid-list, the more permission
you can actually afford.

**The order is clinically load-bearing, not just pedagogical.** Offering "make peace with
food" to someone with undiagnosed celiac or IBD is harmful. IE framing must never be
positioned as an alternative to investigating — only as what happens after.

## 2. One tool, two postures, one direction of travel

| | Steady state (default) | Investigation (opt-in) |
|---|---|---|
| Posture | Light, low-vigilance logging | Heightened, systematic attention |
| Purpose | Living, with occasional curiosity | Answering one specific question |
| Duration | Indefinite | **Bounded** — hard expiry |
| Ends when | — | Evidence is sufficient → report |
| Food framing | Permission, variety, comfort | Hypotheses under test |

Travel runs **investigation → steady state**, never the reverse by default. The app
should be visibly eager to hand your diet back.

Today SnapGut has only one gear, and it's the vigilance gear: camera is the home screen,
the Foods tab ranks continuously, and there is no state in which the app tells you you're
fine. That's the actual structural problem.

## 3. We are already teaching something

The version of "teacher" that fails is a curriculum — lessons, ten principles, progress
modules, a coach persona. That's a different product, it competes with books and
dietitians, it violates the no-quiz positioning pillar, and it preaches to someone who
arrived with a symptom question.

The version that works is that **the tool's behaviour is the lesson**, and this isn't
optional. The app already teaches: *food is a suspect, your gut is a crime scene, the
investigation never closes.* That's a pedagogy — just not a chosen one. The real question
is not whether to teach IE, but whether to keep teaching hypervigilance by default.

**Teach in the dialect of evidence, not affirmation.** The best teachable moment this app
can generate is a feared food being exonerated: *"you've eaten onion 6 times with nothing
following it — this one probably isn't your problem."* Exposure-shaped, delivered as a
statistical result, in the app's native voice. No principle needs reciting.

**The sharpest differentiated feature: the app has an opinion about when to stop looking.**
Every competitor teaches you to keep investigating indefinitely — that's their retention
model. A tool that closes the investigation, hands you a report, and downshifts is doing
IE education in its most credible form without using the word.

## 4. Evidence base

| Finding | Why it matters here |
|---|---|
| IE has four measured constructs: unconditional permission to eat, eating for physical rather than emotional reasons, reliance on hunger/satiety cues, body-food-choice congruence ("gentle nutrition") | Gives us a real definition to design against instead of wellness vocabulary |
| Strong evidence linking IE to adaptive psychological outcomes; causal direction still unsettled | Claim reduced food anxiety, not symptom relief |
| Physiological/health-parameter evidence is thin | **Never** market IE as a symptom treatment |
| **Motive is the moderator.** Tracking for weight/shape reasons predicts food preoccupation, all-or-nothing thinking, food anxiety and purging; tracking for health/disease-prevention reasons largely doesn't. An RCT introducing calorie counting found no mental-health effect | Our single largest protective factor: no weight, BMI, calories or macros anywhere in the app. Currently true by accident of scope. **Keep it that way.** |
| Qualitative work names the harmful mechanics: heavy quantification, designs that promote overuse, certain feedback styles | A concrete checklist to design against |
| Greater low-FODMAP adherence is associated with eating-disorder behaviour in IBS cohorts; expert guidance now recommends ED screening *before* prescribing low-FODMAP | `fodmap-program.md` flags this as a caveat with no mechanism behind it |
| **ARFID symptoms occur in up to ~40% of adults with disorders of gut–brain interaction** (Burton Murray et al., *Int J Eat Disord* 2023), and the ARFID/neurogastroenterology association is now its own review literature | Our users *are* the at-risk population. This is a plurality-scale risk, not an edge case |
| Low-FODMAP helps roughly 50–70% of IBS patients — so 30–50% don't respond — and predicting responders is an open research problem | Don't let the router funnel everyone toward FODMAP |
| Under double-blind placebo-controlled conditions FODMAPs elicit *modest* symptoms (Nordin et al., *AJCN* 2022) | Calibrate the confidence of our own language accordingly |
| Diary-based temporal association studies do find real signals — coffee, alcohol and artificial sweeteners among them (Clevers et al., *Dig Dis Sci* 2024) | Independent support for the method the app already uses |
| **NIAS item 8** asks whether the respondent restricts themselves to certain foods for fear that others will cause GI discomfort | Our core output — a food labelled "Avoid" — is phrased as a screening symptom |
| During a flare, pain/bloating/urgency drown out hunger and fullness cues; IBS involves heightened visceral sensitivity. Body mistrust mediates interoceptive awareness → ED symptoms | "Just listen to your body" is not actionable when interoception is the broken part. Also the argument *for* the app: external gated evidence is a scaffold |

## 4b. Avoidance may be maintaining the symptoms

This is the finding that upgrades §6 from "psychologically unkind and statistically
self-defeating" to **possibly symptom-worsening**, and it deserves its own section.

From the exclude-or-expose review and the exposure-CBT literature behind it:

- Low-FODMAP has demonstrated efficacy, but carries adherence problems, nutritional
  compromise, and **heightened gastrointestinal-specific anxiety**.
- Exposure-based CBT also has demonstrated efficacy, with substantial evidence that
  **GI-specific anxiety is its mechanism of action**.
- A dismantling study (Ljótsson and colleagues) found the effect runs through
  GI-anxiety-specific processes rather than generic ones, with **IBS-specific behavioural
  avoidance the clearest mediator**.
- Most striking: **mediation analysis showed that *increased* FODMAP intake mediated
  *decreased* symptom severity** in exposure-based CBT.

Read that last point against our Foods tab. Eating more of the suspect food is, in one
evidence-based treatment arm, part of how people get better. A permanent red "Avoid" label
is not a neutral readout of the data — it is an intervention, in the opposite direction,
delivered without consent or a stopping rule.

**Caveat we must hold honestly:** this does not mean food triggers aren't real, and it does
not license us to talk anyone out of a genuine intolerance. Both arms work. The review's own
conclusion is that we don't know who belongs in which. Which is exactly why the app must not
silently pick a lane on the user's behalf — see §9.

## 4c. The nocebo problem — a limit on the whole method

Unblinded self-tracking cannot separate a food effect from an expectancy effect. This is a
structural limit on SnapGut, every competitor, and any food diary:

- In double-blind placebo-controlled gluten challenges, only **16% of self-identified
  non-coeliac gluten sensitivity patients showed gluten-specific symptoms, while 40% had a
  nocebo response** — similar or worse symptoms on placebo.
- A 2024 DBPC study in IBS patients with perceived gluten sensitivity found **similar
  proportions reacting to wheat, to gluten, and to nocebo challenge**.
- Nocebo in food challenge is now studied directly (Elsenbruch group, 2025), and
  multi-food adverse reaction in IBS tracks with psychological distress and perceived
  stress.

The consequence for us is uncomfortable and worth writing down: **once we tell someone a
food is a trigger, their belief can generate the symptom that confirms our label.** The loop
closes on itself, and our own follow-rate statistics will look like vindication. The evidence
gates in `foodScores.ts` protect against noise; they cannot protect against expectancy.

Design implications:
- Never present a rank as a settled fact about the food. This is an argument for §10's
  rewording independent of the IE case.
- A re-test is more informative when the user isn't primed. Ideally the food under test is
  not named in advance at re-test time; at minimum, don't restate the old verdict while
  asking them to try it again.
- Exoneration deserves *more* interface weight than accusation, because accusation
  self-reinforces and exoneration doesn't.

## 5. The precedent is stronger than expected

This combination is standard of care, not a novel product bet. GI dietitians do both
jobs, which is exactly why the **AGA GI Patient Center** publishes an intuitive-eating
page for GI conditions, reviewed by a Disordered Eating in GI workgroup. Their framing is
already the hybrid — in one place they hold that strict diets can reduce symptoms but
carry side effects like any medication, that a known trigger food can still be worth
eating sometimes, and that finding a better-tolerated version beats dropping a food.

So we'd be modelling what a good practitioner actually does — one that walks you through
finding your actual triggers. The
unstated second half of that promise is that a good practitioner is visibly eager to give
you your diet back.

### AGA's GI translation of the ten principles → what each implies for us

| Principle (GI-adapted) | Product implication |
|---|---|
| Reject the diet mentality | Elimination must expire; no permanent protocol |
| Honor your hunger | Capture hunger; don't let fear of symptoms drive skipped meals |
| Make peace with food | Ranks describe, they don't command |
| Challenge the food police | Show confidence and method; be a trusted source, not an oracle |
| Discover the satisfaction factor | Suggest better-tolerated swaps, not subtraction |
| Feel your fullness | Capture fullness — under-eating then overeating worsens GI symptoms |
| Cope with your emotions with kindness | Handle food-focused events; no guilt mechanics |
| Respect your body | No weight, no scale, no body metrics. Ever |
| Movement | Out of scope for us |
| Gentle nutrition | Frame nutrients as *adequacy*, never as limits |

---

## 6. Where the app currently works against this

Audited against the code, not the intent.

### Measurement is negative-only
`src/symptoms.ts` ships **3 positive chips against 25 negative** (~11%), and the source
comment (`// Positive — so logging isn't all-negative`) reads like it knows. Worse, both
`src/insights.ts` and `src/foodScores.ts` filter with:

```ts
const isNegative = (id: string) => getSymptom(id)?.category !== "Positive";
```

So positives are excluded from **every** analysis path. Logging "Feeling great" after a
meal contributes nothing to that food's rank, and nothing to any insight. **The app cannot
currently represent a good experience at all** — the only evidence a food can offer in its
own defence is silence. Severity chips (Mild/Moderate/Severe) also apply to positive
chips, which reads oddly.

The fix is *not* a mirror-image positive score — see §6b, which is the design that matters
most to get right before anyone writes code.

### "Avoid" is a one-way ratchet — statistically as well as psychologically
`RANK_META` in `src/foodScores.ts` labels the worst rank `"Avoid"` in `#c0392b`. It's
prescriptive, identity-level and permanent. Once a food is labelled Avoid the user stops
eating it, `eaten` stops incrementing, and the counter-evidence that could exonerate it
never arrives. The rank freezes.

The co-occurrence problem — two foods
that always appear together can't be separated until one is eaten alone — but the UI
actively discourages the exposure needed to resolve it. **The label degrades our data
quality and the user's diet at the same time**, and per §4b may also be reinforcing the
avoidance that mediates symptom severity. This is the central finding of this doc.

### Four further things the scoring code does that matter here

Read in full, `computeFoodScores` is more conservative than most competitors and still has
four properties worth naming:

1. **"Agrees with you" is awarded on silence, with no baseline-reliability requirement.**
   In `rankFor`, the `baselineReliable` guard wraps only the `avoid` and `reduce` branches.
   The `agrees` branch (`foodRate <= 0.25 && lift <= 0.9`) runs regardless. So the app's
   most reassuring label is the one with the weakest evidence standard behind it — and it
   rests entirely on *nothing having been logged*. This is the precise hook for §6b:
   confirmed-clean windows belong here.

2. **A single symptom implicates up to a day of ingredients.** `followed` is true if *any*
   negative symptom appears in the 24h after a meal (`labels.size > 0`). At roughly three
   meals a day, one bad evening marks three meals and every confident ingredient in them.
   Baseline inflates too, so `lift` partially absorbs it, but per-ingredient attribution is
   much coarser than the UI's percentage implies. This is the co-occurrence problem at a
   larger scale than the docs acknowledge.

3. **Severity is captured and then ignored.** `SEV_SCORE` lives in `insights.ts` and only
   feeds `avgSeverity` for display. `foodScores.ts` doesn't import it — a mild burp and
   severe cramping count identically toward "Avoid."

4. **"Reduce" is reachable on very little.** Four exposures with two symptom-follows gives
   `foodRate` 0.5 at `lift` ≥ 1.25 → `reduce`. That's a directive to eat less of something
   on the strength of two coincidences. The `avoid` gates are genuinely strict; `reduce`
   is not, and it's the label most users will accumulate most of.

### Every AI path terminates in restriction
All five `FOCUS_PROMPTS` modules in `server/index.js` end in an elimination-style
instruction (test a group in isolation, try a low-histamine trial, shift the meal
earlier). There is no reintroduction module, no re-expansion module, and nothing that
fires when someone is avoiding too much. `BASE_INSIGHT_PROMPT` has a red-flag list for
medical danger and nothing for restriction distress. The routing architecture is right;
the routing table is missing half its destinations.

### Smaller items
- **No hunger, fullness, portion or satisfaction capture anywhere.** The nearest thing is
  the `early_full` symptom, which is *pathologised* as Upper GI.
- `src/moods.ts` is dead code (imported nowhere) containing `{ label: "Guilty", emoji: "😬" }`.
  Delete it.
- `CheckinEvent.sleep` is captured and stored but never read by the stats engine.

### Credit where due
The streak mechanic is already well-behaved: it only appears at ≥2 days, deliberately
doesn't break for an unlogged today, and its copy frames consistency as *data quality*
rather than virtue. No goals, badges, scores, or logging reminders exist. That's close to
the right answer already — don't regress it.

## 6b. Where positive signal attaches — the attribution model

The obvious reading of §6 is "let positives earn credit for a food." That's wrong, and
building it would make the engine worse. Three things to get straight first.

### The meal is the unit of observation
Scoring already works this way: a symptom event attributes back to meals inside the 24h
lag window, each ingredient inherits its meal's outcome, and a food's rate is
`meals-followed-by-symptom / times-eaten`, compared against your baseline for meals
without it. You never observe "onion" — you observe a meal containing onion. **Any positive
signal therefore attaches to the meal event and can only reach food level by aggregation.**

### A symmetric positive score would double-count
The model *already* counts good outcomes — as the absence of negatives. A meal with a quiet
window is what earns "Agrees with you." Add credit for an explicit "Comfortable" log on top
and the same underlying fact is rewarded twice, with the bonus going to whoever logs most
diligently.

### The missing-data asymmetry is severe
Negatives are salient — people log bloating because it's notable. Feeling fine is
unremarkable, so positives get logged sporadically and non-randomly. Absence of a positive
log means almost nothing; absence of a negative log means something. A parallel positive
rate would largely measure conscientiousness, then present it as physiology.

### So: positives raise confidence, they don't move the rate
What an explicit positive genuinely adds is **disambiguating a confirmed-clean window from
an unlogged one.** Today a quiet 24h could mean you felt fine or you put the phone down;
the engine can't tell. A positive log settles it. That belongs in the confidence and
exposure gating — making "Agrees with you" better *evidenced* — not in the numerator.

**This is cleanly implementable.** `FoodScore.confidence` is a separate field derived
*solely* from exposure count (`eaten >= 8` high, `>= 5` medium, else low) and is not an
input to `rankFor`. So a confirmed-clean count can be threaded into the confidence term
without touching `foodRate`, `baselineRate` or `lift` at all. And per §6 finding 1, the
`agrees` branch currently has no baseline-reliability guard — so requiring some confirmed
clean windows before awarding "Agrees with you" is the natural place to spend this signal,
and it tightens the app's weakest evidence standard rather than loosening anything.

### Three signals, three destinations

| Signal | Example | Attaches to | Effect on food scores |
|---|---|---|---|
| **Subsequent wellbeing** — mirror of symptom logging, lives in the lag window | "Comfortable", "Feeling great" 3h after eating | Meal, via lag window | Confirms a clean window → **raises confidence**, does not raise the rate |
| **Meal-intrinsic experience** — a property of the eating occasion, not of any ingredient | Satisfied, comfortably full, ate calmly | Meal, permanently | **Never propagates to ingredients.** A covariate, like `lateNightSymptomRate` |
| **Deliberate re-test outcome** | Re-tested onion alone, fine | The food under test | **Legitimately updates that food's rank** |

The middle row is the one that saves us from bad conclusions. A satisfying, well-portioned
plate of pasta is information about portion and context, not about wheat. Aggregating it
into ingredient scores would be actively misleading; keeping it as a meal covariate is what
lets the engine say *"this reads as portion, not the garlic."*

The bottom row is the one clean carve-out: a re-test is a deliberate single-variable
experiment with a stated hypothesis and low confounding, so a good outcome there really is
evidence about that food. Which is a neat argument for building the re-test path early — it
is the only mechanism that can *positively* exonerate a food rather than merely failing to
convict it.

### UI implication
The three positive chips currently sit in the symptom picker under "How's your gut?", which
conflates the first two rows. Comfort-at-the-meal belongs on the **meal** flow as a
post-meal tap; only subsequent-wellbeing belongs with symptoms. Splitting them is a
prerequisite for the table above, not a polish item.

## 7. Why this makes the trigger detection better

The argument that should sell this internally: **IE data is a missing confounder, not a
wellness veneer.**

Today, if someone eats a large meal, late, ravenous after skipping lunch, and gets
bloated, the engine attributes it to whatever ingredient was in the bowl. Volume, eating
speed and eating past comfortable fullness are all mechanistically plausible drivers of
bloating and reflux *independent of food composition*, and we capture none of them. We
already model late-night eating as a confounder (`lateNightSymptomRate`), so the pattern
is established.

A pre-meal hunger tap and a post-meal comfort/satisfaction tap would serve IE principles
(*honor your hunger*, *feel your fullness*, *the satisfaction factor*) **and** give the
correlation engine two new covariates — plus a mechanism for exonerating a food: *"this
looks like portion, not the garlic."* Better product, not just a kinder one.

It also fits the flagship feature rather than fighting it. `fodmap-program.md` notes that
reintroduction is the scientifically valuable phase and that most people skip or botch it;
low-FODMAP is time-limited by design; clinical practice targets the least restrictive diet
that controls symptoms. So the IE-aligned goal and the clinically correct goal are the
same goal: **get foods back.** Reframing the program's deliverable from an avoid-list to a
re-expansion list is an IE move, a Monash-faithful move and a marketing move at once.

## 8. The conflict we should name out loud

`fodmap-program.md` argues the program is good for retention because a multi-week protocol
"gives a reason to open the app daily for weeks." That means
**users stay in elimination longer** — and elimination
is the phase carrying the nutrient and microbiome risk, and the phase whose adherence
correlates with ED behaviour.

Decision to take now, while `program.ts` is still a sketch:
- Elimination **hard-expires** in the state machine — a ceiling in weeks, with the app
  pushing you out rather than waiting for you to leave.
- The success event is the **personalisation report**, not days retained.

## 8b. Diet stacking — a risk our router actively manufactures

"Diet stacking" is a term coined by Melton et al. (*JGH Open*, 2025) for the accumulation
of two or more concurrent dietary strategies — low-FODMAP on top of gluten-free on top of
vegetarian on top of "clean eating" — usually without professional oversight, and with
compounding risk of nutritional inadequacy. It's a recognised and growing clinical problem.

Now read `route()` in `src/insights.ts` against that. The router can send the same user to
`histamine-suspect` this week and `fodmap-suspect` next week — histamine is checked *first*,
and `fodmap-suspect` fires whenever `associations.length > 0`, a low bar given associations
only need `count >= 2`. Each corresponding prompt in `FOCUS_PROMPTS` proposes its own
elimination trial: a single-group FODMAP test, a short low-histamine trial, a meal-timing
change. `meal-timing` adds a fourth rule.

**Nothing anywhere in the codebase tracks cumulative restriction.** There is no count of
active or suggested eliminations, no memory of what was suggested last time, and no state
that would let the app notice it has now recommended three overlapping regimes. Each
suggestion is individually defensible and locally well-evidenced; the sequence is a stacking
machine.

Fixes, cheapest first:
- Persist what the router has already suggested, and never suggest a second elimination
  while a first is unresolved. One open experiment at a time.
- Add cumulative restriction to the evidence summary (see §10's variety signal) so the model
  can see the total, not just the latest signal.
- Add an explicit instruction to `BASE_INSIGHT_PROMPT` forbidding a new elimination when one
  is already in play, and requiring the model to propose *resolving* the open one instead.

## 9. Design rules

1. Ranks **describe**, never command. Keep the statistics; drop the imperative verb.
2. Positive experience is **load-bearing**, not decoration — but it raises *confidence*,
   it doesn't create a mirror-image score (§6b).
3. Every restriction has an **expiry** and a re-test path.
4. Investigation has an entry reason, an exit condition and a deliverable.
5. Confounders before culprits — portion, timing, hunger, stress and sleep get considered
   before an ingredient is blamed.
6. No quantification of the body. No weight, BMI, calories or macros.
7. Screen and refer; never treat.
8. IE framing arrives **after** investigation, never instead of it.
9. **One open experiment at a time.** Never suggest a second elimination while a first is
   unresolved (§8b).
10. **Don't pick a lane for the user.** Exclusion and exposure both work and nobody knows
    who belongs in which (§4b) — so offer, explain, and let them choose, rather than
    routing them silently.
11. **Treat expectancy as a confound, not a nuisance.** Ranks are provisional, exoneration
    outranks accusation, and re-tests avoid re-priming the old verdict (§4c).

## 10. Backlog — ordered by leverage per unit of effort

- [ ] **Make positive experience count — per §6b, not as a positive score.** Split the
      taxonomy (meal-intrinsic comfort → meal flow; subsequent wellbeing → symptom flow),
      expand beyond three options, drop severity from positives, and wire confirmed-clean
      windows into the **confidence** term in `foodScores.ts` rather than the rate. Turns a
      threat detector into a compatibility finder. **Do not** simply invert `isNegative`
      and add credit — that's the double-counting version.
- [ ] **Reword `RANK_META` to be descriptive.** "Avoid" → e.g. "Often followed by
      symptoms". Five strings in one file. The gating logic is genuinely rigorous — it's
      the verb and the red that do the damage.
- [ ] **Re-test path off every non-neutral food.** *"Haven't eaten this in 6 weeks — worth
      another try?"* Fixes the statistical dead-end and the dietary narrowing with one
      mechanic. Tolerance changes, and dose matters. Per §6b this is also the **only**
      mechanism that can positively exonerate a food rather than failing to convict it —
      which is why it should come early.
- [ ] **Hunger-before / satisfaction-after on the meal flow.** Two optional taps in
      `MealDetails`. Meal-intrinsic per §6b: they enter `EvidenceSummary` as covariates
      beside `lateNightSymptomRate` and must not propagate to ingredient scores.
- [ ] **Over-restriction routing signal.** Compute weekly food variety, avoid-set size and
      time-since-last-eaten on-device. Route to a new `re-expansion` focus module when
      variety trends down or the avoid-set grows. Add restriction distress to the base
      prompt's red-flag handling.
- [ ] **Gate the FODMAP program behind a real screen.** Not at onboarding (see §11) but at
      program entry, where a time-limited therapeutic protocol justifies asking. NIAS is
      nine items, validated, with published cutoffs including work in GI settings. A
      positive screen routes to support resources and a gentler non-elimination path —
      it must not silently proceed, and must not claim to diagnose.
- [ ] **Reconsider the snap-time FODMAP heads-up.** A banner appraising every photographed
      meal during elimination is a food-police mechanic. Restrict it to active challenge
      and washout windows, where flagging confounders is scientifically necessary.
- [ ] **One-open-experiment guard (§8b).** Persist suggested eliminations; block the router
      and the prompt from opening a second while one is unresolved. Cheap, and it closes the
      diet-stacking path.
- [ ] **Weight `avoid`/`reduce` by severity.** `SEV_SCORE` already exists in `insights.ts`
      but `foodScores.ts` ignores it, so a mild burp and severe cramping count the same.
      Fewer foods would clear the bar, which is the point.
- [ ] **Tighten `reduce`.** Two symptom-follows out of four exposures currently earns a
      directive to eat less (§6 finding 4).
- [ ] Delete `src/moods.ts` (dead code, contains a "Guilty" food chip).
- [ ] Read `CheckinEvent.sleep` into `EvidenceSummary` — a captured confounder we ignore.

## 11. Anti-roadmap — what we will not build

- ❌ **Calories, macros, weight, BMI, body metrics.** The motive research says this is the
  switch that turns a health tracker into a risk factor. The backlog's "Cronometer-style
  nutrient angle" is where this vector would enter — if we do fibre and micronutrients,
  frame it as *adequacy* ("are you getting enough, given what you've cut"), which is both
  the gentle-nutrition principle and the real clinical risk of low-FODMAP shortfall.
- ❌ **An IE curriculum, lesson deck or coach persona.** Different product.
- ❌ **An onboarding IE questionnaire.** The app promises no profile and no quiz,
  and a 23-item IES-2 is exactly the friction we design against. Derive what we can from
  *behaviour* — variety trend, avoid-set size and age, restriction duration — and only ask
  questions at the program gate. Behavioural inference is also more honest than self-report.
- ❌ **Any claim that IE relieves GI symptoms.** Not supported.
- ❌ **Any claim to treat, or screen definitively for, an eating disorder.**
- ❌ **Guilt, shame or compliance mechanics** — no "you broke your diet", no adherence
  score, no red days.

## 12. Measurement — the tell for whether this is real

If the app is teaching IE, these become the outcome metrics:

- **Food variety per week** — trending up
- **Avoid-set size** — trending down
- **Concurrent restrictions** — capped at one (§8b)
- **Time-to-exit from investigation** — getting shorter
- **Foods exonerated** (re-tested and cleared) — a count worth surfacing to the user

If we ever want a validated instrument rather than behavioural proxies, the right one is
the **Visceral Sensitivity Index** — 15 items, validated in IBS and extended to IBD, and it
measures **GI-specific anxiety**, which §4b identifies as the actual mechanism through which
exposure-based CBT works. That makes VSI the mechanistically correct outcome measure for
this doc's whole thesis, and it pairs cleanly with NIAS: **NIAS is the gate** (screen before
a restrictive protocol), **VSI is the dial** (is the product making food less frightening or
more). Both are short enough to survive the no-quiz constraint if used at the program
boundary rather than at onboarding.

All computable on-device, all honest, and all in direct tension with days-retained.
Deciding now which of these we'd report in a year is more consequential than any
individual feature above.

**Known trade-off:** local-first storage is an asset here (food and body data carry shame;
nothing leaves the device by default, which is the *respect your body* principle
implemented as architecture). But it also means we can't observe at population level
whether these mechanics reduce restriction. We ship the psychology on faith. That's the
right trade — just make it knowingly.

## 13. Claims we could defend / must not make

| Claim | Verdict |
|---|---|
| "Patterns are compared against your own baseline before a food is flagged" | ✅ already true |
| "No calories, no weight, no body metrics" | ✅ true today — protect it |
| "Only one food experiment at a time" | ⚠️ true once the §8b guard ships |
| "We help you get foods back, not just take them away" | ⚠️ true once re-test ships |
| "Intuitive-eating-aligned, following AGA-published GI guidance" | ⚠️ defensible once §10 lands |
| "Reduces food anxiety" | ⚠️ plausible per IE literature; unverified for *this* app |
| "Intuitive eating improves your gut symptoms" | ❌ evidence doesn't support it |
| "Screens for / helps with eating disorders" | ❌ we screen and refer, nothing more |
| "A safe replacement for a dietitian-supervised low-FODMAP diet" | ❌ never |
| "Confirms which foods you react to" | ❌ unblinded tracking can't separate food from expectancy (§4c). Say *associations*, as we already do |
| "Your trigger list is settled" | ❌ nothing here is settled; ranks are provisional by design |

## 14. Sources

- AGA GI Patient Center — Intuitive eating for GI conditions — https://patient.gastro.org/intuitive-eating-for-gi-conditions/
- 10 principles of intuitive eating — https://www.intuitiveeating.org/10-principles-of-intuitive-eating/
- IES-2 psychometrics & correlates (systematic review) — https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0349590
- IE psychological correlates (meta-analysis) — https://onlinelibrary.wiley.com/doi/abs/10.1002/eat.23509
- IE/mindful eating & physiological parameters (narrative review) — https://pmc.ncbi.nlm.nih.gov/articles/PMC10098784/
- Mindful & intuitive eating: insights and interventions (editorial) — https://www.frontiersin.org/journals/nutrition/articles/10.3389/fnut.2026.1837530/full
- **Exclude or expose? The paradox of conceptually opposite treatments for IBS** (Biesiekierski et al., *Aliment Pharmacol Ther* 2022) — https://pubmed.ncbi.nlm.nih.gov/35775328/
- How does exposure therapy work? Dismantling study, GI-specific mediators — https://pubmed.ncbi.nlm.nih.gov/29504793/
- Brief CBT for ARFID in disorders of gut–brain interaction (ARFID ~40% in DGBI) — https://pubmed.ncbi.nlm.nih.gov/36550697/
- ARFID and neurogastroenterology disorders (review) — https://pubmed.ncbi.nlm.nih.gov/40159723/
- Brain–gut psychotherapies for GI problems in eating disorders — https://pmc.ncbi.nlm.nih.gov/articles/PMC8962673/
- Multidisciplinary management of DGBI: psychopharmacology, psychotherapy, diet — https://www.frontiersin.org/journals/gastroenterology/articles/10.3389/fgstr.2025.1637172/full
- **Diet stacking** (Melton et al., *JGH Open* 2025) — https://pubmed.ncbi.nlm.nih.gov/41384274/
- Diet stacking, plain-language coverage — https://www.medscape.com/viewarticle/diet-stacking-may-complicate-managing-gi-disorders-2026a100049u
- Nocebo in NCGS double-blind challenge (16% gluten-specific, 40% nocebo) — https://pubmed.ncbi.nlm.nih.gov/27523634/
- Unravelling the power of nocebo in food challenge in IBS — https://pubmed.ncbi.nlm.nih.gov/40706612
- Wheat vs gluten vs nocebo challenge in perceived gluten sensitivity — https://academic.oup.com/jcag/article/7/Supplement_1/12/7607525
- Distress, perceived stress & multifood adverse reaction (nocebo) in IBS — https://pmc.ncbi.nlm.nih.gov/articles/PMC10506782/
- FODMAPs, but not gluten, elicit modest IBS symptoms (DBPC crossover) — https://pubmed.ncbi.nlm.nih.gov/34617561/
- Predicting response to the low-FODMAP diet — https://pubmed.ncbi.nlm.nih.gov/40419398/
- Temporal associations: coffee, alcohol, artificial sweeteners — https://pubmed.ncbi.nlm.nih.gov/38662159/
- Visceral Sensitivity Index — development & validation — https://pubmed.ncbi.nlm.nih.gov/15225175/
- VSI & the central role of GI-specific anxiety in IBS — https://pubmed.ncbi.nlm.nih.gov/17244851
- VSI extended to IBD — https://pubmed.ncbi.nlm.nih.gov/35478469/
- Low-FODMAP adherence & ED behaviour in IBS — https://pubmed.ncbi.nlm.nih.gov/30543574/
- Low-FODMAP risk in eating disorders (expert Q&A) — https://gastroenterologyadvisor.com/features/expert-qa-low-fodmap-diet-risky-in-patients-with-eating-disorders
- IBS, disordered eating and eating disorders — https://pmc.ncbi.nlm.nih.gov/articles/PMC6589841/
- ARFID screening in IBD with IBS-like symptoms — https://pubmed.ncbi.nlm.nih.gov/42329518/
- NIAS initial validation — https://pubmed.ncbi.nlm.nih.gov/29208483/
- NIAS subscale cutoffs — https://pubmed.ncbi.nlm.nih.gov/33884646/
- NIAS in a paediatric GI clinic — https://thescholarship.ecu.edu/items/25a9a147-4117-46a3-86bd-aa5353a83632/full
- Food avoidance & diet-related anxiety in IBS — https://pmc.ncbi.nlm.nih.gov/articles/PMC11465611/
- Intuitive eating with IBS & GERD (cues during a flare) — https://foodguides.com/blogs/from-the-experts/intuitive-eating-with-ibs-gerd-part-1
- GI interoception in eating disorders — https://pmc.ncbi.nlm.nih.gov/articles/PMC8898253/
- Body mistrust bridges interoceptive awareness & ED symptoms — https://pmc.ncbi.nlm.nih.gov/articles/PMC8140607/
- Calorie-tracking motive & ED symptoms — https://pubmed.ncbi.nlm.nih.gov/34543856/
- Weight-related self-monitoring, longitudinal — https://jeatdisord.biomedcentral.com/articles/10.1186/s40337-024-01069-x
- Diet/fitness apps & ED behaviours (qualitative) — https://pmc.ncbi.nlm.nih.gov/articles/PMC8485346/
- Calorie-counting RCT, no mental-health effect — https://pubmed.ncbi.nlm.nih.gov/34427188/
- Fitness/diet tracking & disordered eating (systematic review) — https://pmc.ncbi.nlm.nih.gov/articles/PMC12547374/
- Nutritional approach to IBS (microbiome implications of elimination) — https://pmc.ncbi.nlm.nih.gov/articles/PMC5777282/
- Low-FODMAP nutrient risk — https://www.va.gov/WHOLEHEALTHLIBRARY/docs/The-Low-FODMaP-Diet.pdf

_Content synthesized and rephrased from the above sources for licensing compliance._

_Code observations audited against the repo on 29 July 2026. `src/foodScores.ts` and
`src/insights.ts` were read in full (§6, §6b and §8b rest on the actual `rankFor` gates,
the `confidence` derivation and the `route()` ordering). `src/symptoms.ts`, `src/moods.ts`,
`src/db.ts`, `src/Intro.tsx`, `src/FoodsTab.tsx`, `src/InsightsView.tsx`, `src/App.tsx` and
the insights route in `server/index.js` were read for the copy and taxonomy claims.
Re-audit before acting — the ✅ marks are only as good as the code they describe._
