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
| **Boot failure** | Yes, if set to an exposed (non-loopback) address while `AUTH_PASSWORD` is unset, whitespace-only, or shorter than 12 characters |

Loopback values are `127.0.0.1`, `::1` and `localhost` (case-insensitive). Anything else,
including `0.0.0.0` and a LAN address such as `192.168.1.50`, counts as exposed.

An exposed bind host requires a usable `AUTH_PASSWORD`. If one is not configured, the server
logs an error naming `AUTH_PASSWORD` and the condition that failed, then exits with code 1
before it accepts any connection — it will not publish an unauthenticated diary. The error
never contains the credential value or its length.

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
| **Valid values** | `ollama`, `openai`, `openai-compatible`, `litellm`, `anthropic`, `gemini`, `mock` |
| **Boot failure** | Yes, if set to an unrecognised value |

| Provider | Requires API key | Data leaves host |
| --- | --- | --- |
| `ollama` | No | No (local network only) |
| `openai` | Recommended (depends on server) | Yes |
| `openai-compatible` | Optional (depends on server) | Depends on where `AI_BASE_URL` points |
| `litellm` | Optional (depends on proxy) | Depends on the models the proxy routes to |
| `anthropic` | Yes | Yes |
| `gemini` | Yes | Yes |
| `mock` | No | No (synthetic responses, no network) |

`openai-compatible` speaks the OpenAI chat-completions API against any server: vLLM, LM
Studio, llama.cpp's server, text-generation-webui, OpenRouter, Groq, Together, Fireworks,
DeepSeek and Mistral. It has no default `AI_BASE_URL`, so you must set one. `litellm` is the
same adapter pointed at a LiteLLM proxy on its default port.

### AI_BASE_URL

| | |
| --- | --- |
| **Purpose** | Base URL of the AI model server |
| **Default** | Per provider — see the table below |
| **Boot failure** | Yes, if provider is `openai-compatible` and this is unset |
| **Notes** | For Docker: use `http://host.docker.internal:11434` to reach Ollama on the host |

| Provider | Default base URL |
| --- | --- |
| `ollama` | `http://127.0.0.1:11434` |
| `openai` | `https://api.openai.com` |
| `litellm` | `http://127.0.0.1:4000` |
| `anthropic` | `https://api.anthropic.com` |
| `gemini` | `https://generativelanguage.googleapis.com` |
| `openai-compatible` | None — required |
| `mock` | None — unused |

Trailing slashes are stripped, and a base URL that already ends in `/v1` is not doubled when
the OpenAI-style path is appended. All four of `http://host:4000`, `http://host:4000/`,
`http://host:4000/v1` and `http://host:4000/v1/` resolve to
`http://host:4000/v1/chat/completions`, which is what LiteLLM, vLLM and OpenRouter document.

### AI_MODEL

| | |
| --- | --- |
| **Purpose** | Model identifier passed to the AI provider |
| **Default** | None — required for every provider except `mock` |
| **Boot failure** | Yes, if `AI_PROVIDER` is anything other than `mock` and this is unset or whitespace-only |
| **Examples** | `llama3.2-vision` (Ollama), `gpt-4o-mini` (OpenAI), `gemini-2.5-flash` (Gemini) |

There is no usable default. Every network adapter in `server/ai/` passes this value through
verbatim, and an empty model is rejected by Ollama, all four OpenAI-shaped providers and
Anthropic, and produces a 404 from Gemini's URL-based path — six of the seven providers fail
outright. The server therefore refuses to boot with an error naming `AI_MODEL` rather than
starting and answering `503 {"error":"ai_unavailable"}` the first time someone photographs a
meal. `mock` never calls out, so it is the one provider that needs no model.

The value is trimmed, so a whitespace-only value counts as unset.

### AI_API_KEY

| | |
| --- | --- |
| **Purpose** | API key for the configured AI provider |
| **Default** | None |
| **Required** | Yes for `gemini` and `anthropic`; optional for others depending on the model server's configuration |
| **Boot failure** | Yes, if provider is `gemini` or `anthropic` and this is unset |
| **Secret** | Yes — never logged |

