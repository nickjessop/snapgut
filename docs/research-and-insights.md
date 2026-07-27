# Research & Insights Design

Evidence base and product design for symptom tracking + the AI Insights tab.
Everything here is framed around **surfacing patterns**, never diagnosing.

> ⚠️ Non-diagnostic by design. This app helps users spot personal food/symptom
> patterns and bring better questions to a clinician. It does not diagnose, treat,
> or provide medical advice. This is both an ethical line and a regulatory one
> (diagnostic claims invoke medical-device rules and app-store restrictions).
> Reference framing used by mySymptoms: "help you identify personal wellness
> patterns, not to provide medical advice or diagnosis."

---

## 1. Landscape — what the good apps do

| App | Core model | Notable |
| --- | --- | --- |
| **Monash FODMAP** | Traffic-light food DB + diary + guided reintroduction | The clinical reference; 3-phase protocol; records food, IBS symptoms, bowel habits, stress. |
| **Cara Care** | Food/symptom/stool/stress tracking + "best vs worst days" | Personalized, evidence-based positioning. |
| **mySymptoms** | Food + symptom diary + correlation analysis | ~900k users; explicitly *pattern-finding, not diagnosis*; export journals for clinicians. |
| **Bowelle** | Fast, visual food & symptom diary | Emphasis on speed + beautiful pattern visualizations. |
| **Cronometer / MyFitnessPal** | Nutrient tracking (macros + micros), barcode | Cronometer = accurate micronutrients (USDA-sourced); MFP = huge but user-submitted DB. |
| **Nerva / Mahana** | Gut-brain hypnotherapy / CBT | Mahana is FDA-authorized prescription app for IBS. Different lane (therapy, not tracking). |

**Takeaways for us**
- Real GI symptoms + severity + bowel movements (Bristol scale) + stress — not moods.
- Speed of logging is a core differentiator (Bowelle, our BeReal/Gas angle).
- Correlation/insights is the payoff; "best vs worst days" is a proven framing.
- Our wedge: **photo-first capture + AI food recognition + AI-narrated insights.**

## 2. Symptoms — the taxonomy (replaces "moods")

