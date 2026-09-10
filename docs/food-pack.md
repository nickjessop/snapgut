# The food illustration pack

SnapGut ships its own set of food illustrations so ingredient thumbnails come from
same-origin static files rather than a third-party image API. The pack is **optional** and
distributed separately from the source, because it is large and because its licensing is
not the repository's licensing.

## What it is

- **3,036 WebP images**, one per food illustration, plus an MIT `LICENSE` file.
- About **66 MB** on disk once extracted. The download is **62,845,615 bytes**.
- Served by the app at **`/foods/<slug>.webp`**.
- A single consistent visual style across the whole set, so the collection reads as one
  thing rather than a pile of stock photos.

Coverage against `server/food-dict.json`, which holds **3,035** canonical foods:

| | Count |
| --- | --- |
| Canonical foods in the dictionary | 3,035 |
| Dictionary entries flagged as having an image (`img: 1`) | 3,034 |
| Images in the pack | 3,036 |
| Dictionary entries with no image | 1 (`neohesperidin`) |
| Images with no dictionary entry | 2 (`coriander`, `monosodium-glutamate`) |

The two extras exist because the client tries synonym slugs before giving up — `Cilantro`
resolves to `coriander`, for instance — so a few images are keyed to alias slugs rather
than to dictionary keys. It is close to one-image-per-food, not exactly one-to-one.

## It is optional

**The application is fully functional without the pack.** If you never download it:

- `FoodImage` (`src/FoodImage.tsx`) renders a generated **letter avatar** — the food's
  first initial on a background colour derived deterministically from its name.
- Nothing else changes. No feature is disabled, no request fails, no warning blocks boot.
  The server logs a food-pack count of 0 at startup and carries on.

That is the entire difference: letters instead of pictures.

## Fetching it

```
node scripts/fetch-food-pack.mjs
```

The script downloads the release archive to a temp file, verifies its SHA-256 **before**
extracting anything, and only then unpacks into the target directory. If the checksum does
not match it refuses and leaves the target directory untouched. Files that already exist
are skipped, so re-running is safe and cheap — a second run reports
`All files already present — nothing to extract.`

Set `FOOD_PACK_DIR` to extract somewhere other than `./food-pack`. The server reads the
same variable (`server/config.js`, default `./food-pack`), so point both at the same place:

```
FOOD_PACK_DIR=/srv/snapgut/food-pack node scripts/fetch-food-pack.mjs
FOOD_PACK_DIR=/srv/snapgut/food-pack npm start
```

Published asset for the current revision:

```
Release  food-pack-v1
Asset    food-pack-v1.tar.gz
SHA-256  1af6fda464d43e50fbf914e1b2cb89865ba84be70c1eacc1a0dc9c00809c0cbf
Size     62845615 bytes
```

`food-pack-v1` is an **asset-only tag**. It is not an application version and has no
relationship to the app's own `vX.Y.Z` releases; the `v1` counts revisions of the pack.

### While the repository is private

Release assets on a private repository are not anonymously downloadable. `fetch-food-pack.mjs`
makes an unauthenticated request, so today it fails with:

```
fetch-food-pack: Download failed: HTTP 404 Not Found
```

That is the expected behaviour right now, and the target directory is left untouched.
Until the repository is public, fetch the pack with an authenticated account:

```
gh release download food-pack-v1 --pattern 'food-pack-v1.tar.gz'
tar -xzf food-pack-v1.tar.gz -C ./food-pack
```

The archive has a flat layout — bare `<slug>.webp` entries at the root, no wrapping
directory — so extracting it straight into the pack directory is correct.

The script's own download path will work unchanged once the repository is public. **It has
not been exercised anonymously and remains untested until then.** The published asset and
the checksum constant in the script are both verified: the asset was downloaded with
authentication and its digest matches the value the script expects, byte for byte.

### Verifying by hand

```
shasum -a 256 food-pack-v1.tar.gz
tar -tzf food-pack-v1.tar.gz | wc -l   # 3037 (3036 images + LICENSE)
```

The archive is built reproducibly — sorted entry order, normalised mtime, `uid`/`gid` zeroed,
and `gzip -n` so no timestamp is embedded — so rebuilding it from the same images reproduces
the digest above exactly.

## Filename and slug convention

Every file is named `<slug>.webp`, where `<slug>` is normally a key in
`server/food-dict.json`. Slugs are produced by `slugify()` in `src/foodImages.ts`:
lowercased, every run of non-alphanumeric characters collapsed to a single hyphen, leading
and trailing hyphens trimmed. So `Wheat bread` becomes `wheat-bread.webp`.

The server validates every requested name against:

```
/^[a-z0-9-]+\.webp$/
```

in `server/foodPack.js`, with a maximum length of 128 characters, plus explicit rejection of
path-traversal forms including percent-encoded and null-byte variants. Files must sit
**directly** in the pack directory — subdirectories are not served, and symlinks pointing
outside the directory are flagged at boot by `surveyPack()`.

Practical consequence: a file whose name does not match that pattern is unreachable no
matter what it contains. Keep names lowercase, alphanumeric, and hyphenated.

## Provenance

The images were generated offline with **Google Vertex AI Gemini image models** by
`scripts/gen-food-images.mjs`.

> Note: the pack is sometimes described as Imagen output. It is not. That script explicitly
> avoids Imagen — Google deprecated those models with a shutdown date of 2026-08-17 and they
> already 404 on new projects — and uses the Gemini image models instead. Its header
> documents this.

`gen-food-images.mjs` is kept **for provenance, not for use**. It is not part of the build,
no npm script invokes it, and nothing in the app imports it. It will not run against a plain
checkout: it needs Google Cloud credentials and Vertex AI access, and its dependencies
(`@google-cloud/vertexai`, `google-auth-library`) are not installed by default.

Generation is deliberately an offline, one-time step. The app then serves static files with
no runtime AI cost and no per-request dependency on an image provider.

## Licensing — MIT

**The pack is licensed under the MIT License**, deliberately more permissive than the
application. The code is AGPL-3.0-or-later because a self-hosted app should stay copyleft;
the illustrations are MIT because there is no reason to restrict who reuses a picture of a
carrot.

The licence ships **inside the archive** as a `LICENSE` file, so it travels with the images
rather than living only in this repository. After extraction it sits in the pack directory
next to the WebP files, where it is inert — the server only serves names matching
`^[a-z0-9-]+\.webp$`.

Practically: use them, modify them, redistribute them, ship them in something commercial.
Keep the copyright notice with them.

Two honest caveats, also recorded in the archive's own `LICENSE`:

- **MIT is a software licence being applied to image assets.** That is common practice and
  the intent is unambiguous, but it was not drafted for artwork. If you need artwork-native
  terms, CC0 or CC-BY are the conventional choices and nothing stops a downstream project
  from relicensing its own derived set.
- **The images are AI-generated**, produced with Vertex AI Gemini image models. The copyright
  status of AI-generated output is unsettled in several jurisdictions, so this licence grants
  what can be granted and makes no warranty about third-party rights. That is a statement
  about the state of the law, not a known defect in these files.

Independently of the licence, two facts keep the pack from being load-bearing:

1. The app works with **no pack at all** — you get letter avatars, as described above.
2. **Any directory of correctly named WebP files can substitute.** Point `FOOD_PACK_DIR` at
   your own images named `<slug>.webp` and the server will serve them.
