# Datastore

Every Firestore collection the server writes: its document key, its fields, whether it holds
personal data, and what expires it. Satisfies Requirements 19.2, 19.3, 19.4, 19.6, and 19.7 in
`.kiro/specs/marketing-site-and-routing/`. `infra/firestore.ts` is the machine-readable form of
the database and its TTL policies; this document is the explanation.

Compiled by reading `server/store.js`, `server/index.js`, and `server/eventStore.js`, and by
querying the live database, not from a previous version of this file.

## The database

`projects/REDACTED-GCP-PROJECT/databases/(default)` — Native mode, `us-central1`, pessimistic
concurrency, App Engine integration disabled. Declared and imported in `infra/firestore.ts`
with `protect: true`, so an ordinary `pulumi up` or `destroy` cannot remove it.

`USERS_BACKEND` selects it. Only the exact value `firestore` does; anything else selects a
per-process in-memory map that loses everything on the next deploy, which is why production
refuses to boot without it (see `docs/configuration.md`). Local development and the test suite
run on the in-memory backend with no configuration at all, and it has no TTL concept — expiry
is a Firestore-only concern, and the memory backend's rate limiter is a sliding window over an
array in memory.

**Recovery posture: none configured.** No point-in-time recovery, no scheduled backup
(Requirement 19.8, Decision D12). The reasoning and the one-line change that reverses it are in
`infra/firestore.ts`.

## The collections

| Collection | Document key | Fields | Personal data | Expiry |
| --- | --- | --- | --- | --- |
| `users` | the normalised email address | `email`, `pro`, `proUntil`, `freeAiUsed`, `stripeCustomerId`, `createdAt` | **Yes** — the email address, both as the key and as a field | None. Removed only by `/api/account/delete` |
| `authCodes` | the normalised email address | `hash` (SHA-256 of the six-digit code), `expiresAt` (epoch ms), `attempts` | **Yes** — the email address is the key | None. Overwritten per request, deleted on verify and on account deletion. See the gap below |
| `rateLimits` | `<limit key>:<window bucket>` | `count`, `expireAt` (Timestamp) | **Yes, in the key** — the auth limits embed an email address or an IP address | TTL on `expireAt`, one window past the end of the window it counts |
| `missingFoods` | the food slug | `slug`, `reason` (`no_image` \| `unknown`), `count`, `lastSeen` (epoch ms), `expireAt` (Timestamp) | No — aggregate tallies, never linked to a user (Requirement 19.5) | TTL on `expireAt`, 90 days after the last sighting |

Two subcollections under `users/<email>` belong to the cloud-sync feature and are specified in
`.kiro/specs/cloud-sync/`, not here: `users/<email>/events` (stored Event_Records and
tombstones) and `users/<email>/sync/meta` (the sequence and purge epoch). They are named here
only so this table is not read as the whole picture. Note that deleting a `users` document does
**not** delete its subcollections, which is why `/api/account/delete` purges events first and
removes the user record second.

### `users`

The record of the account and of Pro entitlement, written by `upsertUser`, `setPro`, and
`incFreeAi`. It holds no logs, no photos, and no profile fields.

**It holds personal data and is in scope for account deletion** (Requirement 19.7).
`POST /api/account/delete` purges the caller's stored events, then `deleteUser(email)` removes
`users/<email>` and `authCodes/<email>` together. Nothing else in this database is keyed by an
account, apart from the `rateLimits` documents described below, which expire on their own within
a couple of minutes.

`stripeCustomerId` is queried with a single-field equality filter (`getUserByStripeCustomerId`,
the join a renewal webhook needs). Firestore's automatic single-field index serves it; the note
in `server/store.js` records what would change that.

### `authCodes`

One document per sign-in attempt in flight, keyed by the address the code was sent to. The code
itself is never stored — only its SHA-256 hash, its ten-minute expiry, and the attempt count
(five attempts, then the code is dead).

**Known gap, deliberately not fixed here.** `expiresAt` is application-enforced, not a TTL
field, and there is no TTL policy on this collection because the normal path deletes the
document on verify. An *abandoned* sign-in therefore leaves one document holding an email
address and a dead code hash indefinitely. It is bounded by the per-email throttle (one code per
30 s) and by being overwritten per address rather than accumulating, and the live database holds
exactly one such document today. Requirement 19 does not classify `authCodes` as a
Transient_Collection, so adding a TTL policy would be a scope change rather than a fix; it is
recorded here as the honest state and is worth doing.

### `rateLimits`

