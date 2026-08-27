# SnapGut 🍽️

A self-hosted food and symptom diary that runs on hardware you control. Snap a meal, log how
your gut feels, and see which foods track with your symptoms — all without sending diary data
off your machine.

The default configuration uses a local AI model server for meal recognition, stores everything
in a single SQLite file, and needs no cloud account, no API key, and no payment processor.

## Quickstart

1. **Clone the repo**

   ```bash
   git clone https://github.com/nickvdyck/food-snap.git
   cd food-snap
   ```

2. **Copy the example configuration**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set `AUTH_PASSWORD` to a password of at least 12 characters.

3. **Optionally fetch the food illustration pack** (~70 MB, 3,036 WebP files)

   ```bash
   node scripts/fetch-food-pack.mjs
   ```

   If you skip this step, foods display a letter-avatar placeholder instead of an illustration.
   Everything else works the same.

4. **Start the service**

   ```bash
   docker compose up
   ```

5. **Open the app**

   Navigate to [http://localhost:8080](http://localhost:8080) in your browser.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 24+** | Required for local development. The container image pins Node 24. |
| **Docker** (with Compose) | The supported deployment method. |
| **~70 MB free disk** | Only if you download the food illustration pack. |

## Reaching the app from your phone (tunnel)

Live camera capture, installation as a PWA, and offline caching each require a **secure
context** (HTTPS). If you access SnapGut over plain HTTP on a local network address, the app
falls back to the platform file picker for photos — this is expected behaviour, not a bug.

To restore live camera capture from a phone, expose SnapGut through an HTTPS tunnel. The
project does not bundle or manage a tunnel; you bring your own.

### Example: Tailscale Funnel

1. Install [Tailscale](https://tailscale.com/download) on the machine running SnapGut.

2. Enable HTTPS certificates:

   ```bash
   tailscale cert
   ```

3. Expose the port with Funnel:

   ```bash
   tailscale funnel 8080
   ```

4. Open the Funnel URL (e.g. `https://your-machine.tailnet-name.ts.net`) on your phone.

   Live camera capture, PWA installation, and offline caching are now available.

Any tunnel that terminates TLS and forwards to `localhost:8080` works the same way — for
example, [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
or an nginx reverse proxy with a Let's Encrypt certificate.

## AI providers

SnapGut uses AI for meal recognition (identifying foods from a photo) and generating dietary
insights. Configure which provider to use with the `AI_PROVIDER` setting in `.env`.

| `AI_PROVIDER` | Description | API key required | Data leaves host |
| --- | --- | --- | --- |
| `ollama` (default) | Local model server via [Ollama](https://ollama.com) | No | No |
| `openai` | OpenAI-compatible chat completions endpoint | Yes (`AI_API_KEY`) | Yes |
| `gemini` | Google Gemini REST API | Yes (`AI_API_KEY`) | Yes |
| `mock` | Returns synthetic data, no network call — useful for testing | No | No |

When `AI_PROVIDER` is unset, the local Ollama provider is selected. If no model server is
running at `AI_BASE_URL`, recognition and insight routes return an error but every other route
works normally.

For the Ollama provider, install a multimodal model (e.g. `ollama pull llama3.2-vision`) and
point `AI_BASE_URL` at the server. Inside Docker, use `http://host.docker.internal:11434` to
reach Ollama running on the host.

## Backup and restore

All diary data lives in a single SQLite file (by default `./data/snapgut.db` on the host).

### Backup

1. Stop the container:

   ```bash
   docker compose down
   ```

2. Copy the database file:

   ```bash
   cp ./data/snapgut.db ./data/snapgut.db.backup
   ```

Alternatively, while the server is running you can use SQLite's `.backup` command:

```bash
docker compose exec snapgut node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/snapgut.db');
  db.exec(\".backup '/data/snapgut.db.backup'\");
  db.close();
"
```

### Restore

1. Stop the container:

   ```bash
   docker compose down
   ```

2. Replace the database file with your backup:

   ```bash
   cp ./data/snapgut.db.backup ./data/snapgut.db
   ```

3. Start the container:

   ```bash
   docker compose up
   ```

## Upgrade

1. **Back up the database** (see above) — schema changes apply automatically on boot, so keep
   a copy in case you need to roll back.

2. Pull the latest code:

   ```bash
   git pull
   ```

3. Rebuild and restart:

   ```bash
   docker compose up --build
   ```

Schema migrations run automatically when the server starts. No manual migration step is
required.

## Troubleshooting

### Model server unreachable

**Symptom:** Recognition or insight requests return an error mentioning the AI provider.

**Fix:** Verify `AI_BASE_URL` is set and the model server is running. Inside Docker, use
`http://host.docker.internal:11434` instead of `http://127.0.0.1:11434` — the container
cannot reach `localhost` on the host without this mapping.

### Port already in use

**Symptom:** The container fails to start with "address already in use" on port 8080.

**Fix:** Either stop the process occupying the port, or change the `PORT` variable in `.env`
and update the `ports` mapping in `docker-compose.yml` to match.

### Data directory not writable

**Symptom:** The server exits immediately with an error naming the `/data` path.

**Fix:** Ensure the `./data` directory on the host exists and is writable by UID 1000 (the
`snapgut` user inside the container):

```bash
mkdir -p ./data
chmod 755 ./data
```

### Camera unavailable over HTTP

**Symptom:** The camera button shows a file picker instead of a live viewfinder.

**Fix:** Browsers restrict camera access to secure contexts (HTTPS or `localhost`). If you are
accessing SnapGut from another device over HTTP, set up a tunnel (see the tunnel section
above). The file-picker fallback is the expected behaviour on plain HTTP and is not a fault.

## Configuration

All settings are documented in [`.env.example`](.env.example). Key settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port the server listens on |
| `AUTH_PASSWORD` | _(empty)_ | Password for signing in |
| `AI_PROVIDER` | `ollama` | AI backend: ollama, openai, gemini, mock |
| `AI_BASE_URL` | `http://127.0.0.1:11434` | Model server URL |
| `DATA_DIR` | `/data` | Where the database and session secret are stored |
| `FOOD_PACK_DIR` | `./food-pack` | Directory for food illustrations |

See [docs/configuration.md](docs/configuration.md) for the full reference.

## Medical disclaimer

SnapGut is a **food diary**, not a medical device. Its meal recognition and dietary insight
outputs are generated by a language model and do not constitute medical advice, diagnosis, or
treatment recommendations. Always consult a qualified health professional before making
changes to your diet or treatment plan.

## License

See [LICENSE](LICENSE).
