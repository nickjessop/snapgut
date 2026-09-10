# Operations

Running an instance after it starts: reading the boot summary, health checks, what the logs do
and do not contain, backups you have verified, restores, secret rotation, moving to new
hardware, upgrades, and the failure modes SQLite actually produces.

Settings are documented in [configuration.md](configuration.md); the schema is documented in
[datastore.md](datastore.md).

## Reading the boot summary

`server/main.js` prints one block after the listener is up. A healthy start looks like this:

```text
snapgut listening on http://0.0.0.0:8080
  datastore  sqlite (/data/snapgut.db)
  ai         ollama (http://127.0.0.1:11434, llama3.2-vision)
  food pack  3036 files (./food-pack)
  session    secret loaded from /data/session-secret
  auth       AUTH_PASSWORD set
```

| Line | What it tells you | What to check when it looks wrong |
| --- | --- | --- |
| `listening on` | The bind host and port the process actually bound. Inside Docker this is `0.0.0.0` by design | If it says `127.0.0.1` in a container, `BIND_HOST` is being overridden — nothing outside the container will reach it |
| `datastore` | Backend and, for `sqlite`, the resolved database path | `memory` here means every entry is lost on restart. Check `DATASTORE_BACKEND`. A surprising path means `DB_PATH` or `DATA_DIR` |
| `ai` | Provider, base URL, and model | `AI_MODEL` is required for every provider except `mock`, so a boot that got this far has one. `default model` can only appear for `mock` with an explicit `AI_BASE_URL` — see [ai-providers.md](ai-providers.md) |
| `food pack` | How many `.webp` files were found in `FOOD_PACK_DIR` | `0 files` means foods render as letter avatars. Harmless, but check the path if you expected illustrations |
| `session` | Whether the secret came from `SESSION_SECRET`, from the persisted file, or was generated now | `generated at ...` on a second boot means the previous file was lost, and every issued token is now invalid |
| `auth` | One of three lines — see below | Anything other than `AUTH_PASSWORD set` means sign-in is closed. Only a loopback bind reaches those states; an exposed bind refuses to boot without a valid password |

### The auth line

Three states, not two, because `AUTH_PASSWORD` being unusable is not the same thing as it being
unset:

| Line | What it means | Sign-in |
| --- | --- | --- |
| `AUTH_PASSWORD set` | A usable credential — at least 12 characters after trimming | Works |
| `no password (sign-in disabled)` | Nothing was configured | Rejected, every request |
| `AUTH_PASSWORD set but unusable (under 12 characters) — sign-in disabled` | Something was configured and thrown away | Rejected, every request |

The distinction matters because the two closed states need different responses. The first is a
deliberate choice on a loopback instance, and nothing is wrong. The second is a typo or a
too-short password, and the fix is to lengthen it — the value you set is having no effect at all,
and the `warning:` line above the summary says the same thing. Both cases reject every sign-in
with the same `401 {"error":"signin_failed"}` a wrong password gets, so the summary is the only
place the difference is visible.

Neither line reveals the credential or its length, and neither does the warning.

Lines that appear before the summary:

- `warning: ...` — non-fatal config warnings from `loadConfig`, printed before the datastore
  opens. Currently: an `AUTH_PASSWORD` shorter than 12 characters on a loopback bind (sign-in
  will reject everything), and the memory backend with an exposed bind.
- `food-pack: ...` — the pack directory is unreadable or absent, or a symlink in it points
  outside the directory.
- `Session secret generated and written to: <path>` — first run, or the secret file is gone.

Failures exit 1 **before** the listener starts, each with its own prefix: `config error:`,
`secret error:`, `ai config error:`, `Fatal: cannot open database at ...`, or `fatal boot error:`
for anything unanticipated. If you see no summary and no error, the process is not the thing that
failed — check the container or unit is actually running.

## Health checks

```bash
curl -s http://127.0.0.1:8080/api/health
```

```json
{"ready":true,"schema":1}
```

- Unauthenticated, and deliberately so — a monitor needs no credential.
- `ready` is a mutable cell flipped to `true` in the `serve()` callback, after the datastore is
  open and the route tree is built. A request that arrives while the process is still booting is
  answered `{"ready":false,...}` rather than being dropped.
- `schema` is the schema generation the server code expects. It is a literal `1` in
  `server/app.js`, not a read of `schema_meta` — treat it as "which shape of database this build
  speaks", not as a live query.

