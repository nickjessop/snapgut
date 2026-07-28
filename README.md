# Food Snap 🍽️

A minimal, BeReal/Gas-style **PWA**: open the camera, snap your food, let Vertex AI
figure out what you ate, then one-tap how you felt. Everything stores on-device and
exports to CSV (which you can save to iCloud Drive via the iOS share sheet).

## How it works

```
Phone (installed PWA)
  → live camera → shutter
  → POST photo to /api/recognize
        → Cloud Run (Node/Hono) → Vertex AI Gemini Flash-Lite → { foods: [...] }
  → confirm foods → tap a mood → Save
  → entry saved in IndexedDB (on device)
  → "Export CSV" → iOS share sheet → Save to Files / iCloud Drive
```

- **Frontend:** Vite + React + TypeScript, installable PWA (`vite-plugin-pwa`).
- **Backend:** Hono on Node, serves the PWA *and* proxies Vertex AI so your GCP
  credentials never touch the browser.
- **AI:** `gemini-2.5-flash-lite` (cheapest multimodal). Change with `VERTEX_MODEL`.
- **Storage:** local-first (IndexedDB) + CSV export. No account, no cloud DB cost.

## Run locally

```bash
npm install

# Auth so the server can call Vertex AI with your user credentials:
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project-id
export VERTEX_LOCATION=us-central1   # optional, this is the default

npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` → the Node server
on :8080.

> Note: the live camera needs HTTPS or `localhost`. On `localhost` it works in the
> browser; on your phone during dev, use the deployed HTTPS URL below.

## One-time GCP setup

```bash
gcloud auth login                        # CLI access
gcloud auth application-default login    # credentials the app/scripts use locally
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com run.googleapis.com
```

## Food illustration pack (one-time, offline)

Food thumbnails come from our **own** Imagen-generated botanical illustrations in
`public/foods/` — generated once, committed, then served as static assets (no runtime
AI cost, no third-party image licensing). See `docs/security-and-infra-todo.md`.

```bash
node scripts/gen-food-images.mjs --dry-run     # list + cost estimate (~$5 for 247)
node scripts/gen-food-images.mjs --limit 5     # sanity-check the style first
node scripts/gen-food-images.mjs               # generate everything missing
```

Resumable and idempotent (existing files are skipped; `--force` overwrites). Edit the
food list in `scripts/food-list.txt` and the art direction via `STYLE` in the script —
keep `STYLE` fixed so the set stays visually cohesive. Bump `PACK_VERSION` in
`src/imageCache.ts` after adding images so clients re-check previously-missing foods.

## Deploy to Cloud Run (single container)

```bash
gcloud run deploy food-snap \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,VERTEX_LOCATION=us-central1
```

Cloud Run builds the Dockerfile, gives you an HTTPS URL, and scales to zero
(≈ free when idle). Vertex AI calls use the Cloud Run service account — grant it
the Vertex AI User role once:

```bash
PROJECT_NUM=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

## Install on your phone

1. Open the Cloud Run HTTPS URL in **Safari** (iOS) or Chrome (Android).
2. Share → **Add to Home Screen**.
3. Launch it from the home screen — full-screen, opens straight to the camera.

## Where's my data?

On your device, in the browser's IndexedDB. Tap **Log → Export CSV** to push a
`food-snap.csv` into the iOS share sheet and **Save to Files → iCloud Drive**.

### Want real cross-device sync later?

Swap the `src/db.ts` functions (`addEntry` / `getEntries`) for Firestore calls.
The rest of the app doesn't change — that's why storage is isolated in one file.

## Cost notes

- **Cloud Run:** scales to zero; you pay per request. Personal use ≈ pennies/month.
- **Vertex AI:** Flash-Lite is the cheapest multimodal tier; images are downscaled
  to 1024px square before upload to keep tokens/cost low.
