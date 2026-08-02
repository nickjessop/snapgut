# Pre-launch fixes

Small, user-visible changes queued ahead of the demand test. Each one is scoped to
be shippable on its own; none of them needs a spec.

Status legend: ☐ not started · ◐ in progress · ☑ done and deployed

---

## 0. ☑ Deferred sign-in, and server-side funnel counters

**Why.** The app gated on sign-in before showing anything, so a visitor from Reddit
or Hacker News met a six-digit-code form before they met the product. And with no
analytics of any kind, a demand test would have produced no readable signal.

**What shipped.**

- `mayEnterApp` is unconditional. An App_Route no longer needs a session; the gate
  moved to the two places that genuinely need one, `/api/recognize` and
  `/api/insights`. Logging, the on-device stats, and the Foods ranking are all open.
- Two sign-in surfaces instead of one blanket gate. `/login` still owns the screen
  and the URL; an AI call site raises a prompt that leaves the URL and the in-flight
  photo alone, and offers "Not now".
- `MealDetails` no longer fires a doomed recognition request for an anonymous
  visitor — it opens in manual mode and offers sign-in, not Pro, because a free
  account is what unlocks the AI trial.
- Settings shows "Sign in" rather than "Sign out", "Delete account", or an upgrade
  CTA when there is no account.
- Aggregate counters on the Origin_Server: `view:*` per route class, `signup_new`
  vs `signin_return`, `ai_recognize`, `ai_insights`, plus two client-reported events
  (`log_saved`, `first_log`) for the one thing the server cannot see, since a log is
  written to IndexedDB and never sent. Read them at `GET /api/admin/metrics`
  (`x-admin-token`, `?days=N`).
- Account retention comes from `createdAt` and a day-granular `lastSeenDay` on the
  user record — no new identifier, because an account already is one.

**Deliberately not built: anonymous cohort retention.** It needs a per-device id,
and the counters record none — no IP, no token, no cookie, no per-request row. The
funnel is readable; "did this same anonymous visitor come back on day 7" is not.

**Copy follow-up, not taken here.** The client now makes one network call it did not
make before: a two-word event name, no identifier, on save. It sends no log content
and contradicts nothing on `/privacy`, but the privacy page is silent about it. That
is a claims decision, so it is left to the operator rather than edited in passing.
See `src/metrics.ts` for exactly what leaves the device.

---

## 1. ☑ Log a meal without a photo, or pick one from the camera roll

**Why.** The camera being the home screen made the photo feel compulsory, which
blocked two ordinary cases: a meal already eaten, and a meal already photographed.

**What shipped.** Two icon buttons flanking the shutter, smaller and translucent so
the shutter stays the obvious primary action:

- **left** — pick from the photo library. A *second* hidden file input, because the
  existing one carries `capture="environment"` and a single input cannot both prefer
  the camera and offer the library.
- **right** — log with no photo. Goes straight to `MealDetails`, skipping the
  caption step, which has nothing to preview.

Both are repeated as text links on the no-live-camera fallback, where they matter
more rather than less.

`MealDetails` now takes `photo: Blob | null`. With no photo it opens in manual mode,
makes no recognition request, spends no free AI use, and shows *neither* the sign-in
nor the Pro offer — no AI was withheld, there was simply no image to read. An "Add a
photo instead" link is offered rather than nagged.

---

## 2. ☑ Exact time on the quick-time picker

**What shipped.** A trailing **Date…** chip on `WhenPicker`, which reveals a
`datetime-local` field seeded from whatever is currently selected. Once set, the chip
shows the chosen instant instead of the placeholder. The relative chips are untouched.

A future instant is refused two ways: `max` on the input stops it at the picker, and
`parseLocalInputValue` clamps it as a backstop. That matters because every
correlation runs forward from a meal to the symptoms that follow it, so a
future-dated meal would not error — it would silently fall out of the analysis.

Shared by the symptom, bowel, and check-in flows, so all four gained it at once.
Verified end to end: a symptom backdated seven days lands at exactly that instant.

---

## 3. ◐ Bug: a meal's photo vanishes from the log after editing

**Reported.** Edit a meal, save — the photo is gone from the log list. Edit and save
again — it comes back.

**Could not reproduce.** Walked the full path in Chromium against a real IndexedDB:
created a meal with a photo, edited it, saved, and read the store on both sides of
the save. The Blob survived and the thumbnail stayed. So the report is not
reproducible under the conditions tested, and the root cause is still open.