Grounded in IBS/SIBO/FODMAP/histamine literature. Grouped for a horizontal,
searchable picker. Each logged symptom carries a **severity** (Mild/Moderate/Severe)
and a **timestamp** (symptoms are often *delayed*, so they're not tied to the meal moment).

- **Gas & bloating:** Bloating, Gassy / flatulence, Distension (visibly swollen), Belching
- **Pain:** Cramping, Sharp / stabbing pain, Dull ache, Lower-abdominal pain, Upper-abdominal pain
- **Upper GI:** Nausea, Reflux / heartburn, Early fullness, Regurgitation
- **Bowel:** Diarrhea, Constipation, Urgency, Incomplete evacuation, Mucus in stool
- **Systemic (histamine / gut-brain overlap):** Fatigue / sluggish, Brain fog, Headache,
  Skin flare / itch, Flushing, Palpitations, Joint pain
- **Positive:** Feeling great, Comfortable, Energized  (so logging isn't all-negative)

**Bowel movements** additionally use the **Bristol Stool Scale (types 1–7)** — the
clinical standard, and the axis IBS-C / IBS-D / IBS-M is defined on.

Severity model: keep it a simple 3-point (Mild/Moderate/Severe). Clinical scales
(IBS-SSS 0–100 VAS, GSRS) exist but are overkill for one-tap capture; we can map
our 3-point scale onto them later for clinician export.

## 3. Timing & lag — the thing most simple trackers get wrong

- GI symptoms frequently appear **30 min – 48 h** after the trigger food, not immediately.
- Classic diary-analysis produces "suspect food components for each symptom ...
  with lag times between ingestion and symptom change."
- Late-evening / night caloric intake predicts next-day bloating (meta-analysis).

**Implication for data model:** meals and symptoms are timestamped events that can be
logged separately. Insights correlate over **configurable lag windows** rather than
assuming meal → immediate reaction.

## 4. FODMAP model — the backbone of insights

FODMAP groups + representative trigger foods (used to tag logged foods):

- **Fructans (oligos):** wheat, rye, onion, garlic, leek, asparagus
- **GOS / galacto-oligosaccharides:** legumes, chickpeas, lentils, cashews, pistachios
- **Lactose:** milk, soft cheese, yogurt, ice cream, custard
- **Excess fructose:** apple, pear, mango, watermelon, honey, high-fructose corn syrup
- **Polyols:** stone fruit (apricot, peach, plum), avocado, mushroom, cauliflower, sorbitol/mannitol/xylitol

**Non-FODMAP triggers worth tagging too:** caffeine, alcohol, high-fat / fried,
spicy, carbonation, artificial sweeteners, high-histamine (aged/fermented/cured).

Monash uses a **red/amber/green** portion-aware system — dose matters (10 g vs 200 g).
We start with coarse keyword tagging (client-side), then can upgrade to AI-returned
FODMAP tags per food in the recognition call (nearly free on Flash-Lite).

### The 3-phase protocol (future guided mode)
1. **Elimination** — low-FODMAP 2–6 weeks until symptoms settle.
2. **Reintroduction** — test one FODMAP group at a time, 3–4 days each, watch symptoms.
3. **Personalization** — long-term diet keeping only the triggers that matter.

This is where a self-experiment / n-of-1 feature ("TummyTrials"-style) lives.

## 5. Insights engine — architecture

**Principle:** do the statistics on-device, feed a compact *evidence summary* to the
model, and let the model narrate it. This keeps cost low, grounds the output in the
user's real data, and avoids sending raw logs to the LLM.

```
on-device (insights.ts)
  → aggregate: top foods, top symptoms, symptom-heavy vs symptom-free days
  → candidate food→symptom associations within lag windows
  → FODMAP-group load vs symptom days
  → meal-timing signal (late-night eating vs next-day symptoms)
  → produce a compact JSON "evidence summary" + a routing signal
        │
server (/api/insights)
  → BASE prompt (evidence-based gut-health analyst, non-diagnostic)
  + ROUTED module prompt chosen from the signal:
        - fodmap-suspect      (symptoms track high-FODMAP load)
        - histamine-suspect   (systemic symptoms + high-histamine foods)
        - meal-timing         (late-night eating pattern)
        - gut-brain / stress  (symptoms without clear food pattern)
        - insufficient-data   (not enough logs yet — encourage logging)
  → Gemini Flash-Lite → narrative: patterns, the science, what to try next
```

### Prompt strategy (layered)
- **Base system prompt:** persona = careful, evidence-based gut-health analyst.
  Rules: describe *associations not causation*; cite general mechanisms (FODMAP,
  gut-brain, histamine, meal timing); never diagnose or name a disease as the user's
  condition; recommend discussing persistent/severe symptoms with a clinician;
  flag red-flag symptoms (blood, weight loss, night pain) with "see a doctor."
- **Routed modules:** each adds domain-specific framing + the relevant self-experiment
  (e.g., fodmap module suggests a structured single-group reintroduction test).
- **Grounding:** the model only interprets the on-device evidence summary; it must
  not invent numbers.

### Red-flag safety list (always surfaced, never softened)
Blood in stool, unintended weight loss, persistent night-time symptoms, fever,
difficulty swallowing, anemia, new symptoms over age 50 → "please see a doctor."

## 6. Roadmap / what we're missing (backlog)

- [x] Redesign symptom capture: searchable horizontal picker + severity
- [x] Timestamped, meal-independent symptom logging (event model + timeline)
- [x] FODMAP tagging of foods (client keyword → later AI-returned tags)
- [x] Bristol Stool Scale for bowel movements (own log type)
- [x] Lag-window correlation (symptoms linked to meals in prior 24h)
- [x] Backdating events (WhenPicker) for accurate timelines
- [x] Stress / sleep quick input (gut-brain axis) — check-in event type
- [x] Insights tab: on-device stats + layered AI narration
- [x] Edit / delete any timeline event
- [x] Camera-as-home (snap-first default view)
- [ ] "Best vs worst days" view
- [ ] Guided 3-phase FODMAP mode (elimination → reintroduction → personalization)
- [ ] n-of-1 self-experiment ("test this trigger") flow
- [ ] Clinician export (structured PDF/CSV with severity + Bristol + timeline)
- [ ] Nutrient/fiber angle (low-FODMAP deficiency risk) — Cronometer-style, later
- [ ] Portion-aware FODMAP (dose matters) — Monash red/amber/green

## 6b. Food database + images (off-the-shelf research)

Goal: thumbnails per food for the intolerance-ranking tab, and a path to nutrition
enrichment later. Options evaluated:

| Source | Key? | Cost | Images | Notes |
| --- | --- | --- | --- | --- |
| **TheMealDB** ingredient CDN | No (images) | Free | ✅ static per-ingredient | `…/images/ingredients/{Name}.png` (+`-small/-medium/-large`). ~600 ingredients; unknowns 404. $10 lifetime supporter needed for the JSON *API* before public app-store release, but the images are just static files. **Chosen for now.** |
| **Open Food Facts** | No | Free (ODbL data, CC-BY-SA images) | ✅ product photos | 2.9M+ products, biggest open DB. Product/barcode-centric. **Recommended for future nutrition + branded-product enrichment.** |
| **Spoonacular** | Yes | Free 150/day, then paid points | ✅ ingredient CDN + ontology | Best ingredient ontology (`ingredients_100x100/…`). Good upgrade if we need structured ingredient data. |
| **USDA FoodData Central** | Yes | Free | ❌ | Authoritative nutrition, no images. |
| **Edamam / Nutritionix / FatSecret** | Yes | Freemium | partial | Solid nutrition; keys + limits. |

**Decision:** TheMealDB static images now (zero key, zero cost) with a generated
letter-avatar fallback for misses. Open Food Facts is the enrichment path when we
add nutrition/fiber and branded-product lookups.

## 6c. Food intolerance ranking (Foods tab)

Per-ingredient version of the lag-window correlation: for each confident
ingredient, `symptomRate = meals-followed-by-symptom-within-24h / times-eaten`.
Ranks (need ≥3 exposures first):
- **Avoid** ≥ 60% · **Reduce** 35–60% · **Neutral** 20–35% · **Agrees with you** ≤ 20%
- **Need more data** if eaten < 3

**Baseline-relative attribution (v2):** instead of raw follow-rate, each food is
compared against your personal baseline — the symptom-follow rate for meals that
*don't* contain it — via a lift ratio (`foodRate / baselineRate`). This:
- down-weights foods you often eat *without* symptoms (they lower their own rate), and
- won't flag a food whose rate merely matches your overall average (lift ≈ 1 → Neutral).

Gates before "Avoid": eaten ≥ 4, symptom-follows ≥ 3, foodRate ≥ 60%, lift ≥ 1.6×,
and ≥ 3 comparison meals without the food (so a food present in nearly every meal
can't be blamed — it stays Neutral). "Reduce" is a softer version; "Agrees" needs a
low rate at/below baseline. Confidence (low/med/high) scales with exposure count.

Caveat that remains (by design): two foods that *always* co-occur can't be told
apart until you eat one without the other. Framed as "patterns," gated, never an
allergy test.

## 7. Sources

- Monash FODMAP app — https://www.monash.edu/monash-innovation/impact/licensing/low-fodmap
- Cara Care — https://cara.care/en
- mySymptoms (framing) — https://play.google.com/store/apps/details?id=com.sglabs.mysymptoms
- Bowelle — http://www.bowelle.com/
- Low-FODMAP 3-phase — https://www.cedars-sinai.org/health-topics/eating-a-low-fodmap-diet-for-ibs
- 3-phase implementation — https://pmc.ncbi.nlm.nih.gov/articles/PMC9274476/
- FODMAP food lists — https://communityhealth.mayoclinic.org/featured-stories/fodmap-diet
- Diary lag-time analysis — https://pubmed.ncbi.nlm.nih.gov/7870442/
- Meal timing & bloating — https://pubmed.ncbi.nlm.nih.gov/32031756/
- Food–symptom associations (mySymptoms data) — https://pubmed.ncbi.nlm.nih.gov/31428421/
- Bristol scale / IBS subtypes — https://pmc.ncbi.nlm.nih.gov/articles/PMC3855407/
- SIBO symptoms & breath-test limits (Mayo) — https://www.mayoclinic.org/medical-professionals/digestive-diseases/news/an-updated-appraisal-of-the-sibo-hypothesis-and-the-limits-of-breath-testing/mac-20574581
- Histamine intolerance review — https://pmc.ncbi.nlm.nih.gov/articles/PMC7463562/
- Low-FODMAP nutrient risk — https://www.va.gov/WHOLEHEALTHLIBRARY/docs/The-Low-FODMaP-Diet.pdf
- Cronometer vs MyFitnessPal accuracy — https://www.welling.ai/articles/myfitnesspal-vs-cronometer-2026
- TheMealDB API + ingredient images — https://www.themealdb.com/api.php
- Open Food Facts API — https://openfoodfacts.github.io/openfoodfacts-server/api/
- Open Food Facts image dataset/license — https://blog.openfoodfacts.org/en/news/open-food-facts-images-on-aws-open-dataset-the-ultimate-food-image-database
- Spoonacular food API — https://spoonacular.com/food-api

_Content synthesized and rephrased from the above sources for licensing compliance._