Because every boot failure exits before listening, a refused connection and a `ready: false`
answer mean different things: refused means the process is not up, `ready: false` means it is up
and still starting.

The compose healthcheck already uses this endpoint every 30 s with a 30 s start period. For an
external monitor, treat HTTP 200 with `ready: true` as healthy.

With `REQUIRE_HTTPS=1` the global guard rejects any request without `X-Forwarded-Proto: https`,
health checks included. The shipped compose healthcheck sends that header for exactly this reason,
so it stays green in both configurations — keep it if you replace the command. An external monitor
arrives through your proxy, which sets the header itself, so it needs nothing extra. See
[deployment.md](deployment.md).

## Logs

Everything goes to stdout and stderr. `docker compose logs -f` or `journalctl -u snapgut -f`.

What the server writes:

| Line | Shape | When |
| --- | --- | --- |
| Boot summary | The block above | Once, at start |
| `ai` | `ai { provider, kind, outcome, elapsedMs }` | Once per `/api/recognize` and `/api/insights` call |
| `sync` | `sync method=… path=… status=… records=… user=… reason=… error=…` | Once per `/api/sync/*` and `/api/account/delete` request |
| `food pack read error: <file>` | Filename only | A pack file exists but cannot be read (answered 502) |
| `recognize error:` / `insights error:` | Prefix plus the error object | An unexpected failure outside the AI call itself (answered 500) |

What is deliberately absent: prompts, images, note text, dish names, symptom data, passwords,
session tokens, `AI_API_KEY`, and the session secret's value. The two mechanisms are worth
knowing separately:

- The `ai` line is constructed from four fixed fields — `provider`, `kind`, `outcome`,
  `elapsedMs` — and the model's response text is never passed to a logger.
- The `sync` line is built in exactly one function (`logSyncRequest` in `server/sync.js`) from a
  fixed field vocabulary the module derives itself: the method and `c.req.path` (never the query
  string, where a cursor would be), the response status, a counted integer, the verified email
  from the token, a fixed reason code, and — for a caught error — the error's **class name**
  only, never its message, stack, or the value thrown. A record's content cannot reach it. Every
  value is also reduced to printable ASCII with whitespace collapsed and truncated, so nothing
  can forge a second line.

One honest exception: the `recognize error:` and `insights error:` lines log the error object
itself. Those fire on unexpected failures outside the AI call — most often a malformed request
body — and a JSON parse error message can quote a short fragment of the input it choked on.
Treat those two lines as diagnostic output rather than as part of the redaction guarantee.

There is no analytics, crash reporter, or remote log destination anywhere in `server/`.

## Backups

### What lives in DATA_DIR

| Path | What it is | Needed to restore? |
| --- | --- | --- |
| `${DATA_DIR}/snapgut.db` | The whole datastore: account, events, sync metadata, rate limits, missing-food tallies | Yes |
| `${DATA_DIR}/snapgut.db-wal` | Write-ahead log — committed transactions not yet checkpointed | Yes, if copied while running |
| `${DATA_DIR}/snapgut.db-shm` | Shared-memory index for the WAL | Regenerated; copy it anyway |
| `${DATA_DIR}/session-secret` | Generated HMAC key, mode 0600 | Only if you want existing sign-ins to survive |

`DB_PATH` can move the database out of `DATA_DIR`; check the boot summary's `datastore` line for
the real path.

### Hot copy (server running)

Use SQLite's own backup, which takes a consistent snapshot across the database and its WAL:

```bash
sqlite3 ./data/snapgut.db ".backup './data/backup-$(date +%F).db'"
```

No `sqlite3` binary? Node 24 has SQLite built in, so the container can do it:

```bash
docker compose exec snapgut node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/snapgut.db');
  db.exec(\"VACUUM INTO '/data/backup.db'\");
  db.close();
"
```

`VACUUM INTO` takes a consistent snapshot and writes a self-contained file with no WAL alongside
it. The destination must not already exist — SQLite answers `output file already exists` rather
than overwriting, so use a dated filename or remove the old one first.

Do **not** simply `cp` the `.db` file while the server is writing. With WAL mode the file alone
can be missing recent commits, and a copy taken mid-write can be torn.

### Cold copy (server stopped)