**What was ruled out.**

- `mergePulledPage` already calls `withRetainedPhoto`, which explicitly carries the
  local Blob across a cloud-sync merge. The obvious sync-clobbers-photo theory does
  not hold as written.
- The store keeps the Blob across a normal edit round trip.

**Not ruled out — and the likeliest remaining leads.** The reproduction ran signed
out, so both sync destinations were gated off. Still open:

1. **Google Sheets re-import.** `finishFlow` calls `syncAll()` when Sheets is
   connected. A Sheet row carries no photo, so if a re-import ever writes rows back
   as events it would clobber the Blob — and re-editing from a list loaded *before*
   the clobber would write it back, which matches the "comes back" half exactly.
2. **iOS Safari**, where the report may have come from: tighter storage quotas and
   more aggressive Blob eviction than Chromium.

**What shipped anyway**, because both are correct regardless of the cause:

- `MealDetails.save()` falls back to `editing.photo` when handed no photo. `putEvent`
  replaces whole records, so a `photo` absent from the object it is given is a
  `photo` deleted from the store — saving an edit can now never lose an untouched
  image, whatever cleared the prop.
- `MealContent` clears its object URL when a record arrives with no photo. The old
  early-return left the previous URL in state, so a row could keep showing a revoked
  or wrong image. That is a real latent bug in the opposite direction, now fixed and
  covered.

**To close this out, the operator needs to confirm:** signed in or out? Pro? Cloud
sync or Google Sheets enabled? iOS Safari or desktop? Those four answers separate
lead 1 from lead 2.

**Test-harness note worth keeping.** jsdom implements neither `URL.createObjectURL`
nor Blob round-tripping through fake-indexeddb, which is why the thumbnail path had
no coverage before now. `src/mealCapture.test.tsx` stubs the object-URL pair rather
than skipping it, so issue and revoke are now asserted.

---

# Round two

Requested after the first deploy. Triaged into two batches: mechanical work that can
ship together, and feature work that carries a design decision.

## Batch A — plumbing, layout, and navigation

**Shipped in revision `snapgut-00010-7zr`.** 1029 tests passing, build id
`0.1.0+20260801-2136` visible in Settings on production.

- ☑ **A1. Real version number.** `__APP_BUILD__` is substituted by a Vite `define`
  from `package.json` plus a build timestamp, surfaced as `src/build.ts`, shown in
  Settings, and sent with every metric tick (so `/api/admin/metrics` records
  `log_saved@<build>` beside the plain name). A git SHA was rejected: `.git` is
  excluded from the Docker context, so `git rev-parse` would work locally and
  silently produce nothing in Cloud Build.
- ☑ **A2. Guard the silent auto-reload.** Switched to `registerType: "prompt"` — not
  to show a prompt, but because `autoUpdate` gives away control of *when* the reload
  happens. `src/swUpdate.ts` still applies updates automatically and silently, but
  holds them while an Ephemeral_Flow is open or a sign-in screen is up, and applies
  the moment it is safe. Deferred, never dropped.
- ☑ **A3. Stop re-requesting camera permission — partly.** `src/cameraStream.ts`
  shares one stream across mounts, so camera → logs → camera no longer re-acquires
  the device; released on page hide or after a 60 s grace period, so the app does not
  sit holding the camera while you read your log. **A first-use prompt per launch is
  the platform's call, not ours** — an installed iOS PWA may still ask once per
  launch however the stream is managed. Needs a real-device check to confirm how much
  improved.
