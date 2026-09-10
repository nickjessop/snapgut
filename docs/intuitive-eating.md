# Why the app won't tell you a food is a trigger

SnapGut looks for associations between food and symptoms. That is a useful thing to do and a
dangerous thing to do badly, because the population most likely to use a food diary is also
the population most at risk from food restriction. This document is the reasoning behind the
app's caution: why the evidence gates are set where they are, why a rank is phrased as an
association rather than a verdict, and where the current code still works against its own
stated principles.

**Who this is for:** anyone changing `src/foodScores.ts` (the ranking thresholds and
`RANK_META` labels), `src/insights.ts` (the `route()` focus selection), `src/symptoms.ts`
(the chip taxonomy), or the insight prompts in `server/app.js`. The critique of the scoring
model below is the part that matters most if you are touching `src/foodScores.ts` — several
of its findings are unresolved. Companion to
[fodmap-program.md](fodmap-program.md), which describes the protocol the app partially
models.

> **Framing, stated once.** Intuitive eating here is a set of design constraints, not a
> treatment and not a feature. The psychological evidence base for intuitive eating is
> solid; the evidence that it relieves physical GI symptoms is not. The app therefore never
> claims it does.
>
> **Two things not to conflate.** Exposure-based CBT is a clinician-delivered treatment with
> trial evidence for reducing IBS symptom severity. Intuitive eating is not that, and this
> project delivers neither. They point in the same direction — toward eating the feared food
> — which is why the two literatures agree at the point that matters for design. That shared
> direction justifies the design choices below. It does not license a symptom claim of any
> kind.

---

## 1. Investigation is an episode; ordinary eating is the steady state

This is a documented paradox in the IBS literature rather than a product opinion.
Biesiekierski et al. (*Aliment Pharmacol Ther*, 2022) set exclusion diets against
exposure-based CBT and found **both have proven efficacy while being conceptually
opposite**: one tells you to avoid suspect foods, the other tells you to eat them. Their
conclusion is that clinicians should be fluent in both, and that there is minimal evidence
on which works better for whom.

The two conflict in the moment because investigation requires temporarily *increased* food
vigilance — systematic exposure, hypothesis testing, some restriction — while unconditional
permission to eat requires *decreased* vigilance. Sequentially they don't conflict, and the
reason is the useful part:

For someone with real GI symptoms, permission is not reachable by decision. You cannot will
yourself into trusting food while every meal is a coin flip. What drives the restriction is
**uncertainty**, and intuitive eating has no mechanism for resolving uncertainty — it can
only ask you to tolerate it. Investigation does resolve it. Proper investigation is
therefore not the opposite of relaxed eating in this population, it is the **prerequisite**.
The narrower and better-evidenced the avoid-list, the more permission it can afford.

**The order is clinically load-bearing.** Offering "make peace with food" to someone with
undiagnosed celiac disease or IBD is harmful. This framing is never an alternative to
investigating — only what should follow it.

Which sets the direction of travel: **investigation → steady state**, never the reverse by
default. Investigation should be bounded, with an entry reason, an exit condition and a
deliverable. Today SnapGut has only one gear and it is the vigilance gear: the camera is the
home screen, the Foods tab ranks continuously, and there is no state in which the app tells
you you are fine. That is the structural gap.

## 2. The tool's behaviour is the lesson

A curriculum — lessons, principles, progress modules, a coach persona — is a different
product, and it preaches to someone who arrived with a symptom question. The app is already
teaching something regardless: *food is a suspect, your gut is a crime scene, the
investigation never closes.* That is a pedagogy, just not a chosen one. So the real question
is not whether to teach a healthier relationship with food, but whether to keep teaching
hypervigilance by default.

The teaching should happen **in the dialect of evidence, not affirmation**. The most useful
thing this app can generate is a feared food being exonerated: *"you've eaten onion 6 times
with nothing following it — this one probably isn't your problem."* That is
exposure-shaped, delivered as a statistical result, in the app's own voice, with no
principle recited. It also means the app needs an opinion about **when to stop looking** — a
tool that closes an investigation, hands over a summary and downshifts is doing the
educational work in its most credible form without ever using the vocabulary.

## 3. Evidence base