```bash
docker compose down
cp ./data/snapgut.db      ./data/backup.db
cp ./data/snapgut.db-wal  ./data/backup.db-wal 2>/dev/null || true
cp ./data/snapgut.db-shm  ./data/backup.db-shm 2>/dev/null || true
cp ./data/session-secret  ./data/session-secret.bak
docker compose up -d
```

Copy the `-wal` file with the database or drop both together. A database paired with a stale WAL
from a different point in time is worse than either alone.

### Verify the backup

A backup you have not opened is a hope, not a backup. Three checks, in order:

```bash
# 1. Structural integrity — must print exactly "ok"
sqlite3 ./data/backup.db "PRAGMA integrity_check;"

# 2. Open it read-only and confirm the expected tables are present
sqlite3 "file:./data/backup.db?mode=ro" ".tables"
# expect: events  missing_foods  rate_limits  schema_meta  sync_meta  users

# 3. Confirm the data is there, and the schema version
sqlite3 "file:./data/backup.db?mode=ro" \
  "SELECT (SELECT value FROM schema_meta WHERE key='version') AS schema_version,
          (SELECT COUNT(*) FROM users)  AS users,
          (SELECT COUNT(*) FROM events) AS events;"
```

Compare the event count against the live database. If the live instance has never synced,
`events` is legitimately 0 — the diary lives in the browser until Cloud sync is switched on.
Table names and the `schema_meta` version come from `server/sqlite/schema.js`; the columns are
documented in [datastore.md](datastore.md).

### The caveat that matters most

**Meal photos are not in a server-side backup.** They live only in the browser's IndexedDB
(`food-snap`, version 3) on each device. The sync wire format has no photo field and the server
rejects payloads carrying photo-shaped data, so no server backup can contain them — see
[cloud-sync.md](cloud-sync.md).

The in-app export is the only thing that captures photos: Settings → Backup writes one JSON file
with the whole timeline and photos inlined as base64 data URLs, and the same screen restores
from it. Tell every user of the instance to take one periodically.

A server-only restore brings back events, not photos. If the device that held them is gone and
no in-app backup exists, the photos are gone.

## Restore

Into the same install:

```bash
docker compose down
cp ./data/backup.db ./data/snapgut.db
rm -f ./data/snapgut.db-wal ./data/snapgut.db-shm
docker compose up -d
curl -s http://127.0.0.1:8080/api/health
```

Removing the stale `-wal` and `-shm` matters: they belong to the database you just replaced. A
`.backup`/`VACUUM INTO` snapshot is already self-contained.

Into a fresh install:

1. Clone the repo and create `.env` as in the root [README](../README.md). Use the **same**
   `AUTH_EMAIL` — the account row is keyed on the email, and a different one leaves the restored
   events attached to an account you cannot sign in as.
2. `mkdir -p ./data` and copy the backup in as `snapgut.db`.
3. Copy `session-secret` too if you want existing devices to stay signed in. Otherwise let the
   server generate a fresh one and sign in again on each device.
4. `docker compose up -d`, then check the boot summary and `/api/health`.
5. On a device, sign in and pull. Sync cursors are stored per device and remain valid as long as
   the account's purge epoch has not changed, which a restore does not change.

Migrations run automatically at boot, so restoring an older database into a newer build upgrades
it in place. There is no down path — see Upgrades below.

## Rotating SESSION_SECRET

The secret is the HMAC key for session tokens (`server/auth.js`, HMAC-SHA256, 30-day expiry).
Rotating it invalidates **every** issued token immediately: `verifyToken` recomputes the
signature with the new key, the comparison fails, and every device gets a 401 and is signed out.
Nothing else is affected — no data is touched.

Rotate when the secret may have leaked, or to force every device to re-authenticate.

If the secret is managed by the server (the usual case):

```bash
docker compose down
rm ./data/session-secret
docker compose up -d
```

The next boot generates a fresh 32-byte value, writes it with mode 0600, and logs the path.

If you set `SESSION_SECRET` explicitly, replace it in `.env` with at least 32 characters and
restart. The server refuses to boot on a shorter value.

```bash
openssl rand -hex 32
```

Note the precedence: an explicit `SESSION_SECRET` always wins, so deleting the file changes
nothing while that variable is set.

## Changing or recovering AUTH_PASSWORD

There is no password reset flow and no password hash in the database. The password is only an
environment variable, so changing it is editing `.env` and restarting:

