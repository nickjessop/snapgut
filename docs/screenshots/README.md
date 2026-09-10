# Screenshots

The four images in this directory are the ones the root [README](../../README.md) displays.
They are captured from a real build of the app, driven by Playwright at 390×844 CSS pixels —
the iPhone 14/15 logical viewport — rendered at device pixel ratio 2, so each file is
780×1688.

## What is real and what is staged

Worth being precise, because a screenshot is a claim about the software.

**Real:** the app itself. Every pixel of interface is a genuine build of this repository
running against the real server, reading real records out of IndexedDB and computing every
number on screen with the shipped analysis code. The ranks on the Foods screen come from
`src/foodScores.ts` evaluating the seeded diary — they were not chosen, and the thresholds
were not relaxed to produce them. The ingredient illustrations are the real food pack served
from `/foods/<slug>.webp`.

**Staged:** the diary contents, and the camera feed.

- **The diary is generated**, not a real person's log. It spans 24 days, 85 meals and 12
  symptom entries, written straight into IndexedDB. It is shaped so the evidence gates in
  `src/foodScores.ts` and the focus routing in `src/insights.ts` are genuinely satisfied —
  a food needs at least four settled exposures before it can be ranked at all, so an
  under-populated diary would only ever show "Need more data".
- **The written insight is authored**, seeded into the `insightHistory` key of the `meta`
  store rather than generated. The `mock` AI provider returns short fixed templates, which
  are correct for testing and thin for a screenshot. Nothing in the images was produced by a
  hosted model, and no request left the machine.
- **The camera feed is injected.** A headless browser has no camera, so `getUserMedia` is
  replaced with a canvas `captureStream()` painting a photograph of a meal. The app receives
  a genuine `MediaStream` and renders its ordinary viewfinder; without this the capture
  screen is simply black.

Symptom entries were deliberately kept to the presentable end of the taxonomy in
`src/symptoms.ts`. The app supports considerably more than is shown.

## Photograph licensing

The meal photographs — the camera viewfinder, and the thumbnails on the timeline — are from
[Unsplash](https://unsplash.com) under the [Unsplash License](https://unsplash.com/license),
which permits use and modification, commercially, without attribution. They are **not**
covered by this repository's AGPL-3.0-or-later licence, which applies to the code.

They appear only in these four files. Nothing under `public/` or in the built application
contains them, and the app ships no photographs of its own — a real install shows the user's
own photos and nothing else.

If you would rather the project did not carry third-party imagery at all, substitute your own
meal photographs and re-run the capture; nothing else has to change.

## Regenerating them

The harness is not checked in, because it exists to produce four files and would otherwise be
a second copy of the demo data to keep in step with the schema. Reproducing it needs:

1. A build and a server with the mock provider and the food pack:

   ```bash
   npm run build
   AUTH_PASSWORD=demo-password-1234 AI_PROVIDER=mock DATASTORE_BACKEND=memory \
     FOOD_PACK_DIR=./food-pack PORT=8899 BIND_HOST=127.0.0.1 node server/main.js
   ```

2. Meal photographs reachable **same-origin** — copied into `dist/img/demo/` is easiest.
   Cross-origin images taint the canvas, which breaks `captureStream()`, and the page's
   `img-src` policy would reject them anyway.

3. A Playwright context at `viewport: { width: 390, height: 844 }`,
   `deviceScaleFactor: 2`, `isMobile: true`, with the `camera` permission granted, and an
   init script that:
   - sets `food-snap-onboarded` in `localStorage`, or you capture the onboarding carousel;
   - sets `food-snap-last-backup` to now, or a backup nudge appears on the timeline;
   - replaces `navigator.mediaDevices.getUserMedia` with a canvas stream as described above.

4. Records written directly into the `food-snap` IndexedDB database, version 3, `events`
   store — see `src/db.ts` for the shapes. `createdAt` is indexed and a record without it is
   invisible to the whole UI. Set `outcome: "fine"` on symptom-free meals so they settle as
   evidence rather than sitting unobserved, which also keeps the "How did these sit?" card
   out of the frame.

Two traps worth knowing. Generate timestamps in the same timezone the browser context uses,
or every entry shifts and a 19:00 dinner renders as "0:00" the next day. And take the shots
against the Node server rather than the Vite dev server, which does not proxy `/foods` — the
food illustrations would all fall back to letter avatars.