| Finding | Why it matters here |
| --- | --- |
| Intuitive eating has four measured constructs: unconditional permission to eat, eating for physical rather than emotional reasons, reliance on hunger and satiety cues, and body–food-choice congruence | A real definition to design against instead of wellness vocabulary |
| Strong evidence linking it to adaptive psychological outcomes; causal direction still unsettled | Claim reduced food anxiety at most, never symptom relief |
| Physiological and health-parameter evidence is thin | **Never** present it as a symptom treatment |
| **Motive is the moderator.** Tracking for weight or shape reasons predicts food preoccupation, all-or-nothing thinking, food anxiety and purging; tracking for health reasons largely does not. An RCT introducing calorie counting found no mental-health effect | The single largest protective factor in this app: no weight, BMI, calories or macros anywhere. Currently true by accident of scope. **Keep it that way** |
| Qualitative work names the harmful mechanics: heavy quantification, designs that promote overuse, certain feedback styles | A concrete checklist to design against |
| Greater low-FODMAP adherence is associated with eating-disorder behaviour in IBS cohorts; expert guidance now recommends screening *before* prescribing it | A restrictive protocol needs a gate, not a caveat |
| **ARFID symptoms occur in up to ~40% of adults with disorders of gut–brain interaction** (Burton Murray et al., *Int J Eat Disord* 2023), and the association is now its own review literature | The app's users *are* the at-risk population. Plurality-scale, not an edge case |
| Low-FODMAP helps roughly 50–70% of IBS patients, so 30–50% don't respond, and predicting responders is an open research problem | `route()` must not funnel everyone toward FODMAP |
| Under double-blind placebo-controlled conditions FODMAPs elicit *modest* symptoms (Nordin et al., *AJCN* 2022) | Calibrate the confidence of the app's language accordingly |
| Diary-based temporal association studies do find real signals — coffee, alcohol and artificial sweeteners among them (Clevers et al., *Dig Dis Sci* 2024) | Independent support for the method the app already uses |
| **NIAS item 8** asks whether the respondent restricts themselves to certain foods for fear that others will cause GI discomfort | The app's core output — a food labelled "Avoid" — is phrased as a screening symptom |
| During a flare, pain, bloating and urgency drown out hunger and fullness cues; IBS involves heightened visceral sensitivity, and body mistrust mediates interoceptive awareness → ED symptoms | "Just listen to your body" is not actionable when interoception is the broken part. Also the argument *for* the app: external gated evidence is a scaffold |

### 3a. Avoidance may be maintaining the symptoms

This is the finding that upgrades the "Avoid" label from psychologically unkind to
**possibly symptom-worsening**, so it gets its own heading.

From the exclude-or-expose review and the exposure-CBT literature behind it:

- Low-FODMAP has demonstrated efficacy, but carries adherence problems, nutritional
  compromise, and **heightened gastrointestinal-specific anxiety**.
- Exposure-based CBT also has demonstrated efficacy, with substantial evidence that
  **GI-specific anxiety is its mechanism of action**.
- A dismantling study (Ljótsson and colleagues) found the effect runs through
  GI-anxiety-specific processes rather than generic ones, with **IBS-specific behavioural
  avoidance the clearest mediator**.
- Most striking: **mediation analysis showed that *increased* FODMAP intake mediated
  *decreased* symptom severity** under exposure-based CBT.

Read that against the Foods tab. Eating more of the suspect food is, in one evidence-based
treatment arm, part of how people improve. A permanent red "Avoid" label is not a neutral
readout of the data — it is an intervention in the opposite direction, delivered without
consent and without a stopping rule.

**The caveat has to be held honestly:** none of this means food triggers aren't real, and it
does not license talking anyone out of a genuine intolerance. Both arms work, and the
review's own conclusion is that we don't know who belongs in which. Which is precisely why
the app must not silently pick a lane on the user's behalf.

### 3b. The nocebo problem — a limit on the whole method

Unblinded self-tracking cannot separate a food effect from an expectancy effect. This is a
structural limit on SnapGut and on any food diary, however the analysis is done:

- In double-blind placebo-controlled gluten challenges, only **16% of self-identified
  non-coeliac gluten sensitivity patients showed gluten-specific symptoms, while 40% had a
  nocebo response** — similar or worse symptoms on placebo.
