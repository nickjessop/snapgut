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
- **You choose where it syncs:** local-only (default), your own Google Sheet, or
  SnapGut Cloud. Both destinations shipped, both are independent, both are **Pro**, and
  neither is ever on by default. Opt in, switch, or opt out at any time.
- **Free forever for logging.** Manual logging, on-device stats, food ranking, and
  export are never paywalled. Pro buys **AI and syncing**, not access to your own
  history.
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
| Log stored on-device only, by default | ✅ true | IndexedDB via `src/db.ts`; nothing syncs until the user enables a destination in Settings |
| We store only an email + entitlement server-side | ✅ true | `server/store.js` — no logs, no photos, no profile fields |
| Photos are never stored on our servers | ✅ true | `/api/recognize` forwards to Vertex AI and returns; nothing persisted |
| Photos never leave the device except to identify a meal | ✅ true | only `/api/recognize` transmits an image |
| The Google Sheets mirror never contains photos | ✅ true | `rowFromEvent` excludes photo/Blob data by design and by property test |
| AI insights see aggregates, not your raw log | ✅ true | on-device evidence summary is what's sent to `/api/insights` |
| Sync failures never mutate local data | ✅ true | local-first guarantee, property-tested |
| You can sync to a Google Sheet you own | ✅ true, **Pro** | `src/googleSheets.ts`, shipped; needs `VITE_GOOGLE_CLIENT_ID`; `canSync()` requires `isProEntitled()` |
| Cross-device sync with SnapGut Cloud | ✅ true, **Pro** | shipped by the `cloud-sync` spec; `/api/sync/*` answers `upgrade_required` 402 to a non-Pro session (`server/sync.js`) |
| Cloud sync never carries a photo | ✅ true | `photo` is never read into the wire shape and the codec drops any nested `data:`/base64 value; the service rejects `photo_field` (`src/cloudSync.ts`) |
| The device stays the source of truth when cloud sync is on | ✅ true | local-first merge in `src/cloudSync.ts`; a failed cycle never mutates local data |
| Both destinations are off by default and independent | ✅ true | `src/syncSettings.ts` per-destination enabled state; separate status lines in `SettingsView.tsx` (D6) |
| Delete the cloud copy without deleting the account, even after Pro lapses | ✅ true | `DELETE /api/sync/data` is authenticated but deliberately exempt from the Pro gate (`proExempt` in `server/sync.js`) |
| Account deletion removes the cloud copy, then the account record | ✅ true | `POST /api/account/delete`; a partial failure reports incomplete and changes nothing else |
| A lapsed Pro loses AI and sync, never local data | ✅ true | entitlement gates the sync trigger and the AI routes; nothing clears IndexedDB or the stored spreadsheet id |
| Logging is free forever | ✅ true | entitlement gates the AI routes and the sync destinations only — never reading, ranking, or exporting your own log |
| Free CSV/JSON export | ✅ true | `src/backup.ts`; no entitlement check on either path |
| The Sheet's columns are the CSV export's columns | ✅ true | `rowFromEvent` writes the `toCSV` column order plus an `id` |
| Free AI trial shared across recognition and insights | ✅ true | one `freeAiUsed` counter against `FREE_AI_LIMIT`, checked by both `/api/recognize` and `/api/insights` |
| Sign-in is a six-digit code, ten minutes, a few attempts | ✅ true | `server/index.js`: 10-minute `expiresAt`, 5 attempts, the code stored as a hash and cleared on successful use |
| Payments run on Stripe's checkout; we never hold card details | ✅ true | `/api/billing/checkout` and `/api/billing/portal` redirect to Stripe; no card field anywhere in the store |
| No advertising, third-party analytics, or tracking cookies | ✅ true | no analytics SDK in `src/`; the marketing pages load nothing cross-origin, asserted by `src/marketing.isolation.test.ts` |
| No download; runs from a URL on iOS/Android/desktop | ✅ true | installable PWA via `vite-plugin-pwa` |
| Installs to the home screen, opens full-screen to camera | ✅ true | PWA manifest + camera-as-home |
| Manual logging works offline | ✅ true | service worker + IndexedDB; AI features need network |
| No app-store account or platform fee | ✅ true | served from Cloud Run |
| Choose local / Sheets / cloud | ✅ true | all three exist; local-only is the default, the other two are Pro and opt-in per destination |
| Start without an account | ❌ **not yet** | `App.tsx` gate order is still session → sign-in → intro → app |
| Reminders / push notifications | ❌ not built | no `Notification` or push code in `src/`; on iOS they'd require home-screen install first |
| Native iOS / Android apps | ❌ planned | PWA only today. The home page carries store badges marked *Coming soon* as inert list items, not links — a forward-looking promise rather than a capability, and the only claim on the site that no code can back |

## Claims we must not make

- ❌ *"Your data never leaves your device."* Meal photos are sent to our server and on
  to Vertex AI for recognition. Say **"your log stays on your device; photos are sent
  only to identify the meal, and we don't keep them."**
- ❌ *"No account needed."* Not true until the deferred sign-in work lands. Until then:
  *"No profile, no quiz — just an email."*