- ☑ **A4. Full-height layout, no vertical rubber-banding.** The gap was a unit
  mismatch: `html`/`body` at `height: 100%` resolve against the *initial* viewport
  (which includes the strip under a collapsing URL bar) while `.app` used `100dvh`,
  the dynamic one. `body` is now `position: fixed; inset: 0`, which both pins it to
  the visual viewport and stops the document bounce that `overscroll-behavior` alone
  does not. Verified on production: `documentElement.scrollHeight === innerHeight`.
  Inner scroll preserved — the scroll containers each got `overscroll-behavior:
  contain` so reaching the end does not chain outward.

  **That fixed a real bug on Chromium and did not fix iOS.** Three further attempts on
  an installed iOS app all failed: removing the over-constraining `height: 100%` from
  the fixed body, painting `html` in `--bg` so an uncovered strip would not be black,
  and a `min-height: 100dvh` floor on `.app`. The band under the tab bar survived all
  three, and the user also saw it on the edit-event sheet — a different element, which
  pointed at a shared ancestor rather than at either component.

  Cause: in standalone mode with `viewport-fit=cover`, the CSS viewport that `inset:
  0`, `100vh`, and `100dvh` all resolve against is the one *inside* the safe areas,
  while the web view covers the whole screen. So every one of those boxes was correct
  by the box model and still ended above the home indicator. There is no CSS unit for
  what was needed.

  Fix: `src/appHeight.ts` writes `window.innerHeight` — which in standalone reports the
  web view's own height, safe areas included — to `--app-height` on the root element,
  and `body`, `.sheet-backdrop`, and `.photo-overlay` size off it. `.app` is `100%` of
  the body as before, so every screen inherits it, the sheet included. Called from
  `main.tsx` before first render so a cold launch never lays out short and corrects
  itself. `visualViewport.height` was rejected: it shrinks with the keyboard, and
  collapsing the frame around a keyboard is a different bug.

  Verified in a browser by forcing `--app-height` 34px past the CSS viewport: the
  frame, the tab bar, and the sheet all followed to the new bottom and
  `documentElement.scrollHeight` stayed at the viewport, so nothing gained a scrollbar
  or a bounce. `src/appHeight.test.ts` covers the measurement contract.

  **This did not fix it either — four attempts, none confirmed.** Two facts worth
  recording before the fifth:

  1. `viewport-fit=cover` has been in `app/index.html` since the initial commit
     (`git log -S`), so no install predates it and re-adding the app cannot be what
     any of these fixes were waiting on.
  2. **Every browser check run against this bug was worthless, and it took four tries
     to notice.** Chromium reports `env(safe-area-inset-*)` as `0`, so not one
     safe-area rule in this stylesheet ever executed during testing. Forcing
     `--safe-top: 59px; --safe-bottom: 34px` in a real browser is the correct
     simulation, and under it the layout measures right: `.app` is 0→852, `.tabbar`
     reaches 852, and the 34px below the tab icons is the bar's own dark green, not
     background.

  Which leaves two live hypotheses that no amount of reading settles, and they call for
  opposite fixes — one wants the frame taller, the other wants padding reduced:

  - the frame really is short on iOS, in a way Chromium will not reproduce; or
  - the frame is correct and what reads as a gap is `--safe-bottom` padding, which
    every surface the user named happens to carry: `.tabbar` (34px below the icons),
    `.settings-scroll` (`40px + safe` = 74px), `.sheet` (`20px + safe` = 54px).

  So the next change is a measurement, not a fix. The diagnostics panel now prints
  `clientHeight` (the CSS viewport) beside `innerHeight`, and paints three markers:
  yellow at the bottom of the frame (absolute), cyan at the bottom of the CSS viewport
  (fixed), and magenta on `html` for anything the document does not cover. Magenta
  visible means a short frame; yellow and cyan at different heights means the web view
  and the box model disagree; both at the physical edge with no magenta means the
  layout is right and the space is padding. One screenshot picks one.
- ☑ **A5. Respect the top safe area.** `.sheet`, `.log-header`, and
  `.settings-header` were the three that never got `--safe-top` while already having
  `--safe-bottom`, which is exactly why the back control sat under the notch on every
  log and edit screen. **Still needs a real notched device to confirm** — the
  emulator reports a zero inset, so this is verified by inspection, not by sight.
- ☑ **A6. One back affordance everywhere.** `src/BackButton.tsx`, used by all four
  log/edit screens, the capture preview (was an X), and Settings. "Cancel" was also
  the wrong word: it reads as *discard*, which is what it does on a confirmation
  dialog but not what leaving a half-filled log does. Confirmation dialogs keep their
  textual "Cancel" deliberately — that is a choice between outcomes, not a navigation.
- ☑ **A7. Backdate a meal — was indeed missing.** `WhenPicker` was wired into the
  symptom, bowel, and check-in flows but not `MealDetails`, which hardcoded
  `Date.now()`. Backwards, since a meal is both the most often logged after the fact
  and the anchor every association is measured forward from. Now present, and unlike
  the other flows it is shown when editing too, seeded from the stored timestamp so
  an edit cannot silently re-date a meal to now.
