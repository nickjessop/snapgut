# Marketing_Site accessibility — pre-launch checklist

Requirement 10.9 of the `marketing-site-and-routing` spec splits Requirement 10 in two. Three
criteria are decidable from the markup and are asserted on every build; the other five need a
browser, a real keyboard, and a screen reader. **This checklist is the sign-off for those five.**
It has to be completed against the deployed Canonical_Host before the DNS cutover of task 11 is
announced, and re-run whenever a Marketing_Page's copy, the shared partials, or
`marketing/marketing.css` change.

Scope: the five public documents the build emits — `/`, `/pricing`, `/privacy`, `/terms`, and the
not-found document. The App_Shell is out of scope here; it is `noindex` and behind sign-in.

## Already asserted by the test suite — do not re-check by hand

`src/marketing.a11y.test.ts` runs against `dist/`, derives its page set from `shared/site.js`, and
fails the suite on a regression:

- **10.2** `header`, `nav`, and `footer` landmarks present; exactly one `main`, outside the header
  and footer; no body heading or paragraph outside all four; the skip control's `href` resolves to
  that one `main`.
- **10.3** Headings start at `h1` and skip no level.
- **10.4** Every `img` (and any `area` or `input[type=image]`) carries an `alt`; no `alt` merely
  repeats a filename; no unnamed inline `svg`.

What that does **not** cover: whether an `alt` is the *right* text, and whether an image marked
decorative really is. Both are judgement calls and belong to the screen-reader pass below.

## Verified already — confirm still true, then tick

These were measured during task 5.1 (2026-07-30) and the values are recorded in the header comment
of `marketing/marketing.css`, which is the file that ships them. Re-confirm against the live host
rather than re-deriving; if a colour token in `marketing.css` has moved, re-measure.

- [ ] **10.6 — Contrast, body text ≥ 4.5:1.** Measured on the cream `#fdfcf6` background:
      body `#1f3a30` **11.98:1**, headings `#14261f` **15.40:1**, muted `#4d6a5e` **5.77:1**
      (**5.15:1** on the `--cream-100` `#f3efe0` footer, **5.10:1** on the `#e4f1e9` mint panel),
      links `#2d5d4d` **7.34:1**, link hover `#23453a` **10.30:1**.
      Note the deliberate choice: the app palette's `--ink-300` `#5e7a6e` is only 4.56:1 on cream
      and **4.07:1 on the footer**, so muted text on this site uses `#4d6a5e` instead. A change
      back to `#5e7a6e` fails this criterion on the footer.
- [ ] **10.6 — Contrast, large text and non-text control parts ≥ 3:1.** Accent/eyebrow
      `#9c421f` **6.36:1**; primary button `#fdfcf6` on `#2d5d4d` **7.34:1**; secondary button
      border `#2d5d4d` on cream **7.34:1**; focus ring `#9c421f` on cream **6.36:1**.
      The focus ring is drawn with a 2 px offset so it always lands on a light surface — against
      the dark green button fill it would measure 1.15:1. Verify the offset survived any CSS edit.
- [ ] **10.7 — 320 CSS px, no horizontal page scroll.** Checked in a real browser at 320 × 640:
      `document.scrollWidth === document.clientWidth` on every page. Re-check with the real
      content, since this is a property of the longest unbroken token on the page (a URL in
      `/privacy` is the usual culprit — `overflow-wrap: break-word` on `body` is what handles it)
      and of the pricing table, which scrolls its own `.table-scroll` container rather than the
      page.
- [ ] **10.1 — Skip control, browser behavior.** Checked in a real browser: the skip link is the
      **first tab stop**, is visible on focus with the terracotta ring, and pressing Enter moves
      focus to `MAIN#main`. Re-check on the live host — a header edit is the thing that breaks the
      "first tab stop" half.

## Not yet verified — needs a real browser and assistive technology

- [ ] **10.5 — Keyboard operability, desktop.** Tab through each page start to finish: every link
      and button is reachable, in a sensible order, with a visible focus indicator, and activates
      on Enter (and Space for buttons). Nothing is a `div` with a click handler today — links and
      buttons only — so one `:focus-visible` rule covers all of it. Confirm no focus trap and no
      element that receives focus without showing it.
- [ ] **10.5 — Keyboard operability, iOS Safari and Android Chrome.** With an external keyboard,
      confirm the same order and that the header CTA that spans the row below 380 px is still
      reachable in place.
- [ ] **10.8 — `prefers-reduced-motion`.** With the OS setting on (macOS: Accessibility → Display →
      Reduce motion), confirm the anchor scroll from the skip link is instant, the button press
      nudge is gone, and no transition remains. The stylesheet's `@media (prefers-reduced-motion:
      reduce)` block is the mechanism; the check is that nothing outside it animates.
- [ ] **Screen-reader pass — VoiceOver (macOS Safari).** Per page: the landmark rotor lists
      banner / navigation / main / contentinfo; the heading rotor reads as a sensible outline; the
      two `nav` elements are distinguishable by their `aria-label` ("Main" and "Footer"); the
      brand mark is silent (its `alt` is empty because it is decorative — confirm that is still the
      right call); every link's text makes sense read out of context.
- [ ] **Screen-reader pass — VoiceOver (iOS).** Same, plus: the skip control is announced and
      usable via the rotor.
- [ ] **Zoom to 200%** at a 1280 px viewport: no clipped text, no overlap, no horizontal scroll.
- [ ] **Forced-colors / Windows high contrast** spot check on one page: the `.checklist` ticks are
      CSS borders and will disappear; confirm the list still reads correctly without them.

## Out of scope for this checklist

Full WCAG 2.2 AA conformance is not claimed. What is claimed is that the three structural criteria
hold on every build and that the five criteria above were reviewed by a person against the live
host. Anything found during the passes above that is not one of these criteria gets filed rather
than fixed silently here.

## Sign-off

| Field | Value |
| --- | --- |
| Reviewer | |
| Date | |
| Host reviewed | |
| Build / revision | |
| Findings filed | |
