# Positioning — SnapGut

The story we tell, the claims we can defend, and the work required to make the whole
promise true. Companion to `docs/competitor-analysis.md`.

---

## Positioning statement

> **The fast food diary that does the statistics properly, and then walks you through
> finding your actual triggers.**

Deliberately *not* "AI gut scanner." That lane is commoditized — meal photo recognition
is a $0.0002 API call and a dozen apps ship a 0–100 "gut score" with no visible method.
Our claim is rigor and respect, not magic.

## Three pillars

### 1. Fast — logging takes seconds, not minutes
Camera is the home screen. Snap, AI pulls the ingredients, one tap for how you feel.
The apps with real analytical depth (mySymptoms, Monash) make you search and type every
food, and adherence is the whole ballgame in a multi-week protocol.

### 2. Honest — we won't call a food a trigger until the data earns it
Every food is compared against *your own baseline* — the symptom rate for meals without
it — as a lift ratio. Before anything is labelled "Avoid" it needs ≥4 exposures, ≥3
symptom-follows, ≥60% follow rate, ≥1.6× lift, and ≥3 comparison meals without the food.
Confidence is shown, not hidden. Lag windows span 30 min–48 h because that's how GI
symptoms actually behave.

### 3. Non-intrusive — your data, your device, your choice
The differentiating pillar, and the one the category ignores. Everything else in this
market ships your bowel data to someone's server as a precondition of use.

- **Start logging without an account.** *(needs building — see below)*
- **We ask for an email, and that's it.** No name, age, gender, weight, or onboarding
  quiz. The server record is literally `{ email, pro, proUntil, freeAiUsed,
  stripeCustomerId, createdAt }`.
- **Your log lives on your device** in IndexedDB, and it stays there.
- **You choose where it syncs:** local-only (default), your own Google Sheet, or our
  cloud *(cloud not built)*. Opt in, switch, or opt out at any time.
- **Free forever for logging.** Manual logging, on-device stats, food ranking, and
  export are never paywalled. Pro buys AI, not access to your own history.
- **Export and leave whenever you want.** CSV and JSON, free, no ceremony.

### 4. Nothing to install — it's just a link
Reinforces every other pillar. Competitors ask for a download, a store account, and a
subscription before you learn whether the thing helps.

- **Try it in seconds.** Open a URL. No download, no App Store account, no 100 MB app.
- **Runs anywhere from one URL** — iOS, Android, desktop.
- **Add to Home Screen and it behaves like an app** — full screen, own icon, opens
  straight to the camera.
- **Updates itself.** No "update available" nags, no version fragmentation.
- **Privacy consistency.** Nothing installed means no device permissions beyond the
  camera, no app-store identity, no SDK grab-bag of third-party analytics.
- **It funds the pricing.** No 15–30% platform cut is a big part of why free logging
  forever and a $79.99 lifetime tier are sustainable.

**Native iOS and Android are planned**, mainly for discovery and notification
reliability. When they ship, the web app stays the canonical instant-try path — native
becomes an additional door, not a replacement. Framing stays *"works everywhere,
install only if you want to,"* never *"we couldn't ship a real app."*

The honest trade-off, kept in view: no store presence costs us discovery in a market
where competitors buy installs, store listings carry trust we have to earn another way,
and iOS web push requires the user to add the app to their home screen first. See
`docs/competitor-analysis.md` for the distribution gap in full.

---

## Claims we can defend today

Verified against the code, not the marketing instinct.

| Claim | Status | Evidence |
|---|---|---|
| Log stored on-device only, by default | ✅ true | IndexedDB via `src/db.ts`; no server log endpoint exists |
| We store only an email + entitlement server-side | ✅ true | `server/store.js` — no logs, no photos, no profile fields |
| Photos are never stored on our servers | ✅ true | `/api/recognize` forwards to Vertex AI and returns; nothing persisted |
| Photos never leave the device except to identify a meal | ✅ true | only `/api/recognize` transmits an image |
| The Google Sheets mirror never contains photos | ✅ true | `rowFromEvent` excludes photo/Blob data by design and by property test |
| AI insights see aggregates, not your raw log | ✅ true | on-device evidence summary is what's sent to `/api/insights` |
| Sync failures never mutate local data | ✅ true | local-first guarantee, property-tested |
| You can sync to a Google Sheet you own | ✅ true | `src/googleSheets.ts`, shipped; needs `VITE_GOOGLE_CLIENT_ID` |
| Logging is free forever | ✅ true | entitlement gates AI only |
| Free CSV/JSON export | ✅ true | `src/backup.ts` |
| No download; runs from a URL on iOS/Android/desktop | ✅ true | installable PWA via `vite-plugin-pwa` |
| Installs to the home screen, opens full-screen to camera | ✅ true | PWA manifest + camera-as-home |
| Manual logging works offline | ✅ true | service worker + IndexedDB; AI features need network |
| No app-store account or platform fee | ✅ true | served from Cloud Run |
| Start without an account | ❌ **not yet** | `App.tsx` gate order is session → sign-in → intro → app |
| Choose local / Sheets / **cloud** | ⚠️ **partly** | local ✅, Sheets ✅, cloud not built |
| Reminders / push notifications | ❌ not built | and on iOS they'd require home-screen install first |
| Native iOS / Android apps | ❌ planned | PWA only today |