- ☑ **A8. Cache food images locally — already done, twice.** Workbox runtime-caches
  `/foods/*` CacheFirst (1200 entries / 180 days, `vite.config.ts`), and
  `src/imageCache.ts` persists *misses* so a known 404 is not re-requested each
  session. What is actually slow is the first paint of an uncached image, so the
  improvement belongs in A10 (preload during the splash), not here.
- ◐ **A9. Second Pro upsell in Settings — retitled, not removed.** The complaint was
  right: two rows both read "Upgrade to SnapGut Pro" on one screen. But deleting the
  lower one broke cloud-sync **Requirement 1.2** and two tests in
  `src/settings.cloud.test.tsx`: the Cloud toggle above it is locked, and the spec
  wants an interactive way to unlock it next to the thing being unlocked. So the
  Account row stays canonical and this one now names what *it* buys — "Unlock Cloud
  sync" — which removes the repetition without removing the affordance. **Flagged for
  a decision:** if you would rather it go entirely, that is a deliberate spec change
  plus a test update, not a tweak.
- ☑ **A10. Loading splash screen.** Inline `<style>` and markup in `app/index.html`,
  so it paints before the stylesheet or the bundle arrive — it could not live in
  `styles.css` and could not use an image, either of which would be a request the
  splash exists to cover. (`style-src` allows inline; `script-src` does not.) Colour
  matches the manifest `background_color`, so an Android home-screen launch has no
  seam. The markup sits inside `#root`, so React removes it on first render — no
  teardown code, so nothing can leave it stuck. The spinner is delayed 0.25 s so a
  fast load shows nothing at all.
  `src/preload.ts` uses the idle moment after launch to warm the thumbnails for the
  foods this device logs most (bounded to 40, last 30 days, skipping known misses,
  scheduled on `requestIdleCallback`) — which is the real answer to A8.

## Batch B — feature work with a decision attached

**Shipped in revision `snapgut-00012-ts5`.** 1075 tests passing.

- ☑ **B1. Persist generated insights.** `src/insightHistory.ts`, surfaced as a
  collapsed "Past insights" section with the date and the evidence behind each one
  ("6 meals over 6 days") so an older read can be judged on what it had to work with.

  **Storage decision: the `meta` store, not a new one.** A bounded list of small text
  records is exactly what `meta` is for, and it avoids a schema version bump and its
  migration. Capped at 30, deduplicated on a one-minute window because Pro
  auto-generates on entering the tab and React effects can run twice. Reads are
  defensive — a malformed row degrades to "no history" rather than throwing inside
  the Patterns view.

  **They do not sync, by consequence rather than by accident:** the Sync_Service
  carries `events`, never `meta`. That is the conservative default for AI-written text
  about someone's health log, and it should stay a deliberate decision if revisited.
  A "Clear past insights" control sits in Settings beside the other data controls, and
  is deliberately available when signed out — insights are generated with a session
  but remain on the device afterwards.
- ☑ **B2. Tappable pattern explanations.** `src/triggerInfo.ts` covers all eleven
  trigger groups, opened from a pattern row via `src/TriggerInfoSheet.tsx`. Only rows
  whose group we can actually explain become tappable, because offering a tap that
  opens nothing is worse than not offering one.

  The copy follows three editorial rules, enforced by test: associative rather than
  causal or diagnostic, honest that our own grouping is approximate, and no
  elimination advice. Two entries had to be reworded because the guard caught them —
  "cures" (as in curing meat) and "treat it as a lead" both tripped medical-claim
  patterns. Wording changed rather than the guard loosened.