- A 2024 double-blind study in IBS patients with perceived gluten sensitivity found
  **similar proportions reacting to wheat, to gluten, and to nocebo challenge**.
- Nocebo in food challenge is now studied directly (Elsenbruch group, 2025), and multi-food
  adverse reaction in IBS tracks with psychological distress and perceived stress.

The consequence is uncomfortable and worth writing down: **once the app tells someone a food
is a trigger, their belief can generate the symptom that confirms the label.** The loop
closes on itself, and the app's own follow-rate statistics will look like vindication. The
evidence gates in `src/foodScores.ts` protect against noise; they cannot protect against
expectancy.

What follows from it:

- Never present a rank as a settled fact about the food.
- A re-test is more informative when the user isn't primed. Ideally the food under test is
  not named in advance; at minimum, don't restate the old verdict while asking someone to
  try it again.
- Exoneration deserves *more* interface weight than accusation, because accusation
  self-reinforces and exoneration doesn't.

## 4. The combination is standard of care

Doing both jobs is not a novel bet. GI dietitians do both, which is why the **AGA GI Patient
Center** publishes an intuitive-eating page for GI conditions, reviewed by a Disordered
Eating in GI workgroup. Their framing is already the hybrid: strict diets can reduce
symptoms but carry side effects like any medication, a known trigger food can still be worth
eating sometimes, and finding a better-tolerated version beats dropping a food. A good
practitioner walks you through finding your actual triggers — and is visibly eager to give
you your diet back.

Their GI translation of the ten principles, and what each implies for the code:

| Principle (GI-adapted) | Implication |
| --- | --- |
| Reject the diet mentality | Elimination must expire; no permanent protocol |
| Honor your hunger | Capture hunger; don't let fear of symptoms drive skipped meals |
| Make peace with food | Ranks describe, they don't command |
| Challenge the food police | Show confidence and method; be a trusted source, not an oracle |
| Discover the satisfaction factor | Suggest better-tolerated swaps, not subtraction |
| Feel your fullness | Capture fullness — under-eating then overeating worsens GI symptoms |
| Cope with your emotions with kindness | Handle food-focused events; no guilt mechanics |
| Respect your body | No weight, no scale, no body metrics. Ever |
| Movement | Out of scope |
| Gentle nutrition | Frame nutrients as *adequacy*, never as limits |

---

## 5. Where the code currently works against this

Audited against the code, not the intent. Line references were accurate at the last audit;
re-read before acting on any of them.

### Measurement is negative-only

`src/symptoms.ts` ships **3 positive chips against 25 negative**, and the source comment
(`// Positive — so logging isn't all-negative`) reads like it knows. The filter

```ts
const isNegative = (id: string) => getSymptom(id)?.category !== "Positive";
```

appears in both `src/insights.ts` and `src/mealOutcome.ts`, and `src/foodScores.ts`
inherits it by consuming `classifyMeals`. So positives are excluded from **every** analysis
path. Logging "Feeling great" after a meal contributes nothing to that food's rank and
nothing to any insight. **The app cannot currently represent a good experience at all** —
the only evidence a food can offer in its own defence is silence. Severity chips
(Mild/Moderate/Severe) also apply to positive chips, which reads oddly.

The fix is *not* a mirror-image positive score. See section 6, which is the design worth
getting right before anyone writes code.

### "Avoid" is a one-way ratchet, statistically as well as psychologically

`RANK_META` in `src/foodScores.ts` labels the worst rank `"Avoid"` in `#c0392b`. It is
prescriptive, identity-level and permanent. Once a food is labelled Avoid the user stops
eating it, `eaten` stops incrementing, and the counter-evidence that could exonerate it
never arrives. The rank freezes.

Co-occurrence makes it worse: two foods that always appear together cannot be separated
until one is eaten alone, and the UI actively discourages the exposure needed to resolve
that. **The label degrades the data quality and the user's diet at the same time**, and per
section 3a may also reinforce the avoidance that mediates symptom severity. This is the
central finding of this document.

### Four further properties of the scoring code

Read in full, `computeFoodScores` is deliberately conservative — `avoid` requires
`withSymptom >= 3`, `foodRate >= 0.6` and `lift >= 1.6` against a baseline of at least 3
meals without the food. It still has four properties worth naming:

