# Configuration

Every setting the server reads, parsed and validated at boot by `server/config.js`. The server
reads `process.env` exactly once, builds a frozen `Config` object, and nothing below that point
touches the environment directly.

All settings are environment variables. Use a `.env` file (Node reads it natively with
`--env-file=.env`) or set them in `docker-compose.yml`. See `.env.example` for the complete
list with comments.

## Settings Reference

### PORT

| | |
| --- | --- |
| **Purpose** | TCP port the server listens on |
| **Default** | `8080` |
| **Valid range** | Integer, 1–65535 |
| **Boot failure** | Yes, if set to a non-integer or out-of-range value |

### BIND_HOST

| | |
| --- | --- |
| **Purpose** | Network interface to bind to |
| **Default** | `127.0.0.1` (loopback — accessible only from the local machine) |
| **Valid values** | Any IP address or hostname. `0.0.0.0` exposes to all interfaces |
| **Boot failure** | No |

When set to an exposed (non-loopback) address, the server logs a warning at startup. If
`AUTH_PASSWORD` is also unset, a stronger warning is emitted because the diary will be
accessible without authentication.

### DATA_DIR

| | |
| --- | --- |
| **Purpose** | Base directory for persistent data (database, generated session secret) |
| **Default** | `/data` |
| **Notes** | Must be readable and writable by the process or container user |

### DB_PATH

| | |
| --- | --- |
| **Purpose** | Full path to the SQLite database file |
| **Default** | `${DATA_DIR}/snapgut.db` |
| **Notes** | Parent directory is created automatically if it does not exist |

### DATASTORE_BACKEND

| | |
| --- | --- |
| **Purpose** | Which storage backend to use |
| **Default** | `sqlite` |
| **Valid values** | `sqlite`, `memory` |
| **Boot failure** | Yes, if set to an unrecognised value |

The `memory` backend loses all data when the process exits. It exists for the test suite. A
warning is logged if `memory` is selected with an exposed bind host.

### AI_PROVIDER

| | |
| --- | --- |
| **Purpose** | Which AI adapter to use for meal recognition and insights |
| **Default** | `ollama` (local model server) |
| **Valid values** | `ollama`, `openai`, `gemini`, `mock` |
| **Boot failure** | Yes, if set to an unrecognised value |

| Provider | Requires API key | Data leaves host |
| --- | --- | --- |
| `ollama` | No | No (local network only) |
| `openai` | Recommended (depends on server) | Yes |
| `gemini` | Yes | Yes |
| `mock` | No | No (synthetic responses, no network) |

### AI_BASE_URL

| | |
| --- | --- |
| **Purpose** | Base URL of the AI model server |
| **Default** | `http://127.0.0.1:11434` when provider is `ollama`; none otherwise |
| **Notes** | For Docker: use `http://host.docker.internal:11434` to reach Ollama on the host |

### AI_MODEL

| | |
| --- | --- |
| **Purpose** | Model identifier passed to the AI provider |
| **Default** | Empty string (provider uses its own default) |
| **Examples** | `llama3.2-vision` (Ollama), `gpt-4o-mini` (OpenAI), `gemini-2.5-flash` (Gemini) |

### AI_API_KEY

| | |
| --- | --- |
| **Purpose** | API key for the configured AI provider |
| **Default** | None |
| **Required** | Yes for `gemini`; optional for others depending on the model server's configuration |
| **Secret** | Yes — never logged |

### AI_TIMEOUT_MS

| | |
| --- | --- |
| **Purpose** | Maximum time in milliseconds to wait for an AI response before aborting |
| **Default** | `120000` (2 minutes) |
| **Notes** | Set to `0` to disable the timeout. Large images or slow models may need a higher value |

### FOOD_PACK_DIR

| | |
| --- | --- |
| **Purpose** | Directory containing the WebP food illustration files |
| **Default** | `./food-pack` |
| **Notes** | If empty or missing, food thumbnails return 404 and the app falls back to letter avatars |

### AUTH_EMAIL

| | |
| --- | --- |
| **Purpose** | Email address used as the account identifier |
| **Default** | `admin@localhost` |
| **Notes** | Appears in the session token and in the account record |

### AUTH_PASSWORD

| | |
| --- | --- |
| **Purpose** | Password required to sign in |
| **Default** | None (unset) |
| **Secret** | Yes — never logged |
| **Notes** | When unset, sign-in is disabled and the diary is open to anyone who can reach it. A warning is logged if the bind host is exposed and this is unset |

### SESSION_SECRET

| | |
| --- | --- |
| **Purpose** | HMAC key for signing session tokens |
| **Default** | None — if unset, resolved by `server/secret.js` from a persisted file or generated on first run |
| **Minimum length** | 32 characters |
| **Boot failure** | Yes, if set but shorter than 32 characters |
| **Secret** | Yes — never logged |

On first run with no value set, the server generates a random 32-byte secret, writes it to
`${DATA_DIR}/session-secret` with mode `0600`, and logs the path (never the value). On
subsequent runs it reads from that file. Set this variable explicitly to use a specific secret
or to share one across multiple instances.

### PUBLIC_ORIGIN

| | |
| --- | --- |
| **Purpose** | The public-facing origin (scheme + host) for canonical URLs, OG tags, sitemap, and robots.txt |
| **Default** | None |
| **Examples** | `https://diary.example.com`, `https://my-snapgut.tail1234.ts.net` |
| **Notes** | When unset, `robots.txt` defaults to `Disallow: /` and the sitemap is empty. Canonical and OG URLs are omitted |

### REQUIRE_HTTPS

| | |
| --- | --- |
| **Purpose** | Reject requests that did not arrive over HTTPS |
| **Default** | `false` |
| **Valid values** | `1`, `true`, `yes` to enable; anything else or unset to disable |
| **Notes** | Enable this when the server is behind a TLS-terminating tunnel or reverse proxy |

### TRUSTED_PROXY

| | |
| --- | --- |
| **Purpose** | How to derive the client IP from forwarding headers for rate limiting |
| **Default** | `none` |
| **Valid values** | `none`, `xff`, `cloudflare` |
| **Boot failure** | Yes, if set to an unrecognised value |

| Value | Behaviour |
| --- | --- |
| `none` | Uses the rightmost `X-Forwarded-For` entry, or a shared key when no forwarding data is present |
| `xff` | Trusts `X-Forwarded-For` (standard reverse proxy / Tailscale) |
| `cloudflare` | Reads `CF-Connecting-IP` |

An incorrect value results in either one shared rate-limit bucket for every client (too
permissive) or a client-forgeable rate-limit bucket (bypassable). If you use a tunnel, set
this to match it and enable the tunnel's own authentication layer as defence in depth.

## Failure classes

- **Boot failure** — the server logs the error and exits with code 1 before listening.
  Triggered by: invalid `PORT`, unrecognised `DATASTORE_BACKEND`, unrecognised `AI_PROVIDER`,
  `gemini` without `AI_API_KEY`, `SESSION_SECRET` under 32 characters, unrecognised
  `TRUSTED_PROXY`.
- **Warning** — the server starts but logs a warning. Triggered by: exposed bind with no
  `AUTH_PASSWORD`, memory backend with exposed bind.
- **Default** — a documented fallback applies silently.

## Local development

No `.env` loader is needed — Node reads the file natively:

```bash
node --env-file=.env server/main.js
```

For local development, the defaults are usually sufficient: the server binds to localhost on
port 8080, uses the SQLite backend, and talks to a local Ollama instance. Set `AI_PROVIDER=mock`
to skip needing a model server entirely.