Fixed-window counters, shared across Cloud Run instances so a limit is a limit and not a limit
per instance. A request at instant `t` with window `w` reads and writes
`<key>:<floor(t / w)>` and increments `count` in a transaction.

Keys in use:

| Key | Limit | Where |
| --- | --- | --- |
| `auth-ip:<Client_IP>` | 20 per 60 s | `/api/auth/*`, `server/index.js` |
| `auth-email:<email>` | 1 per 30 s | `/api/auth/request`, `server/index.js` |
| `sync-ip:<Client_IP>` | 120 per 60 s | `/api/sync/*`, `server/sync.js` |
| `sync-user:<email>` | 60 per 60 s | `/api/sync/*`, `server/sync.js` |

**So the document key carries personal data** — an email address or an IP address — even though
the document body is a single integer. That is what makes the expiry a privacy property as well
as a storage one, and the reason the collection is not a place to add a longer retention window
later.

**Expiry (Requirement 19.4): `(bucket + 2) × windowMs`.** The document for bucket `b` is
consulted only by requests in `[b×w, (b+1)×w)`, so it stops being able to affect a limit
decision at exactly `(b+1)×w`, when the key rolls over and a fresh document takes over. That
instant is the earliest correct expiry; the value written is one whole window later. The margin
is deliberate and asymmetric, because the two failure directions are not equally bad:

- expiring **early** deletes a live counter, so requests already counted stop counting and the
  limit silently widens — a security regression, and an invisible one;
- expiring **late** keeps one document holding one integer for one extra window.

The bucket comes from the calling instance's clock while the deletion is scheduled against
Firestore's, so a margin is the only thing that makes skew between them harmless. Firestore also
deletes at or after the timestamp, never before, and in practice within 24 hours rather than
promptly — so the margin costs nothing measurable.

The expiry is derived from the bucket rather than from `Date.now()`, which makes it identical for
every write in a window: the merge never moves it, and the value is a pure function of the key.
`rateLimitWindow` in `server/store.js` is that function, and `src/rateLimitExpiry.test.ts` pins
the bound.

**`expireAt` must be a Firestore `Timestamp`.** A TTL policy ignores a field of any other type,
so the numeric `Date.now() + windowMs` this code used to write meant the policy was attached and
expired nothing. Eight such documents existed in production, all from finished windows and all
permanently orphaned — the key includes the bucket, so a later request never overwrites them —
and they were deleted as a one-off after the fix, guarded to numeric `expireAt` values already
in the past. The collection is empty as of 2026-07-31.

### `missingFoods`

The Coverage_Tally: which logged foods have no illustration yet, so the next generation batch
knows what to draw. Written fire-and-forget from `annotateIngredients` and from the `/foods/*`
404 path, and only for slugs that are real canonical Food_Dictionary entries, so the client's
slug-variant probing does not pollute it.

Aggregate only — slug, reason, count, timestamp. No email, no session token, no reference to an
event (Requirement 19.5). `/api/admin/missing-foods` serves exactly those four fields;
`expireAt` is stripped from the response so the two backends return the same shape.

Every write pushes `expireAt` 90 days out, so a food that is still being logged never expires
and one that stopped being logged ages out. Existing documents pick up the field on their next
write, since the write merges.

**Index (Requirement 19.6): none needed.** The only non-trivial query is
`orderBy("count", "desc").limit(n)`. Firestore's default field configuration indexes every field
ascending, descending, and array-contains at collection scope, so an automatic single-field index
serves it. Verified: `gcloud firestore indexes composite list` returns `[]`, and
`gcloud firestore indexes fields list` shows only the `__default__` wildcard with no exemption.

## Verifying the state

```bash
# TTL policies: both should report ACTIVE on expireAt
gcloud firestore fields ttls list --collection-group=rateLimits \
  --database='(default)' --project=REDACTED-GCP-PROJECT
gcloud firestore fields ttls list --collection-group=missingFoods \
  --database='(default)' --project=REDACTED-GCP-PROJECT

# Native mode, location, and recovery posture
gcloud firestore databases describe --database='(default)' --project=REDACTED-GCP-PROJECT

# Indexes: an empty composite list and only the __default__ field config are expected
gcloud firestore indexes composite list --database='(default)' --project=REDACTED-GCP-PROJECT
gcloud firestore indexes fields list --database='(default)' --project=REDACTED-GCP-PROJECT
```

A TTL policy is only as good as the type of the field it points at. If `rateLimits` starts
growing, check that first: read one document and confirm `expireAt` is a Timestamp and not a
number.