### AI_TIMEOUT_MS

| | |
| --- | --- |
| **Purpose** | Maximum time in milliseconds to wait for an AI response before aborting |
| **Default** | `120000` (2 minutes) |
| **Valid range** | Any number greater than zero |
| **Boot failure** | Yes, if set to `0`, a negative number, or anything non-numeric |

**The timeout cannot be disabled.** The value goes straight to
`AbortSignal.timeout(config.ai.timeoutMs)` at both AI call sites in `server/app.js`, and
`AbortSignal.timeout(0)` fires on the next macrotask — so `0` aborts *every* AI request within a
few milliseconds rather than waiting forever. Earlier versions of this document described `0` as
disabling the timeout; it never did.

`0` is rejected at boot for that reason, as are a negative value and a value that is not a
number. Those are errors rather than a silent fallback to `120000`: an operator who typos a
reliability-relevant timeout should be told at boot instead of running for months on a value
they did not choose.

If a slow local vision model needs longer, raise the number — `AI_TIMEOUT_MS=300000` for five
minutes. Raise your reverse proxy's read timeout above it too, or the proxy gives up first and
the browser sees a 504 instead of the server's own error.

### AI_JSON_MODE

| | |
| --- | --- |
| **Purpose** | Whether to send the provider's structured-output field when JSON is requested |
| **Default** | `auto` |
| **Valid values** | `auto`, `json_object`, `off` |
| **Boot failure** | Yes, if set to an unrecognised value |

`auto` sends each provider's native field: `format: "json"` for Ollama, `response_format` for
the OpenAI-shaped providers, `responseMimeType` for Gemini. `json_object` is the same, named
for the OpenAI field. `off` sends none of them — the escape hatch for gateway-proxied models
that return 400 on `response_format`. The prompt asks for JSON regardless and both call sites
already tolerate an unparseable reply, so `off` degrades safely. Anthropic has no
structured-output field, so this setting does not change its requests.

### AI_EXTRA_HEADERS

| | |
| --- | --- |
| **Purpose** | Extra HTTP headers to add to every AI request, for gateways that expect attribution headers |
| **Default** | None |
| **Valid values** | A JSON object whose values are all strings, e.g. `{"HTTP-Referer":"https://example.com","X-Title":"SnapGut"}` |
| **Boot failure** | Yes, if the value is not parseable JSON, is not an object, is an array, or has a non-string value |

Headers the adapter sets itself (`Content-Type`, `Authorization`, `x-api-key`,
`anthropic-version`) take precedence, so an entry here cannot accidentally break auth.

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
| **Minimum length** | 12 characters, measured after surrounding whitespace is trimmed |
| **Boot failure** | Yes, if `BIND_HOST` is an exposed (non-loopback) address and this is unset, whitespace-only, or shorter than 12 characters |
| **Secret** | Yes — never logged |
| **Notes** | A value that is unset, whitespace-only, or under 12 characters is treated as no credential at all: sign-in is disabled and every sign-in request is rejected with the same response as a wrong password |

The value is trimmed before use, so leading and trailing whitespace does not count toward the
12-character minimum.

On an exposed bind host, an unusable value is a boot failure — see `BIND_HOST` above. On a
loopback bind host, a value under 12 characters is only a warning, so local development is not
blocked, but sign-in stays closed until the value is long enough.

Neither the error nor the warning includes the credential value or its length, and no API
response reveals them.

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
| **Purpose** | Declares the public-facing origin (scheme + host) this instance is reachable at |
| **Default** | None |
| **Examples** | `https://diary.example.com`, `https://my-snapgut.tail1234.ts.net` |
| **Notes** | Declarative only — setting it changes no response. See below |

This used to be the switch that made the instance indexable: with it set, the build wrote a
`sitemap.xml` and a permissive `robots.txt`, and the marketing pages gained canonical and
`og:url` tags. There are no marketing pages any more — `/` serves the app — so there is nothing
to index and nothing to enumerate. `robots.txt` is now a static `Disallow: /` for every
deployment, no sitemap is built, and `X-Robots-Tag: noindex` is sent on every response
unconditionally. A self-hosted health diary should not appear in a search index whatever its
URL is.