```bash
# edit AUTH_PASSWORD in .env — at least 12 characters
docker compose up -d --force-recreate
```

**Existing sessions survive a password change.** Verified in `server/auth.js` and
`server/app.js`: `signToken`/`verifyToken` sign and check tokens with the session secret only,
and the password is never part of the token payload. `credentialMatches` uses the secret as an
HMAC key to compare submitted and expected credentials in constant time, but that runs only at
sign-in. So a changed password affects future sign-ins, not current ones. To sign existing
devices out as well, rotate `SESSION_SECRET` too.

Recovering a forgotten password is the same operation — set a new one. Nothing is lost.

Two behaviours worth knowing:

- A password shorter than 12 characters after trimming is treated as absent. On a loopback bind
  that means a warning and sign-in rejecting everything with `401 signin_failed`; on an exposed
  bind the server refuses to boot. The boot summary's `auth` line distinguishes this from having
  configured nothing at all — see [the auth line](#the-auth-line).
- Sign-in is rate limited to 20 requests per 60 s per derived client address, keyed
  `auth-ip:<address>`. Locked out by your own testing? Wait out the window — the counter is a
  fixed 60 s bucket in the `rate_limits` table.

## Moving an install to new hardware

The whole state is one directory.

```bash
# on the old host
docker compose down
tar czf snapgut-data.tar.gz -C ./data .

# copy it across
scp snapgut-data.tar.gz newhost:/opt/snapgut/

# on the new host, in a clone of the repo with your .env in place
mkdir -p ./data
tar xzf snapgut-data.tar.gz -C ./data
```

Then fix ownership so the container user can write. The container runs as the non-root `snapgut`
user, whose UID and GID are pinned to **10001** in the `Dockerfile`:

```bash
sudo chown -R 10001:10001 ./data
docker compose up -d
```

Verify, in this order:

1. The boot summary shows `datastore sqlite (/data/snapgut.db)` and the expected `session` line.
   `generated at ...` means the secret did not come across, and every device will be signed out.
2. `curl -s http://127.0.0.1:8080/api/health` returns `{"ready":true,"schema":1}`.
3. Sign in from a device, then run a sync and confirm the timeline matches.
4. Only then decommission the old host.

If you tar as root and extract as root, ownership inside `./data` will be root's. That produces
the not-writable failure below, not a silent problem.

## Upgrades

```bash
# 1. verified backup first — see above
sqlite3 ./data/snapgut.db ".backup './data/pre-upgrade.db'"
sqlite3 ./data/pre-upgrade.db "PRAGMA integrity_check;"

# 2. new code
git pull

# 3. rebuild and restart
docker compose up -d --build
```

Schema migrations are applied automatically at boot by `migrate()` in
`server/sqlite/schema.js`. Confirmed by reading that file: it holds an ordered array of
migrations, reads `schema_meta.version`, applies each pending migration inside its own
transaction, and has **no down migrations**. A migration that throws rolls back its own
transaction and the boot fails; earlier migrations in the same run stay applied.

Forward-only means the pre-upgrade backup is your only rollback. Downgrading the code without
restoring the database leaves a newer schema under an older build, which is untested.

After an upgrade, check the boot summary for new warnings — a release can add a setting or make
a previously tolerated value fatal.

## SQLite troubleshooting

### `database is locked` / `SQLITE_BUSY`

`migrate()` sets `PRAGMA busy_timeout = 5000`, so a writer waits up to 5 seconds for a lock
before failing rather than erroring immediately. Seeing the error means something held a write
lock longer than that. Realistic causes:

- **Two servers on one database file.** A second container, or a stray `node server/main.js` from
  development, pointed at the same `DB_PATH`. Only one instance should own a file.
- **An interactive `sqlite3` session with an open transaction.** Exit it. A `BEGIN` left open
  blocks writers indefinitely.
- **The database on a network filesystem.** NFS and SMB do not implement the locking SQLite
  needs. Keep the file on local storage.

### WAL files

`snapgut.db-wal` and `snapgut.db-shm` next to the database are normal in WAL mode, not a fault. A
WAL that keeps growing means checkpoints are not completing, usually because a long-lived reader
never releases. Clean shutdown checkpoints and removes the WAL; if the process was killed, the
next open recovers from it. Never delete a `-wal` file belonging to a database you intend to
keep — that discards committed transactions.

### A corrupt database

Symptoms: `database disk image is malformed`, or `PRAGMA integrity_check` printing anything other
than `ok`.

```bash
docker compose down
cp ./data/snapgut.db ./data/snapgut.db.corrupt   # keep the evidence
sqlite3 ./data/snapgut.db.corrupt ".recover" | sqlite3 ./data/recovered.db
sqlite3 ./data/recovered.db "PRAGMA integrity_check;"
sqlite3 "file:./data/recovered.db?mode=ro" ".tables"
```

`.recover` reads what it can from the file's pages and emits SQL, so it can succeed where a plain
dump fails. It may lose rows and it does not guarantee referential integrity. If the recovered
database checks out, move it into place as `snapgut.db`, remove the stale `-wal`/`-shm`, and
start. If it does not, restore your last verified backup — that is what it is for.

Corruption on a single-writer SQLite file usually points at the storage: a failing disk, a
network filesystem, or a host that lost power mid-write.

### Data directory not writable

The server exits at boot with `Fatal: cannot create parent directory for DB_PATH=...` or `Fatal:
cannot open database at ...`, both naming the path. The bind-mounted `./data` on the host is owned
by a UID the container user is not.

The container user's UID and GID are pinned to **10001** in the `Dockerfile`, so the fix is one
`chown`:

```bash
mkdir -p ./data
sudo chown -R 10001:10001 ./data
ls -ld ./data
```

If you want to confirm the number against the image you built rather than trust this page:

```bash
docker compose run --rm --entrypoint id snapgut -u    # expect: 10001
```

Under systemd the equivalent is `ProtectSystem=strict` without a `ReadWritePaths` entry for
`DATA_DIR`, or a `DATA_DIR` not owned by the service user.

## The food illustration pack

Illustrations are plain files. `GET /foods/<slug>.webp` validates the filename against
`^[a-z0-9-]+\.webp$`, rejects traversal attempts and symlink escapes, and serves the file from
`FOOD_PACK_DIR` with `Cache-Control: public, max-age=31536000, immutable`. A missing file is a
404; a file that exists but cannot be read is a 502 plus a `food pack read error:` log line.

A missing or empty pack is not a failure mode. The client tries the pack, then falls back to a
generated letter avatar (`src/FoodImage.tsx`), so foods render with a coloured initial instead of
an illustration and nothing else changes. The boot summary reports `food pack 0 files`.

404s for slugs the food dictionary recognises are tallied in the `missing_foods` table —
aggregate counts only, never linked to a user — so a future pack knows what to draw.

Fetch it with `node scripts/fetch-food-pack.mjs`, which verifies the archive's SHA-256 before
extracting and leaves the target directory untouched if it does not match. See
[food-pack.md](food-pack.md) for the slug convention, provenance, and the pack's separate
licensing.

One caveat while this repository is private: release assets are not anonymously downloadable,
so the script's unauthenticated request returns `HTTP 404 Not Found` and extracts nothing. Use
`gh release download food-pack-v1 --pattern 'food-pack-v1.tar.gz'` and untar it into the pack
directory in the meantime.

## Uninstalling and deleting data

Docker:

```bash
docker compose down --rmi local   # stop, remove the container and the locally built image
rm -rf ./data                     # database, WAL files, session secret
```

`./data` is a bind mount, not a named volume, so `docker compose down -v` does **not** remove it.
Deleting the directory is the step that erases the server-side data.

Without Docker:

```bash
sudo systemctl disable --now snapgut
sudo rm /etc/systemd/system/snapgut.service
sudo systemctl daemon-reload
sudo rm -rf /var/lib/snapgut /opt/snapgut
sudo userdel snapgut
```

Then the device side, which the server cannot reach:

- In the app: delete individual entries, or use Settings to delete the cloud copy
  (`DELETE /api/sync/data`) and the account (`POST /api/account/delete`). Account deletion purges
  stored events, removes the account row, then deletes the whole IndexedDB database on that
  device and sweeps its local-storage keys.
- Or clear the site's data in the browser, which drops the IndexedDB database including every
  meal photo.

Photos and the full timeline live on each device, so deleting server data is not the same as
deleting the diary. Do both, per device. See [cloud-sync.md](cloud-sync.md) for exactly what each
deletion path removes.