## Claims we must not make

- ❌ *"Your data never leaves your device."* Meal photos are sent to our server and on
  to Vertex AI for recognition. Say **"your log stays on your device; photos are sent
  only to identify the meal, and we don't keep them."**
- ❌ *"No account needed."* Not true until the deferred sign-in work lands. Until then:
  *"No profile, no quiz — just an email."*
- ❌ *"Cloud sync available."* Not built.
- ❌ Anything diagnostic, allergy-test-shaped, or causal. Associations, not causation —
  the framing in `docs/research-and-insights.md` is a regulatory line, not just tone.
- ❌ *"Accurate FODMAP data."* Our tagging is coarse keyword matching. Monash's
  portion-aware, lab-tested data is the gold standard and we don't have it.
- ❌ *"Identical to a native app."* On iOS, web apps get tighter storage quotas, no
  background sync, and push only after the user adds it to the home screen.
- ❌ *"We'll remind you to log."* No notifications are implemented.
- ❌ *"Your data can't be lost."* Browser storage can be evicted under pressure. We
  request persistent storage best-effort (`requestPersistentStorage` in `backup.ts`)
  and nudge for backups, which is exactly why sync choice matters. Say **"your data is
  yours — keep a copy wherever you like."**

---

## Message hierarchy

**Tagline:** Know what your gut is telling you.

**One-liner:** Snap your meals, log how you feel, and find the foods behind your
symptoms — without typing a food diary or handing over your data.

**Three-bullet version:**
- Logging takes seconds — photo in, ingredients out.
- Patterns measured against your own baseline, not a made-up score.
- Your log stays on your device. You choose if it syncs anywhere at all.

**No-install line:** No download. Open a link and start — add it to your home screen if
you like it.

**Privacy line (short):** No profile, no quiz, no cloud by default. Just an email.

**Privacy line (long):** We ask for an email so you have an account, and nothing else.
Your log lives on your device. If you want a backup, you pick where it goes — your own
Google Sheet, or nothing at all. Photos are sent only to identify the meal, and we don't
keep them. Export everything, any time, free.

**Rigor line:** We won't call a food a trigger until the data earns it.

---

## Competitive framing

| Their move | Our counter |
|---|---|
| Subscription wall before first log | Logging free forever |
| Onboarding quiz, profile, weight, goals | An email, nothing more |
| Cloud account required | Local-first; sync is opt-in |
| Opaque 0–100 "gut score" | Baseline-relative lift, exposure gates, visible confidence |
| Type/search every food | Photo-first capture |
| Day-bucketed logs | Timestamped events with 30 min–48 h lag windows |
| Locked-in data | Free CSV/JSON export, plus a Sheet you own |
| Download an app, make a store account, then pay | Open a link and start |

## Work required to make the promise whole

Ordered by how much of the positioning each unlocks.

1. **Deferred sign-in** — let users log locally before creating an account, prompting
   only when they reach an AI feature. Already a TODO in `docs/auth-and-credits.md`.
   Without this, "non-intrusive" is aspirational and the first-run cliff stays.
2. **Sync choice UI** — one clear settings surface presenting local-only / Google Sheet
   / cloud as a deliberate user decision, so data control is *visible*, not just real.
3. **Optional cloud sync** — the third tier. Keep local as source of truth; make cloud
   an explicit opt-in, never a default or a precondition.
4. **A plain-language privacy page** — turn the defensible-claims table above into
   something users can read. This is a marketing asset, not compliance boilerplate.
5. **Guided FODMAP program** — delivers the "walks you through finding your triggers"
   half of the positioning statement (`docs/fodmap-program.md`).
6. **Clinician export** — trust signal, and it reinforces "your data is yours."
7. **Sharpen the install path** — the Add-to-Home-Screen step is our conversion cliff.
   Clear platform-specific prompting (`InstallHint.tsx` exists) is cheap and directly
   improves retention.
8. **Native iOS / Android** — for store discovery and reliable reminders. Keep the web
   app canonical, keep local-first intact, and don't let a native build quietly become
   a cloud-account requirement.

---

_Claims audited against the codebase on 28 July 2026. Re-audit before publishing any of
this externally; the ✅ marks are only as good as the code they describe._