1. **"Agrees with you" is awarded on silence, with no baseline-reliability requirement.**
   In `rankFor`, the `baselineReliable` guard wraps only the `avoid` and `reduce` branches.
   The `agrees` branch (`foodRate <= 0.25 && lift <= 0.9`) runs regardless. So the app's
   most reassuring label has the weakest evidence standard behind it, and rests entirely on
   nothing having been logged. This is the natural hook for section 6.
2. **A single symptom implicates up to a day of ingredients.** A meal counts as followed if
   *any* negative symptom appears in the 24 h window (`LAG_WINDOW_MS` in
   `src/mealOutcome.ts`). At roughly three meals a day, one bad evening marks three meals
   and every confident ingredient in them. Baseline inflates too, so `lift` partially
   absorbs it, but per-ingredient attribution is much coarser than the displayed percentage
   implies.
3. **Severity is captured and then ignored.** `SEV_SCORE` lives in `src/insights.ts` and
   only feeds `avgSeverity` for display. `src/foodScores.ts` doesn't import it, so a mild
   burp and severe cramping count identically toward "Avoid".
4. **"Reduce" is reachable on very little.** Four exposures with two symptom-follows gives
   `foodRate` 0.5 at `lift >= 1.25` → `reduce`. That is a directive to eat less of something
   on the strength of two coincidences. The `avoid` gates are genuinely strict; `reduce` is
   not, and it is the label most users will accumulate most of.

### The AI paths mostly terminate in restriction

`FOCUS_PROMPTS` in `server/app.js` has five modules. Three of them propose a dietary or
timing change — isolate a single FODMAP group, try a short low-histamine trial, shift the
largest meal earlier. The remaining two (`gut-brain`, `insufficient-data`) point away from
food or ask for more logging. There is **no reintroduction module, no re-expansion module,
and nothing that fires when someone is avoiding too much.** `BASE_INSIGHT_PROMPT` does carry
a red-flag path for medical danger and does ask for one concrete next step at a time, but it
says nothing about restriction distress. The routing architecture is right; the routing
table is missing destinations.

### Cumulative restriction is untracked

"Diet stacking" is the term Melton et al. (*JGH Open*, 2025) use for the accumulation of two
or more concurrent dietary strategies — low-FODMAP on top of gluten-free on top of
vegetarian — usually without professional oversight, with compounding risk of nutritional
inadequacy.

Now read `route()` in `src/insights.ts` against that. It can send the same user to
`histamine-suspect` one week and `fodmap-suspect` the next; histamine is checked first, and
`fodmap-suspect` fires whenever `associations.length > 0`, a low bar given associations only
need `count >= 2`. Each corresponding prompt proposes its own trial. `meal-timing` adds a
fourth rule.

**Nothing in the codebase tracks cumulative restriction.** There is no count of active or
suggested eliminations, no memory of what was suggested last time, and no state that would
let the app notice it has now recommended three overlapping regimes. Each suggestion is
individually defensible; the sequence is a stacking machine.

Cheapest fixes first: persist what the router has already suggested and never open a second
elimination while a first is unresolved; add cumulative restriction to the evidence summary
so the model can see the total rather than the latest signal; and instruct
`BASE_INSIGHT_PROMPT` to propose *resolving* the open experiment instead of starting
another.

### Smaller items

- **No hunger, fullness, portion or satisfaction capture anywhere.** The nearest thing is
  the `early_full` symptom, which is *pathologised* as Upper GI.
- `src/moods.ts` is dead code — imported nowhere, and it contains
  `{ label: "Guilty", emoji: "😬" }`.
- `CheckinEvent.sleep` is captured and stored but never read by the stats engine.

### Credit where due

The streak mechanic is already well-behaved: `src/HeaderStats.tsx` only shows it at ≥2 days,
it deliberately doesn't break for an unlogged today, and its copy frames consistency as
*data quality* rather than virtue. There are no goals, badges, scores or logging reminders.
That is close to the right answer already — don't regress it.

## 6. Where positive signal attaches

The obvious reading of section 5 is "let positives earn credit for a food". That is wrong,
and building it would make the engine worse. Three things to get straight first.

