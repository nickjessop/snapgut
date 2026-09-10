# Deployment

How to get SnapGut running somewhere other than your laptop: Docker Compose, a bare Node
process under systemd, and the reverse proxy or tunnel in front of it. Settings referenced here
are documented in full in [configuration.md](configuration.md).

The root [README](../README.md) covers the five-minute quickstart. Start there; come back for
TLS, a reverse proxy, or a non-Docker install.

## Docker Compose (the supported path)

`docker-compose.yml` defines one service. What it does, line by line:

| Directive | Effect |
| --- | --- |
| `build: .` | Builds the two-stage `Dockerfile` from the repo |
| `ports: "127.0.0.1:${PORT:-8080}:8080"` | Publishes to the host's loopback only, on `PORT` or 8080 |
| `volumes: ./data:/data` | Bind-mounts the host `./data` directory as the container's `/data` |
| `env_file: .env` | Loads your configuration into the container's environment |
| `environment: BIND_HOST=0.0.0.0` | Binds inside the container, where the network namespace is the isolation boundary |
| `extra_hosts: host.docker.internal:host-gateway` | Makes the host reachable by name from inside the container, including on Linux |
| `healthcheck` | `GET /api/health` every 30 s, 10 s timeout, 3 retries, 30 s start period. Sends `X-Forwarded-Proto: https` so it also passes with `REQUIRE_HTTPS=1` — see [Reverse proxy and TLS](#reverse-proxy-and-tls) |
| `restart: unless-stopped` | Restarts on crash and on host reboot, but not after you stop it deliberately |

The `Dockerfile` builds the PWA in a `node:24-slim` stage, then copies `dist/`, `server/` and
`shared/` into a second `node:24-slim` stage that installs production dependencies only
(`npm ci --omit=dev`) and runs as a non-root `snapgut` user with `/data` owned by it.

### Building from source, or running the published image

`docker-compose.yml` ships with `build: .`, so out of the box `docker compose up` builds the
checkout you are standing in. That is deliberate — it is what the README quickstart promises,
and a contributor running `docker compose up` should get their own code, not a release.

Tagged releases are also published to GitHub Container Registry for `linux/amd64` and
`linux/arm64`, so an arm64 host — a Raspberry Pi, an Apple silicon Mac — pulls a native image
and compiles nothing. To use it, comment out `build: .` in `docker-compose.yml` and uncomment
one `image:` line:

```yaml
services:
  snapgut:
    # build: .
    image: ghcr.io/nickjessop/snap-gut:0.1.0
```

Three tag shapes are published per release, and they behave differently on upgrade:

| Tag | Means | Moves? |
| --- | --- | --- |
| `0.1.0` | That exact release | Never. Pin this if you want upgrades to be a decision |
| `0.1` | Newest `0.1.x` patch | Moves on each patch release |
| `latest` | Newest release overall | Moves on every release, including minor and major |

`latest` is only ever attached to a tagged release, never to a commit on `master`, so pulling
it gets you something the maintainer chose to cut rather than the tip of the branch. It still
crosses minor versions without asking, which is why `0.1.0` or `0.1` is the better choice for
anything you care about.

The image contains the server and the built PWA. It does not contain your data — that stays
in the `./data` bind mount — the food illustration pack, or your `.env`. Those are unaffected
by switching between the image and a source build, in either direction.

### Upgrading

The two paths differ, and it matters which one you are on:

```bash
# Published image
docker compose pull
docker compose up -d

# Source build
git pull
docker compose up -d --build
```

On the image path, `docker compose pull` fetches whatever your tag now points at, so a pinned
`0.1.0` fetches nothing until you edit the tag. On the source path, `--build` is what makes
`git pull` take effect; without it Compose reuses the image it already has and you will
conclude the upgrade did nothing.

Either way, back up `./data` first — it is a single SQLite file, so a copy is enough — and
read [the changelog](../CHANGELOG.md) for the versions you are crossing.

### Why the published port is loopback-only

`127.0.0.1:8080:8080` means the port is reachable from the host and from nothing else. Combined
with `BIND_HOST=0.0.0.0` **inside** the container, the effect is: the process listens on all
container interfaces, and Docker only forwards from the host's loopback. That is the default
because the safe posture for a diary is "reachable from this machine until you decide
otherwise".

Note that `BIND_HOST=0.0.0.0` counts as an exposed bind as far as `server/config.js` is
concerned, so the compose path **requires a valid `AUTH_PASSWORD`** — at least 12 characters,
after trimming. Without one the server exits 1 at boot with a message naming the setting. This
is deliberate: the container's bind host tells the server nothing about how Docker publishes the
port, so it assumes the worse case.

### Publishing more widely

To serve other machines directly, change the mapping:

```yaml
ports:
  - "${PORT:-8080}:8080"        # all host interfaces
  - "192.168.1.10:8080:8080"    # one specific interface
```

What changes when you do:

- Anyone who can reach that address can reach the sign-in page. `AUTH_PASSWORD` is the only
  thing between them and the diary.
- Plain HTTP over a LAN address is not a secure context, so live camera capture, PWA install and
  offline caching stay unavailable. That is a browser rule, not a SnapGut setting. Put TLS in
  front of it (below) if you want those back.
- Set `TRUSTED_PROXY` correctly for whatever is in front. Direct exposure with no proxy means
  leaving it at `none`.

Prefer a reverse proxy on the same host over publishing the app port broadly. Keep the app on
loopback and let the proxy own the exposed port.

## Running without Docker

Requires Node 24 or newer — the server uses the built-in `node:sqlite` module, which does not
exist in earlier majors.

```bash
npm ci
npm run build                              # emits dist/ — the server serves it
node --env-file=.env server/main.js
```

`npm run build` is not optional: `server/routes.js` serves documents out of `./dist`, and
without it every page request falls back to a minimal not-found document. `npm start` runs the
same server without building first.

The working directory matters. `DIST_ROOT` is the relative path `./dist` and `FOOD_PACK_DIR`
defaults to `./food-pack`, so run the server from the repo root or set the paths explicitly.

### systemd unit

Create a dedicated user and a data directory outside the repo:

```bash
sudo useradd --system --home /opt/snapgut --shell /usr/sbin/nologin snapgut
sudo mkdir -p /var/lib/snapgut
sudo chown snapgut:snapgut /var/lib/snapgut
```

`/etc/systemd/system/snapgut.service`:

```ini
[Unit]
Description=SnapGut food and symptom diary
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=snapgut
Group=snapgut
WorkingDirectory=/opt/snapgut
EnvironmentFile=/opt/snapgut/.env
Environment=DATA_DIR=/var/lib/snapgut
ExecStart=/usr/bin/node server/main.js
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/lib/snapgut

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now snapgut
systemctl status snapgut
journalctl -u snapgut -f
```

Points worth checking if it does not start:

- `ExecStart` has no `--env-file` because `EnvironmentFile` already puts the variables in the
  process environment. Do not use both — you get two parsers with slightly different rules.
- systemd's `EnvironmentFile` parsing is not Node's. A JSON value such as `AI_EXTRA_HEADERS`
  needs single quotes around it (`AI_EXTRA_HEADERS='{"X-Title":"SnapGut"}'`), and `#` starts a
  comment. If in doubt, drop `EnvironmentFile`, keep `--env-file=.env` in `ExecStart`, and let
  Node parse it.
- `ProtectSystem=strict` makes the whole filesystem read-only except what `ReadWritePaths`
  names. `DATA_DIR` must be listed there or the server cannot write the database or the
  generated session secret.
- `/usr/bin/node` is the path on Debian and Ubuntu packages. With nvm or a tarball install it is
  elsewhere — `command -v node` and use the absolute path.
- Keep `.env` readable only by the service user: `sudo chmod 600 /opt/snapgut/.env`.

## Reverse proxy and TLS

Two settings couple SnapGut to whatever sits in front of it, and both fail in ways that are
quiet rather than loud:

- **`REQUIRE_HTTPS=1`** makes the server reject any request whose derived scheme is not `https`
  with `403 {"error":"https_required"}`. The scheme is derived from the `X-Forwarded-Proto`
  header and nothing else (`server/app.js`) — the Node server does not see TLS state directly.
  If your proxy does not set that header, `REQUIRE_HTTPS=1` rejects **every** request.
- **`TRUSTED_PROXY`** decides how the client address is derived for rate limiting
  (`server/clientIp.js`). Get it wrong and rate limiting either collapses into one shared bucket
  for every client, or keys off a value the client controls.

**The compose healthcheck already handles this.** It used to be a caveat: the check called
`http://localhost:8080/api/health` with no forwarding header, so with `REQUIRE_HTTPS=1` the guard
answered 403, the check failed, and the container was reported unhealthy while the app served
normally. The shipped `docker-compose.yml` now sends `X-Forwarded-Proto: https` on that one
request, so the same healthcheck works with `REQUIRE_HTTPS` on or off and needs no editing either
way.

That is safe rather than a hole in the guard: the request originates inside the container against
its own loopback interface, never from a client, so nothing reachable from outside gains anything
from it. If you replace the healthcheck with your own command, keep the header — the comment above
it in `docker-compose.yml` says why. An **external** monitor is a different matter: it comes
through your proxy, which sets the header itself, so it needs nothing special.

### What TRUSTED_PROXY actually does

`server/config.js` accepts `none`, `xff` and `cloudflare`. `server/clientIp.js` branches on
`cloudflare` and otherwise takes the **rightmost** `X-Forwarded-For` entry, falling back to the
literal key `local` when no forwarding header carries an address:

| Value | Derivation in `server/clientIp.js` |
| --- | --- |
| `none` | Rightmost `X-Forwarded-For` entry, else `local` |
| `xff` | Identical to `none` — one derivation, deliberately, not a missing branch |
| `cloudflare` | `CF-Connecting-IP`, falling back to the rightmost `X-Forwarded-For` entry, else `local` |

`none` and `xff` produce the same key for every input, and that is intentional rather than an
omission. The rightmost entry is the address appended by the closest proxy, which is the one entry
in that header a client cannot forge, so it is the correct derivation behind a single reverse proxy
that appends to `X-Forwarded-For` — which is what every config below does — *and* with no proxy at
all, where there is no header to read. The two values differ only in what they tell the next person
to read your `.env`: `none` means nothing is expected in front, `xff` means something is. Behind
Cloudflare, set `cloudflare` so the edge-set single-value header is used instead.
`src/clientIp.test.ts` pins this table, including the no-header case, for all three values.

With no proxy and no forwarding header, every direct client shares the key `local`, meaning one
rate-limit bucket for all of them. That is fine on loopback and wrong if you publish the port
directly to a network.

`clientIp()` reads `process.env.TRUSTED_PROXY` per request rather than the parsed config, so the
variable has to be in the process environment — `env_file` and `EnvironmentFile` both do that.

### Caddy

The easiest recommendation: Caddy provisions and renews a certificate automatically as long as
the hostname resolves to the machine and ports 80 and 443 are reachable.

`/etc/caddy/Caddyfile`:

```caddyfile
diary.example.com {
	encode zstd gzip

	# Meal photos are posted as base64; the server's own cap is 8 MB.
	request_body {
		max_size 12MB
	}

	reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy's `reverse_proxy` sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` by
default, so nothing extra is needed. Matching SnapGut settings:

```dotenv
BIND_HOST=127.0.0.1
PORT=8080
REQUIRE_HTTPS=1
TRUSTED_PROXY=xff
PUBLIC_ORIGIN=https://diary.example.com
AUTH_PASSWORD=<at least 12 characters>
```

With Docker Compose, keep the shipped loopback port mapping and point `reverse_proxy` at
`127.0.0.1:8080` exactly as above.

### nginx

`/etc/nginx/sites-available/snapgut`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name diary.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name diary.example.com;

    ssl_certificate     /etc/letsencrypt/live/diary.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/diary.example.com/privkey.pem;

    # Meal photos are posted as base64 JSON; the server rejects bodies over 8 MB itself.
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # A slow local vision model can hold a request open for minutes.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/snapgut /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

`http2 on;` is the nginx 1.25-and-later form. On older builds, drop that line and write
`listen 443 ssl http2;` instead.

The four `proxy_set_header` lines that matter:

- `Host` — so redirects and canonical URLs use the public hostname.
- `X-Forwarded-For` with `$proxy_add_x_forwarded_for` — appends the real client address as the
  rightmost entry, which is exactly what SnapGut reads.
- `X-Forwarded-Proto` — without it, `REQUIRE_HTTPS=1` rejects everything.
- `X-Forwarded-Host` — not read by the server today, but harmless and expected by most tooling.

Use the same SnapGut settings as the Caddy example. Raise `proxy_read_timeout` above your
`AI_TIMEOUT_MS` (default 120000 ms) or nginx will give up on a slow recognition before the
server does, and the browser will see a 504 instead of the server's own error.

### Traefik

With Traefik v3 and Docker provider labels, add to the service in `docker-compose.yml`:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.snapgut.rule=Host(`diary.example.com`)"
  - "traefik.http.routers.snapgut.entrypoints=websecure"
  - "traefik.http.routers.snapgut.tls.certresolver=letsencrypt"
  - "traefik.http.services.snapgut.loadbalancer.server.port=8080"
```

Traefik sets `X-Forwarded-*` headers itself, so `REQUIRE_HTTPS=1` and `TRUSTED_PROXY=xff` apply
as above. Two things to check: Traefik and the app need to share a Docker network, at which point
the published port is no longer needed; and if you attach a `buffering` middleware, set its
`maxRequestBodyBytes` to at least `8388608` so it does not cut off a meal photo below the
server's own 8 MB cap.

## Tunnels

A tunnel is the shortest route to a secure context without owning a domain or opening a port. A
secure context is what restores live camera capture, PWA install, and offline caching.

### Tailscale Funnel

Covered in the root [README](../README.md#reaching-the-app-from-your-phone-tunnel). Funnel
terminates TLS and forwards to `localhost:8080`; set `REQUIRE_HTTPS=1`, `TRUSTED_PROXY=xff` and
`PUBLIC_ORIGIN` to the Funnel hostname.

### cloudflared

A quick tunnel, for trying it out — the hostname changes every run:

```bash
cloudflared tunnel --url http://localhost:8080
```

A named tunnel, for something you keep:

```bash
cloudflared tunnel login
cloudflared tunnel create snapgut
cloudflared tunnel route dns snapgut diary.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: snapgut
credentials-file: /home/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: diary.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```bash
cloudflared tunnel run snapgut
```

Matching settings:

```dotenv
BIND_HOST=127.0.0.1
REQUIRE_HTTPS=1
TRUSTED_PROXY=cloudflare
PUBLIC_ORIGIN=https://diary.example.com
```

`TRUSTED_PROXY=cloudflare` reads `CF-Connecting-IP`, which the edge sets itself and a client
cannot prepend to. Add Cloudflare Access in front if you want a second authentication layer
before the sign-in page is even reachable.

## Reverse-proxy checklist

- [ ] `X-Forwarded-Proto` is set, or `REQUIRE_HTTPS` is left off.
- [ ] `X-Forwarded-For` is appended to (not overwritten) by the closest proxy, or Cloudflare's
      `CF-Connecting-IP` is used with `TRUSTED_PROXY=cloudflare`.
- [ ] `Host` is forwarded.
- [ ] Request body limit is at least 8 MB — the server's own cap on `/api/*` is 8 MB and it
      answers `413 {"error":"payload_too_large"}` above that.
- [ ] Proxy read timeout is above `AI_TIMEOUT_MS`.
- [ ] WebSocket forwarding is **not** required. The app uses plain request/response only; there
      is no WebSocket or SSE endpoint in `server/`.
- [ ] The monitor points at `GET /api/health` — unauthenticated, returns
      `{"ready":true,"schema":1}`. See [operations.md](operations.md) for what the fields mean.
- [ ] `AUTH_PASSWORD` is at least 12 characters. With an exposed `BIND_HOST` the server refuses
      to boot without one.
- [ ] Nothing about crawling needs configuring: `robots.txt` is always `Disallow: /` and every
      response carries `X-Robots-Tag: noindex`. `PUBLIC_ORIGIN` is declarative only and does not
      change that — set it to the public URL if you want it recorded, or leave it unset.

## Resource expectations

The server process is small. It is a Hono app over a single SQLite file, with no background
workers, no queue, and no image processing — recognition forwards the photo straight to the
model server, and analysis (patterns, food ranking, statistics) happens in the browser.

The AI provider dominates every dimension. A hosted API costs you a network round trip and
almost no local resources. A local vision model wants several gigabytes of RAM or VRAM and is
the reason a recognition takes seconds rather than milliseconds — see
[ai-providers.md](ai-providers.md) for rough model sizing.

Disk: the SQLite file grows with logged events only, and photos are never stored server-side.
The optional food illustration pack is around 70 MB of WebP files.

These are expectations from reading the code, not published benchmark numbers. If you need
capacity figures, measure your own instance.

## Platform notes

- **ARM64 and x86-64 both work.** `node:24-slim` publishes both, and nothing in the runtime
  image needs compiling: SQLite is built into Node 24 as `node:sqlite`, and the production
  dependencies (`hono`, `@hono/node-server`, `idb`, `react`) are pure JavaScript.
- **The build stage installs devDependencies**, including `sharp`, which does ship platform
  binaries. That is a build-time concern only; it is not copied into the runtime stage.
- **Node 24 is a hard floor.** `node:sqlite` is the datastore.
- **Bind-mount ownership.** The container runs as the non-root `snapgut` user, created in the
  `Dockerfile` with an explicitly pinned **UID and GID of 10001**. If the host `./data` directory
  is not writable by that UID the server exits at boot naming the path. Fix ownership:

  ```bash
  sudo chown -R 10001:10001 ./data
  ```

  The UID is pinned rather than left to `adduser --system`, which allocates the lowest free UID in
  Debian's system range (100–999) and therefore moves whenever the base image adds a system user.
  A number that moves is worse than no number in the one troubleshooting entry for an unwritable
  data directory, so it is fixed in the `Dockerfile` and 10001 is the number to use. It sits
  outside the system range and clear of UID 1000, which the official `node` images already use.

  To confirm it for an image you built yourself:

  ```bash
  docker compose run --rm --entrypoint id snapgut -u    # expect: 10001
  ```

  The root README suggests `chmod 755 ./data`, which is enough when the host directory is
  already owned by a matching UID. If the server still cannot write, ownership is the problem,
  not the mode.
