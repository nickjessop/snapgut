# FODMAP grouping and the trigger-finding protocol

Why SnapGut groups foods the way it does, what the low-FODMAP protocol actually is, and
which parts of it the code implements.

**Who this is for:** contributors touching `src/fodmap.ts` (the group definitions and
ingredient tagging), `src/triggerInfo.ts` (the plain-language copy for each group),
`src/insights.ts` (the `fodmap-suspect` focus and the `route()` gates) or
`src/foodScores.ts` (the per-food evidence thresholds). Read
[intuitive-eating.md](intuitive-eating.md) alongside it — that document argues the limits
of the approach described here, and is the more important of the two if you are changing
how the app labels a food.

> **Not medical advice.** Low-FODMAP is a therapeutic, time-limited diet, best done with a
> dietitian. Nothing in the app diagnoses anything, and nothing here should be read as
> instructions to start an elimination diet. Restrictive protocols are actively
> inappropriate for people at risk of disordered eating — see the screening discussion in
> [intuitive-eating.md](intuitive-eating.md).

---

## Status: what ships today

Most of this document describes a protocol the app **does not run**. The distinction
matters, so here it is explicitly.

**Implemented:**

- **Trigger groups and ingredient tagging** — `src/fodmap.ts` defines the `TriggerGroup`
  union, `TRIGGER_LABELS` for display, and `IS_FODMAP` to mark which groups are FODMAPs
  (the union also carries non-FODMAP groups such as high-histamine). `tagsForIngredient`,
  `tagFood` and `tagFoods` map an ingredient onto its groups, using the food dictionary
  where an entry exists and a coarse keyword match otherwise.
- **Plain-language group reference** — `src/triggerInfo.ts` and `src/TriggerInfoSheet.tsx`
  explain each group in ordinary food terms, because "fructans" is a word most people meet
  for the first time in an app like this.
- **Group-level associations in insights** — `src/insights.ts` aggregates trigger groups
  over the event timeline and exposes a `fodmap-suspect` focus. `route()` selects it when
  a FODMAP group looks strong (`count >= 3 && symptomRate >= 0.5`) or when any association
  exists at all; high-histamine is tested first.
- **Per-food evidence gates** — `src/foodScores.ts` ranks individual foods against your
  own baseline (`MIN_EATEN = 4`, `MIN_SYMPTOM_FOLLOWS = 3`, `MIN_OTHER_MEALS = 3`,
  `AVOID_LIFT = 1.6`, `REDUCE_LIFT = 1.25`). This is food-level correlation, independent of
  any FODMAP phase.

**Not implemented.** There is no phase state machine and no `src/program.ts`. Nothing
schedules an elimination period, a reintroduction challenge, a dose escalation or a
washout; nothing records a per-challenge verdict; there is no personal tolerance report;
and there is no snap-time warning about what a photographed meal contains.

So the shipped behaviour is **passive observation**: you log meals and symptoms, and the
app reports associations, including at trigger-group level. Everything below the Status
section labelled *proposed* is design rationale for work that has not been done.

## The protocol, for context

Low-FODMAP (developed at Monash University) is the most evidence-backed dietary approach
for IBS. It is not a permanent diet — it is a **time-limited, three-phase experiment** to
identify an individual's triggers:

1. **Elimination (2–6 weeks).** Cut high-FODMAP foods so symptoms settle to a calm
   baseline. This phase carries the nutritional and microbiome risk, and its duration
   correlates with disordered-eating behaviour in IBS cohorts, which is why "time-limited"
   is load-bearing rather than a detail.
2. **Reintroduction (6–8 weeks).** Challenge **one subgroup at a time** with a standard
   test food in escalating doses over roughly three days, with a washout between
   challenges, logging symptoms throughout. This is the phase that produces the actual
   evidence, and the phase most often skipped or run in a way that yields nothing
   interpretable.
3. **Personalisation.** Keep only the triggers that held up, re-expand everything else.

The deliverable is a narrow, evidenced avoid-list and a return to variety — not a permanent
protocol. Clinical practice targets the least restrictive diet that controls symptoms.

### Subgroups and their standard test foods

| Subgroup | Representative test foods |
| --- | --- |
| Fructans | Wheat bread, garlic |
| GOS (galacto-oligosaccharides) | Chickpeas, almonds |
| Lactose | Milk, yogurt |
| Excess fructose | Honey, mango |
| Sorbitol | Avocado, blackberries |
| Mannitol | Mushrooms, cauliflower |

These are the groups `TRIGGER_LABELS` names. Subgroup-at-a-time challenge is the reason the
app tags at group level at all rather than treating every food as an independent suspect:
if fructans are the problem, wheat and garlic and onion are one finding, not three.

## Why grouping helps the analysis