**The meal is the unit of observation.** Scoring already works this way: a symptom event
attributes back to meals inside the 24 h lag window, each ingredient inherits its meal's
outcome, and a food's rate is `meals-followed-by-symptom / times-eaten`, compared against
the baseline for meals without it. You never observe "onion" — you observe a meal containing
onion. **Any positive signal therefore attaches to the meal event and can only reach food
level by aggregation.**

**A symmetric positive score would double-count.** The model already counts good outcomes,
as the absence of negatives: a meal with a quiet window is what earns "Agrees with you". Add
credit for an explicit "Comfortable" log on top and the same underlying fact is rewarded
twice, with the bonus going to whoever logs most diligently.

**The missing-data asymmetry is severe.** Negatives are salient — people log bloating
because it is notable. Feeling fine is unremarkable, so positives get logged sporadically
and non-randomly. Absence of a positive log means almost nothing; absence of a negative log
means something. A parallel positive rate would largely measure conscientiousness and then
present it as physiology.

**So positives raise confidence; they don't move the rate.** What an explicit positive
genuinely adds is **disambiguating a confirmed-clean window from an unlogged one**. Today a
quiet 24 h could mean the user felt fine or put the phone down, and the engine cannot tell.
A positive log settles it. That belongs in confidence and exposure gating — making "Agrees
with you" better *evidenced* — not in the numerator.

This is cleanly implementable. `FoodScore.confidence` is derived *solely* from settled
exposure count (`scored >= 8` high, `>= 5` medium, else low) and is not an input to
`rankFor`. So a confirmed-clean count can be threaded into the confidence term without
touching `foodRate`, `baselineRate` or `lift` at all. And since the `agrees` branch has no
baseline-reliability guard, requiring some confirmed-clean windows before awarding "Agrees
with you" is the natural place to spend this signal — it tightens the weakest evidence
standard in the file rather than loosening anything.

### Three signals, three destinations

| Signal | Example | Attaches to | Effect on food scores |
| --- | --- | --- | --- |
| **Subsequent wellbeing** — mirror of symptom logging, lives in the lag window | "Comfortable" 3 h after eating | Meal, via lag window | Confirms a clean window → **raises confidence**, does not lower the rate |
| **Meal-intrinsic experience** — a property of the eating occasion, not of any ingredient | Satisfied, comfortably full, ate calmly | Meal, permanently | **Never propagates to ingredients.** A covariate, like `lateNightSymptomRate` |
| **Deliberate re-test outcome** | Re-tested onion alone, fine | The food under test | **Legitimately updates that food's rank** |

The middle row is what prevents bad conclusions. A satisfying, well-portioned plate of pasta
is information about portion and context, not about wheat. Aggregating it into ingredient
scores would be actively misleading; keeping it as a meal covariate is what lets the engine
say *"this reads as portion, not the garlic."*

The bottom row is the one clean carve-out. A re-test is a deliberate single-variable
experiment with a stated hypothesis and low confounding, so a good outcome there really is
evidence about that food. It is also the **only** mechanism that can positively exonerate a
food rather than merely failing to convict it, which is the argument for building it early.

**UI consequence:** the three positive chips currently sit in the symptom picker under
"How's your gut?", which conflates the first two rows. Comfort-at-the-meal belongs on the
meal flow as a post-meal tap; only subsequent wellbeing belongs with symptoms. Splitting
them is a prerequisite for the table above, not a polish item.

## 7. Why this improves the trigger detection

The point worth internalising: **this data is a missing confounder, not a wellness veneer.**

Today, if someone eats a large meal, late, ravenous after skipping lunch, and gets bloated,
the engine attributes it to whatever ingredient was in the bowl. Volume, eating speed and
eating past comfortable fullness are all mechanistically plausible drivers of bloating and
reflux *independent of food composition*, and none of them are captured. Late-night eating
is already modelled as a confounder (`lateNightSymptomRate` in `src/insights.ts`), so the
pattern is established.

A pre-meal hunger tap and a post-meal comfort tap would serve the principles in section 4
**and** give the correlation engine two new covariates, plus a mechanism for exonerating a
food. Better analysis, not just a kinder tone.