What the variable still does: it is validated at boot, carried on the resolved config, and
handed to the response-header middleware. Nothing consumes it today. It is kept because it is
the one declared place for an instance's absolute public URL, and because removing it would be
a breaking `.env` change for no gain.

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

| Value | Derived key, with a forwarding header | Derived key, with none | Intent |
| --- | --- | --- | --- |
| `none` | Rightmost `X-Forwarded-For` entry | `local` | No proxy is expected in front |
| `xff` | Rightmost `X-Forwarded-For` entry | `local` | A reverse proxy or tunnel is expected in front |
| `cloudflare` | `CF-Connecting-IP`, else the rightmost `X-Forwarded-For` entry | `local` | Cloudflare is in front |

**`none` and `xff` behave identically today.** They are one derivation in
`server/clientIp.js`, not two, and the value you pick changes nothing about the key. The
distinction is documentation of intent for whoever reads your `.env` next; nothing in the server
branches on it. If you need to tell them apart in code, read `config.trustedProxy`, not the
derived key.

That is deliberate rather than an oversight. The **rightmost** `X-Forwarded-For` entry is the
address the closest proxy appended, which is the only entry in that header a client cannot
forge — so it is the correct derivation both behind a single trusted reverse proxy (nginx with
`$proxy_add_x_forwarded_for`, Caddy, Traefik, a Tailscale Funnel) and with no proxy at all,
where there is no header to read. The leftmost entry is never used: trusting it would hand out a
fresh rate-limit bucket per request.

`local` is a literal shared key, so with nothing forwarding an address every direct client
counts as one client for rate limiting. That is fine on loopback and wrong if you publish the
port straight to a network — put a proxy in front, or accept that the sign-in throttle is
global rather than per-client.

An incorrect value results in either one shared rate-limit bucket for every client (too
permissive) or a client-forgeable rate-limit bucket (bypassable). If you use a tunnel, set
this to match it and enable the tunnel's own authentication layer as defence in depth.

## Failure classes

- **Boot failure** — the server logs the error and exits with code 1 before listening.
  Triggered by: invalid `PORT`, unrecognised `DATASTORE_BACKEND`, unrecognised `AI_PROVIDER`,
  any provider other than `mock` with `AI_MODEL` unset or whitespace-only, `gemini` without
  `AI_API_KEY`, `anthropic` without `AI_API_KEY`, `openai-compatible`
  without `AI_BASE_URL`, unrecognised `AI_JSON_MODE`, malformed `AI_EXTRA_HEADERS`,
  `AI_TIMEOUT_MS` that is not a number greater than zero (including `0`),
  `SESSION_SECRET` under 32 characters, unrecognised `TRUSTED_PROXY`, exposed `BIND_HOST` with
  an `AUTH_PASSWORD` that is unset, whitespace-only, or under 12 characters.

  Errors accumulate, so one boot names every setting that failed. The one exception is
  `AI_PROVIDER`: when it names something unrecognised, the per-provider requirements
  (`AI_MODEL`, `AI_API_KEY`, `AI_BASE_URL`) are not also reported, because they would be the
  requirements of a provider you never asked for.
- **Warning** — the server starts but logs a warning. Triggered by: loopback bind with an
  `AUTH_PASSWORD` under 12 characters (sign-in stays closed), memory backend with exposed bind.
- **Default** — a documented fallback applies silently.

## Local development

No `.env` loader is needed — Node reads the file natively:

```bash
node --env-file=.env server/main.js
```

For local development the defaults cover everything but one setting: the server binds to
localhost on port 8080, uses the SQLite backend, and talks to a local Ollama instance. `AI_MODEL`
is the exception — it has no default and the server will not boot without it. So the shortest
working `.env` is either

```dotenv
AI_MODEL=<your-vision-model-tag>
```

or, to skip needing a model server entirely,

```dotenv
AI_PROVIDER=mock
```

`mock` is the one provider that needs no `AI_MODEL`.