- ☑ **B3. Credit foods that appear without symptoms — already the design, and the
  proposed change would be a downgrade.** `foodScores.ts` computes
  `foodRate = withSymptom / eaten`, so a symptom-free appearance already counts in
  the food's favour by growing the denominator. Expressed as a rate rather than a
  running point tally, which matters: a tally is order-dependent and unbounded, a
  rate is neither.

  It goes further than the request. `baselineRate` is the follow rate for meals
  *without* the food, and `lift = foodRate / baselineRate` gates every negative
  rank, so a user who gets symptoms after most meals does not have every food
  flagged. `MIN_OTHER_MEALS` refuses to rank at all until the baseline is
  trustworthy, and an `agrees` rank ("Agrees with you", `foodRate ≤ 0.25` and
  `lift ≤ 0.9`) already gives explicit positive credit.

  The premise behind the request is accurate though: every confident ingredient in
  an implicated meal does take the hit, because a single meal cannot say which
  ingredient was responsible. Disentangling that over many meals is exactly what
  baseline-plus-lift does. So the work is not in the maths — it is in showing it,
  which is B2. Surface `eaten`, `withSymptom`, `baselineRate` and `lift` in plain
  language, and give the "Agrees with you" group more prominence.

  One thing noted and deliberately not changed: `LAG_WINDOW_MS` here is a flat 24 h,
  so a breakfast ingredient is implicated by an 11 pm symptom. That is generous and
  inflates `withSymptom` across the board. It is consistent with the documented
  30 min–48 h framing, so changing it is a product decision, not a bug fix.
- ☑ **B4. Swipe sideways between screens.** `src/useSwipeNav.ts` reports a direction
  and nothing else; `App.tsx` calls the same `goToView` a tab tap calls, so the URL
  and the single history entry come out identical either way (R4.2). A gesture that
  wrote history itself would have been a second way to get that wrong.

  Order is Logs · Camera · Insights, matching where each sits in the tab bar. Settings
  is excluded — it is reached deliberately and swiping into it would be a surprise.
  Stops at the ends rather than wrapping.

  **Most of the work was deciding what is not a swipe.** Ignored: anything starting in
  an `.hscroll` row (the When-picker chips, the Foods list), a horizontally scrollable
  ancestor, a form control, or a `data-no-swipe` subtree; anything under 60 px, more
  vertical than horizontal, slower than 600 ms, or multi-touch. Inert entirely while a
  flow, sheet, paywall, or sign-in screen is open, since swiping the page out from
  under an unsaved form would discard it. Listeners are passive and never
  `preventDefault`, so vertical scrolling is untouched rather than fought.

## Also in this deploy

- ☑ **Install-to-Home-Screen prompt, reworked.** `InstallHint` existed but was an
  inline banner in the Logs list shown on the first visit — so most people never met
  it, and it asked before there was anything to protect. It is now a sheet raised over
  the tab shell (seen wherever the user is), gated on having saved at least two logs,
  snoozing for seven days on "Not now" rather than vanishing forever, with a separate
  "Don't ask again". Handles `appinstalled`, and shows manual steps on iOS where the
  prompt cannot be triggered programmatically. Worth remembering *why* it matters on
  iOS specifically: an uninstalled PWA's storage can be cleared after a week of not
  visiting, which would take the log with it.
- ☑ **Removed the standing note at the top of Logs.** It explained a screen that needs
  no explaining and was the first thing above the log every time. Nothing was lost:
  the medical disclaimer lives on Insights, which is the surface that interprets
  rather than records; the backup warning is carried by the nudge, which appears when
  it is actually due; the privacy statement is in Settings and on `/privacy`.
- ☑ **Corrected the Insights counting copy, which was wrong.** It described an
  association as a *food* — "out of every meal containing the food". `insights.ts`
  keys associations by trigger **group** and divides by meals containing the group, so
  the text misdescribed the number printed directly beneath it. Now says group, states
  that a pair must appear at least twice to be listed, and admits the grouping can
  misfire ("almond milk" read as milk).
- ☑ **Explained why a daily staple never gets ranked** on the Foods tab.
  `MIN_OTHER_MEALS` holds a food back until there are meals *without* it to compare
  against; unexplained, that reads as the ranking being broken.
- The app icon replacement by the other agent is included in this deploy. Verified
  before shipping: all four sizes present, correct dimensions, and every manifest
  icon resolves 200 on production. Not otherwise touched.

---

## Notes worth keeping from batch A

**Two module singletons needed test resets, and one of them caused a real bug.**
`src/cameraStream.ts` and `src/swUpdate.ts` both hold process-wide state, which made
tests order-dependent. Both now export a `reset*ForTests`. Worth remembering as a
pattern: a singleton that survives a test survives into the next one.