It also aligns with the protocol rather than fighting it.
[fodmap-program.md](fodmap-program.md) notes that reintroduction is the phase that produces
the evidence and the one most often skipped, that low-FODMAP is time-limited by design, and
that clinical practice targets the least restrictive diet that controls symptoms. So the
kinder goal and the clinically correct goal are the same goal: **get foods back.** Framing
the deliverable as a re-expansion list rather than an avoid-list is faithful to both.

## 8. The tension to name out loud

A guided multi-week protocol keeps someone in elimination longer, and elimination is the
phase carrying the nutrient and microbiome risk, and the phase whose adherence correlates
with disordered-eating behaviour. Any design that treats time-in-app as a success signal
will push in exactly the wrong direction here.

So, decided in advance, while there is no phase model to argue with:

- Elimination **hard-expires** in the state machine — a ceiling in weeks, with the app
  pushing the user out rather than waiting for them to leave.
- The success event is the **personalisation report**, not days logged.

## 9. Design rules

1. Ranks **describe**, never command. Keep the statistics; drop the imperative verb.
2. Positive experience is **load-bearing**, not decoration — but it raises *confidence*, it
   does not create a mirror-image score (section 6).
3. Every restriction has an **expiry** and a re-test path.
4. Investigation has an entry reason, an exit condition and a deliverable.
5. Confounders before culprits — portion, timing, hunger, stress and sleep get considered
   before an ingredient is blamed.
6. No quantification of the body. No weight, BMI, calories or macros.
7. Screen and refer; never treat.
8. Permission framing arrives **after** investigation, never instead of it.
9. **One open experiment at a time.** Never suggest a second elimination while a first is
   unresolved.
10. **Don't pick a lane for the user.** Exclusion and exposure both work and nobody knows
    who belongs in which (section 3a) — so offer, explain, and let them choose rather than
    routing silently.
11. **Treat expectancy as a confound, not a nuisance.** Ranks are provisional, exoneration
    outranks accusation, and re-tests avoid re-priming the old verdict (section 3b).

## 10. Known gaps between these rules and the code

Open design work, not commitments.

- [ ] **Make positive experience count — per section 6, not as a positive score.** Split the
      taxonomy (meal-intrinsic comfort → meal flow; subsequent wellbeing → symptom flow),
      expand beyond three options, drop severity from positives, and wire confirmed-clean
      windows into the **confidence** term in `src/foodScores.ts` rather than the rate.
      **Do not** simply invert `isNegative` and add credit — that is the double-counting
      version.
- [ ] **Reword `RANK_META` to be descriptive.** "Avoid" → e.g. "Often followed by symptoms".
      Five strings in one file. The gating logic is genuinely rigorous; it is the verb and
      the red that do the damage.
- [ ] **Re-test path off every non-neutral food.** *"Haven't eaten this in 6 weeks — worth
      another try?"* Fixes the statistical dead-end and the dietary narrowing with one
      mechanic. Tolerance changes, and dose matters. Per section 6 this is the only
      mechanism that can positively exonerate a food.
- [ ] **Hunger-before and satisfaction-after on the meal flow.** Two optional taps in
      `MealDetails`. Meal-intrinsic per section 6: they enter the evidence summary as
      covariates beside `lateNightSymptomRate` and must not propagate to ingredient scores.
- [ ] **Over-restriction routing signal.** Compute weekly food variety, avoid-set size and
      time-since-last-eaten on-device. Route to a new `re-expansion` focus module when
      variety trends down or the avoid-set expands. Add restriction distress to the base
      prompt's red-flag handling.
- [ ] **Gate any elimination protocol behind a real screen** at program entry, where a
      time-limited therapeutic protocol justifies asking. NIAS is nine items, validated,
      with published cutoffs including work in GI settings. A positive screen routes to
      support resources and a gentler non-elimination path; it must not silently proceed and
      must not claim to diagnose.
- [ ] **Restrict any snap-time group heads-up** to active challenge and washout windows,
      where flagging confounders is scientifically necessary. A banner appraising every
      photographed meal is a food-police mechanic.
- [ ] **One-open-experiment guard.** Persist suggested eliminations; block the router and
      the prompt from opening a second while one is unresolved.
- [ ] **Weight `avoid` and `reduce` by severity.** `SEV_SCORE` already exists in
      `src/insights.ts` but `src/foodScores.ts` ignores it. Fewer foods would clear the bar,
      which is the point.