- ❌ **Misstating sync's availability in either direction.** *Replaces the previous entry,
  ❌ "Cloud sync available." — see Finding 1 below; the entry was retired because the
  capability shipped, not because the copy was allowed to outrun it.* Two forms are now
  false: offering sync on the free tier (`/api/sync/*` answers `upgrade_required` to a
  non-Pro session, and the Sheets trigger is gated the same way), and calling it
  forthcoming or unavailable (it shipped). Say **"cross-device sync with SnapGut Cloud is
  a Pro feature."**
- ❌ *"Pro buys AI, not access to your own history"* **on its own.** Half of it still
  holds — Pro never gates reading, ranking, or exporting your log — but Pro now also buys
  syncing, so the short form under-describes what is behind the paywall. Say **"Pro buys
  the AI and the syncing, not access to your own history."**
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
Your log lives on your device. If you want it to travel, you pick where it goes — SnapGut
Cloud or your own Google Sheet, both Pro, both opt-in, or nothing at all. Photos are sent
only to identify the meal, and we don't keep them. Export everything, any time, free.

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
   Without this, "non-intrusive" is aspirational and the first-run cliff stays. **Still
   the top item, and now the only unmet one in the privacy pillar.**
2. ✅ **Sync choice UI** — *done.* `SettingsView.tsx` presents SnapGut Cloud and Google
   Sheets as two independent destinations, each with its own toggle, its own status line,
   and its own Pro gate, over a local-only default.
3. ✅ **Optional cloud sync** — *done (`cloud-sync` spec).* Local stays the source of
   truth, it is opt-in per device behind an acknowledged disclosure, and it is never a
   precondition for logging.
4. ✅ **A plain-language privacy page** — *done.* `/privacy`, built by task 5.4 of the
   `marketing-site-and-routing` spec, and written from this table.
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

## Re-audit — 1 August 2026

Second pass, run against the copy that is actually published at `snapgut.com` (`/`,
`/pricing`, `/privacy`, `/terms`, and the 404 document) rather than against the intent,
and against the code each sentence rests on. The enforcement side is
`src/marketing.claims.test.ts`, which carries the phrase patterns derived from *Claims we
must not make* above.

**What changed in the table.** Sheets sync and SnapGut Cloud are both marked Pro; "choose
local / Sheets / cloud" moved from ⚠️ partly to ✅ true; "logging is free forever" now
says the entitlement gates AI *and* sync rather than "AI only". Twelve rows were added for
claims the published pages make that the table did not cover — photo-free cloud sync,
device-as-source-of-truth, both destinations off by default, the two deletion paths, what
a Pro lapse does and does not take, the Sheet/CSV column identity, the shared AI trial, the
sign-in code's shape, Stripe holding the card details, and the absence of analytics.

**Findings — copy the code does not fully support. Not changed here; this task audits.**

1. **The published site says what the previous table forbade, and it is right to.** *Cloud
   sync available* was listed under claims we must not make, with the reason "Not built."
   The capability shipped, so the ban's premise is gone and Requirement 9.4 of the
   `marketing-site-and-routing` spec now *requires* the site to describe sync as a Pro
   feature. The entry is replaced above with the constraint that survived — do not misstate
   availability in either direction — rather than deleted. `src/marketing.claims.test.ts`
   retired the same entry for the same reason and scans for both wrong directions, so the
   forbidden-phrase list still matches this section. Nothing was weakened to make a test
   pass: every other entry's patterns are intact.
2. **"Pro buys AI, not access to your own history" is now half a sentence, and `/terms`
   still ships the half.** Sheets sync is Pro-gated (`canSync()` requires
   `isProEntitled()`), so Pro buys AI *and* syncing. `/` says so correctly ("Pro buys the
   AI and the syncing"); `/terms` still carries the older short form under *Free and Pro*,
   one paragraph above a paragraph that correctly lists sync as a Pro unlock. Not false —
   Pro genuinely does not gate your history — but incomplete next to the home page's
   wording. A copy decision, so it is left to the operator.
3. **`/privacy` groups the sign-in code under "short-lived operational data", and an
   abandoned code is not.** A used code is deleted the instant it is verified
   (`store.clearCode` on success), and the rate-limit counters do expire on their own —
   both TTL policies are active. But the `authCodes` collection has no TTL, so a sign-in
   that is started and never completed leaves an email address and a dead code hash
   indefinitely. Bounded (one document per address, overwritten on each request) and
   already recorded as a finding under task 10.5 of the `marketing-site-and-routing` spec.
   The fix belongs on the server, not in the copy.
4. **The `/pricing` meta description omits sync.** It reads "Pro adds AI meal recognition
   and insights", while the page body correctly lists both sync destinations under Pro. An
   omission rather than a false claim, and a crawler reads the description as copy, so it
   is worth one edit next time that string is touched.

_Claims audited against the codebase on 28 July 2026 and re-audited against the published
copy on 1 August 2026. Re-audit again before publishing anything new externally; the ✅
marks are only as good as the code they describe._