**A latent bug in `CameraView` surfaced while doing A3, and it was not mine.** The
original code called `setError("live")` from an async catch without checking whether
the view had unmounted. The synchronous `getUserMedia` throw used to make that
harmless by arriving fast enough; adding one `await` was enough to expose it, and it
broke `routing.client.test.tsx` in a way that looked nothing like a camera problem —
a pending state update on an unmounted component lands during whatever renders next.
Fixed two ways: the catch checks `cancelled`, and an absent camera API is now detected
synchronously before anything is awaited.

**`marketing.isolation.test.ts` requires a fresh `dist/`.** It walks the built module
graph, so it fails confusingly ("loads assets/MyComponent, which is not in dist/")
whenever the build is older than the source. Run `npm run build` before trusting a
failure from that file.

**Test count: 965 → 1029** across both batches.

## Outstanding before the demand test

- Real-device pass on iOS: the notch inset (A5), the camera prompt frequency (A3),
  and whether the fixed-body layout behaves with the keyboard open.
- The A9 decision above.
- All of batch B.

## Silence as a signal: meal outcomes

The question that started this: *if you eat, feel fine, and therefore never open the
app, is that absence being counted as the good news it is?*

Partly, and the part that was missing turned out to be a bug rather than a gap.

**Already right.** `foodScores.ts` has always divided symptom-follows by exposures,
so a food eaten often without trouble earns "Agrees with you". Symptom-free meals
were counted in a food's favour from the start.

**Wrong.** "No symptom logged" was read as "no symptom occurred", with no conditions
attached, and that collapses three different situations into one:

1. The window has closed and the user was demonstrably still using the app without
   reporting anything. Their silence is about the food.
2. The window has not closed yet. Nothing is decided — and counting a meal logged
   twenty minutes ago as symptom-free is not conservative, it is wrong. It also
   biases the *most recent* foods hardest, which is exactly when someone is looking.
3. The window has closed but the app has not been opened since. Absent data wearing
   the costume of good news.

`src/mealOutcome.ts` now classifies each meal as `symptom`, `clear`, `pending`, or
`unobserved`, and both analyses share it so they cannot drift on what "after a meal"
means. Only `symptom` and `clear` reach a rate.

Excluding the other two costs less than it sounds. `unobserved` can only ever be the
tail of a logging streak, because **writing anything resolves every meal whose window
has already closed** — so for anyone using the app at all, nearly every symptom-free
meal still counts. Presence is read from `updatedAt` rather than `createdAt` on
purpose: `createdAt` is backdatable and proves nothing about when someone was present.

**Saying it outright.** `MealEvent.outcome?: "fine"` is the user stating it rather than
us inferring it — the one form of this evidence that cannot be confounded by simply
not opening the app. Optional and only ever `"fine"`, so absence means "not stated"
and every meal logged before the field existed keeps its meaning. There is no "felt
bad": that is what a symptom event is for.

It syncs (wire codec, allowlist, round-trip property), because otherwise two devices
would compute different rankings from the same data.

**Nothing is set in stone.** The control is a toggle in both places it appears —
`ConfirmOutcomes` in Insights, and the meal's own edit screen for the life of the
meal. Clearing an answer removes the key rather than storing `undefined`, so "not
stated" is byte-identical to never having been asked. The Insights list deliberately
does *not* re-key on an answer: the row stays put so the undo is still there.

Foods now show the positive evidence too. A bare "17%" reads as an accusation with no
defence; "17%, 5 symptom-free, 1 not yet counted" is the same number and an honest
claim.

`src/mealOutcome.test.ts` covers it — 19 cases, and worth noting the scoring logic had
**no tests at all** before this.

## Install nudge: a bar, not a dialog

Reworked from a modal sheet gated on two saved logs into a floating bar above the nav,
on every screen including the camera, until dismissed once.

The old gate existed because interrupting someone with a dialog has to be earned. A
bar that sits above the nav does not interrupt, so there is nothing to earn — and
waiting meant most people never met it. Identical on both platforms; only the final
action branches, and where there is no install API (iOS, or a browser that offers no
prompt) the Share-sheet steps are the fallback rather than a button that does nothing.

One dismissal, final and remembered — no snooze, because a nudge that returns is one
people learn to ignore. Afterwards the offer lives in Settings under "Home Screen",
shown whenever the app is not installed, which is where someone who changes their mind
will look.

`beforeinstallprompt` is captured at module load in `src/installPrompt.ts`, not in an
effect. Chromium fires it once and early, often before React mounts; an
effect-registered listener misses it and the install button then never appears at all.