- [ ] **Tighten `reduce`.** Two symptom-follows out of four exposures currently earns a
      directive to eat less.
- [ ] Delete `src/moods.ts` — dead code containing a "Guilty" chip.
- [ ] Read `CheckinEvent.sleep` into the evidence summary — a captured confounder currently
      ignored.

## 11. Out of scope, deliberately

- ❌ **Calories, macros, weight, BMI, body metrics.** The motive research says this is the
  switch that turns a health tracker into a risk factor. If fibre and micronutrients ever
  arrive, frame them as *adequacy* — "are you getting enough, given what you've cut" — which
  is both the gentle-nutrition principle and the real clinical risk of low-FODMAP shortfall.
- ❌ **A curriculum, lesson deck or coach persona.** Different product.
- ❌ **An onboarding questionnaire.** The app promises no profile and no quiz, and a 23-item
  instrument is exactly the friction it is designed against. Derive what can be derived from
  *behaviour* — variety trend, avoid-set size and age, restriction duration — and only ask
  questions at a program gate. Behavioural inference is also more honest than self-report.
- ❌ **Any claim that intuitive eating relieves GI symptoms.** Not supported.
- ❌ **Any claim to treat, or to screen definitively for, an eating disorder.**
- ❌ **Guilt, shame or compliance mechanics** — no "you broke your diet", no adherence
  score, no red days.

## 12. How to tell whether any of this is real

If the app is doing what this document claims, these are the outcome measures:

- **Food variety per week** — trending up
- **Avoid-set size** — trending down
- **Concurrent restrictions** — capped at one
- **Time-to-exit from investigation** — getting shorter
- **Foods exonerated** (re-tested and cleared) — a count worth surfacing to the user

If a validated instrument is ever wanted instead of behavioural proxies, the right one is
the **Visceral Sensitivity Index** — 15 items, validated in IBS and extended to IBD, and it
measures **GI-specific anxiety**, which section 3a identifies as the mechanism through which
exposure-based CBT works. That makes it the mechanistically correct outcome measure for this
document's thesis, and it pairs cleanly with NIAS: **NIAS is the gate** (screen before a
restrictive protocol), **VSI is the dial** (is the product making food less frightening or
more). Both are short enough to survive the no-quiz constraint if used at a program boundary
rather than at onboarding.

All computable on-device, and all in tension with any measure that rewards time spent in the
app. Deciding which of these to report is more consequential than any individual item in
section 10.

**Known trade-off:** local-first storage is an asset here — food and body data carry shame,
and nothing leaves the device by default, which is *respect your body* implemented as
architecture. It also means the project cannot observe at population level whether these
mechanics reduce restriction. The psychology ships on faith. That is the right trade; make
it knowingly.

## 13. What the app may and may not say

| Claim | Verdict |
| --- | --- |
| "Patterns are compared against your own baseline before a food is flagged" | ✅ already true |
| "No calories, no weight, no body metrics" | ✅ true today — protect it |
| "Only one food experiment at a time" | ⚠️ true once the guard in section 10 ships |
| "We help you get foods back, not just take them away" | ⚠️ true once a re-test path ships |
| "Follows AGA-published intuitive-eating guidance for GI conditions" | ⚠️ defensible once section 10 lands |
| "Reduces food anxiety" | ⚠️ plausible per the literature; unverified for *this* app |
| "Intuitive eating improves your gut symptoms" | ❌ evidence doesn't support it |
| "Screens for / helps with eating disorders" | ❌ screen and refer, nothing more |
| "A safe replacement for a dietitian-supervised low-FODMAP diet" | ❌ never |
| "Confirms which foods you react to" | ❌ unblinded tracking can't separate food from expectancy (section 3b). Say *associations*, as the app already does |
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

_Code observations were audited against the repository, most recently while rewriting this
document: `src/foodScores.ts`, `src/insights.ts` and `src/mealOutcome.ts` for the `rankFor`
gates, the `confidence` derivation, the `isNegative` filter and the `route()` ordering;
`src/symptoms.ts` for the chip taxonomy; `src/moods.ts`, `src/triggerInfo.ts`,
`src/HeaderStats.tsx` and the insights route in `server/app.js` for the copy and prompt
claims. Re-audit before acting — the ✅ marks are only as good as the code they describe._