The correlation engine measures meals, not molecules. A symptom event attributes back to
meals inside the 24-hour lag window (`LAG_WINDOW_MS` in `src/mealOutcome.ts`), and every
confident ingredient in those meals inherits the outcome. That makes single-ingredient
attribution noisy: foods that always appear together cannot be separated until one is eaten
alone.

Group tagging partly mitigates this. Onion, garlic, wheat and rye rarely all co-occur, but
they share a group, so evidence that is too thin per-ingredient can still be legible per
group. It is also the honest unit for the underlying biology — the small intestine does not
distinguish garlic fructans from wheat fructans.

The mitigation is partial and the tagging is coarse. Keyword matching has no portion
awareness, and FODMAP content is dose-dependent, so a trace of onion and a bowl of it tag
identically. `src/triggerInfo.ts` states this in the user-facing copy on purpose: the
editorial rule there is that every entry admits the tagging is approximate. Anything built
on top of these tags inherits that imprecision and must not sound more certain than it is.

## Proposed: how a guided protocol would map onto the app

Sketch only — none of this exists.

- **Phase state** per user (phase, current challenge, day N), persisted with events and
  carried by cloud sync like any other record.
- **Elimination:** a "what to avoid" guide plus a daily check-in; when the on-device symptom
  trend flattens, prompt to begin reintroductions. Accurate food-level FODMAP data is the
  blocking dependency here — Monash's dataset is the reference standard and is licensed,
  open lists vary in quality, and the current keyword tagging is too coarse to tell someone
  what to eat.
- **Reintroduction:** schedule challenges (subgroup → test food → escalating doses across
  three days, washouts between). Each challenge is tagged events on the existing timeline,
  and the existing lag-window and severity machinery yields a per-challenge verdict:
  tolerated, dose-limited, or reactive.
- **Personalisation:** compile the verdicts into a personal tolerance report and enrich the
  Foods tab with it.

The reason this maps cleanly is that a reintroduction challenge is just a structured
single-subject experiment measured by symptom logging, which is what the event timeline,
group tagging and lag-window correlation already compute. The new work is the phase model
and the scheduling, not the analysis.

### Constraints any such implementation has to respect

These come out of [intuitive-eating.md](intuitive-eating.md) and are not optional garnish:

- **Elimination must hard-expire in the state machine** — a ceiling in weeks, with the app
  pushing the user out rather than waiting for them to leave. The success condition is the
  personalisation report, not time spent in the app.
- **Screen before entry, not at onboarding.** A time-limited restrictive protocol is the
  point at which asking screening questions is justified; a positive screen must route to a
  gentler non-elimination path and to support resources, and must not claim to diagnose.
- **One open experiment at a time.** Nothing in the codebase currently tracks cumulative
  restriction, and `route()` can suggest overlapping regimes in consecutive weeks.
- **Opt-in.** Passive tracking stays the default. Low-FODMAP helps roughly 50–70% of IBS
  patients, so a third to a half do not respond, and predicting who is an open research
  question. The router must not funnel everyone toward it.

### Proposed: snap-time group heads-up

The recognition result already returns confident and maybe ingredients, and those
ingredients are already tagged, so the app could flag matching groups on the meal detail
screen when a group is under active avoidance.

Recorded here with its objection attached: a banner appraising every photographed meal is a
food-police mechanic, and `intuitive-eating.md` argues it should be restricted to active
challenge and washout windows, where flagging a *confounding* group is scientifically
necessary rather than merely disciplinary. If it is ever built: never block the log, frame
group membership as likely rather than certain given the coarse tagging, and let the user
dismiss it.

## Open risks

- **Data quality.** Elimination guidance needs portion-aware food-level FODMAP data the
  project does not have.
- **Coarse tagging.** Keyword matching over-tags and under-tags; see above.
- **Adherence and drop-off** over a multi-week protocol, without turning reminders into
  nagging.
- **Restrictive-protocol risk** for a user population in which avoidant eating is common
  rather than exceptional.
- **Expectancy.** Unblinded self-tracking cannot separate a food effect from the belief
  that a food is a problem. This limits any conclusion the app draws, protocol or not —
  see the nocebo section of [intuitive-eating.md](intuitive-eating.md).

## If it were built

The smallest version that would produce something trustworthy is **reintroduction only**:
it carries the evidential value, and it needs just a small curated set of standard test
foods per subgroup rather than a complete food database. A plain elimination checklist could
serve as a lead-in without pretending to be food-level guidance.

Sketch of the work: a client-side phase and challenge model with verdict logic over
existing events; a program card and daily-task surface; a per-subgroup test-food catalogue
extending `src/fodmap.ts`; a tolerance report screen; and persistence of program state
alongside the rest of the local-first store.
