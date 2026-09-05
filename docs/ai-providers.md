# AI providers

SnapGut calls a model twice: once to read a meal photo (`POST /api/recognize`) and once to
narrate an on-device evidence summary (`POST /api/insights`). Which model server it calls is
decided entirely by environment variables — see [configuration.md](configuration.md) for the
settings reference. This document is the walkthrough: how the provider layer works, and a
worked setup for each supported provider.

Every claim here is taken from `server/ai/` (one file per adapter), `server/ai/index.js`,
`server/ai/url.js`, `server/config.js`, and the two call sites in `server/app.js`.

## How the provider layer works

`createAiProvider(config)` in `server/ai/index.js` returns one object:

```text
{ name, model, generate({ prompt, image, json, signal }) -> Promise<string> }
```

That is the whole contract. `generate` returns the model's raw text. It does not parse, retry,
or validate. Provider selection happens once, during boot phase 4; an unrecognised provider or
a missing required setting throws `ConfigError`, which `server/main.js` logs before exiting 1 —
the server never starts in a half-configured state.

Everything above the adapter lives at the two call sites in `server/app.js`:

- **Prompt construction.** Recognition sends a fixed instruction block plus the user's optional
  note and asks for compact JSON of the shape `{"dish": ..., "ingredients": [{"name",
  "confidence"}]}`. Insights sends a base analyst prompt, a focus-specific paragraph, and the
  device-computed summary as JSON.
- **The image.** Recognition passes `{ data, mimeType }`, where `data` is the base64 photo the
  browser posted. Each adapter re-wraps it in its provider's own format: Ollama's `images`
  array, an OpenAI `image_url` data URL, Anthropic's `source.type: "base64"`, or Gemini's
  `inlineData`.
- **Timeout.** `signal: AbortSignal.timeout(config.ai.timeoutMs)`, default 120000 ms.
- **Parsing, defended.** Recognition starts from `{dish: "Meal", ingredients: []}` and only
  replaces it if `JSON.parse` succeeds; a model that answers in prose yields an empty meal with
  status 200, not an error. Insights falls back to `{headline: "Insight", body: text}`, so prose
  is shown as-is.
- **Failure.** Any throw from `generate` — a non-2xx response, a missing content field, an
  abort — becomes `503 {"error": "ai_unavailable"}`. Nothing else in the app is affected: the
  diary, sync, and every other route keep working.

Both call sites write exactly one log line per request:

```text
ai { provider: 'ollama', kind: 'recognize', outcome: 'ok', elapsedMs: 4211 }
```

`kind` is `recognize` or `insights`; `outcome` is `ok`, `timeout` (an `AbortError` or
`TimeoutError`), or `error`. Prompts, images, notes, and diary content never appear in a log
line.

### Vision matters for recognition only

Recognition sends an image, so it needs a **vision-capable (multimodal)** model. Insights sends
text only and works with any chat model. If you point recognition at a text-only model you will
get either a provider error (`503 ai_unavailable`) or a confident-sounding hallucination about
a photo the model never saw.

### AI_MODEL is required for every provider but mock

`server/config.js` refuses to boot when `AI_PROVIDER` is anything other than `mock` and `AI_MODEL`
is unset or whitespace-only. The error names the provider and the setting, and the process exits 1
before it listens.

The reason it is enforced rather than merely advised: every network adapter passes the value
straight through to the provider (`server/ai/*.js`), and an empty `model` field is rejected by
Ollama, all four OpenAI-shaped providers, and Anthropic, and produces a 404 from Gemini's
URL-based path. Six of the seven providers were guaranteed to fail, and the failure surfaced as
`503 {"error":"ai_unavailable"}` the first time someone photographed a meal — a long way from the
setting that caused it. `mock` never calls out, so it is the one provider that tolerates an empty
model, and the one exempt from the check.

Every worked example below sets `AI_MODEL` for this reason. There is no default to fall back on.

## Ollama (default)

`AI_PROVIDER=ollama` is the default and the only provider that keeps meal photos on hardware
you control without extra work. The adapter posts to `{AI_BASE_URL}/api/generate` with
`stream: false`, the base64 photo in `images`, and `format: "json"` unless `AI_JSON_MODE=off`.

### 1. Install Ollama

Follow the install for your platform at [ollama.com/download](https://ollama.com/download).
On Linux the one-liner installer registers a systemd service listening on `127.0.0.1:11434`.
Confirm it is up:

```bash
curl http://127.0.0.1:11434/api/tags
```

### 2. Pull a vision model

```bash
ollama pull "<model-tag>"
ollama list
```

Model tags change often, so rather than pin a name here: browse
[ollama.com/library](https://ollama.com/library) and filter on the **vision** capability. The
model must accept images through the `/api/generate` `images` field — that is what the adapter
sends. The examples elsewhere in this repo use `llama3.2-vision`; treat it as an example of the
shape of a tag, and check the library for what is current before pulling.

Rough sizing expectations, as general guidance rather than anything this project measures:

| Model class | Typical quantised download | Rough memory to run comfortably |
| --- | --- | --- |
| ~7–8B vision | 4–6 GB | 8 GB RAM, or 6–8 GB VRAM |
| ~11–13B vision | 7–9 GB | 12–16 GB RAM, or 10–12 GB VRAM |
| ~30B+ vision | 18 GB+ | 32 GB RAM, or 24 GB VRAM |

CPU-only inference works and is slow; a 30–90 s recognition is normal on a laptop CPU, which is
well inside the 120 s default timeout but worth knowing before you assume something is broken.
Check the model card on the library page for its actual size and context length.

### 3. Point SnapGut at it

Running the server directly on the same host:

```dotenv
AI_PROVIDER=ollama
AI_BASE_URL=http://127.0.0.1:11434
AI_MODEL=<your-vision-model-tag>
```

### 4. From inside Docker, 127.0.0.1 is the container

This is the single most common setup failure. Inside the container `127.0.0.1` is the
container's own loopback interface, where nothing is listening. Use the host alias instead:

```dotenv
AI_PROVIDER=ollama
AI_BASE_URL=http://host.docker.internal:11434
AI_MODEL=<your-vision-model-tag>
```

`docker-compose.yml` already ships the mapping that makes this resolve on Linux:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

On Docker Desktop (macOS and Windows) the name resolves natively. Two more things have to line
up on Linux:

- **Ollama must listen on more than loopback**, or the container cannot reach it even with the
  alias. Set `OLLAMA_HOST=0.0.0.0:11434` in Ollama's own environment (for the systemd service,
  `systemctl edit ollama.service` and add it under `[Service]`), then restart Ollama.
- **The host firewall must allow the Docker bridge.** Traffic arrives from the bridge subnet,
  not from `127.0.0.1`.

Binding Ollama to `0.0.0.0` exposes it to your local network. Restrict it with a firewall rule
that allows only the Docker bridge if that matters to you.

The alternative on Linux is to run the container on the host network, where `127.0.0.1` means
what you expect:

```bash
docker build -t snapgut:local .
docker run --network host --env-file .env -v ./data:/data snapgut:local
```

`--network host` ignores published-port mappings, so the server's own `BIND_HOST` becomes the
real exposure boundary. Keep `AUTH_PASSWORD` set — with a non-loopback `BIND_HOST` the server
refuses to boot without one.

## LiteLLM

[LiteLLM](https://docs.litellm.ai/) is a proxy that puts one OpenAI-shaped endpoint in front of
many providers, and adds virtual keys, per-key budgets, and spend tracking. It is worth running
when you want to switch models without touching SnapGut's config, or to keep the real provider
key out of SnapGut's environment.

SnapGut's `litellm` provider is the same adapter as `openai`, pointed at LiteLLM's default port
and labelled `litellm` in the `ai` log line.

Minimal `config.yaml` routing one alias to a vision model:

```yaml
model_list:
  - model_name: snapgut-vision
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

general_settings:
  master_key: sk-my-master-key
```

Run it:

```bash
pip install "litellm[proxy]"
export OPENAI_API_KEY=sk-...
litellm --config config.yaml --port 4000
```

Then in SnapGut's `.env`:

```dotenv
AI_PROVIDER=litellm
AI_BASE_URL=http://127.0.0.1:4000
AI_MODEL=snapgut-vision
AI_API_KEY=sk-my-virtual-key
```

`AI_BASE_URL` defaults to `http://127.0.0.1:4000` for this provider, so you can omit it when
the proxy is local and on the default port. `AI_API_KEY` is sent as
`Authorization: Bearer <key>` — use a virtual key you can revoke, not the master key.

From a container the same host-alias rule as Ollama applies:

```dotenv
AI_BASE_URL=http://host.docker.internal:4000
```

Whether photos leave your machine with this provider depends entirely on what the proxy routes
to. A LiteLLM in front of a local Ollama or vLLM keeps them local; a LiteLLM in front of a
hosted API does not.

## openai-compatible (the catch-all)

`AI_PROVIDER=openai-compatible` speaks `POST {AI_BASE_URL}/v1/chat/completions` against
anything that implements it. **`AI_BASE_URL` has no default for this provider and the server
refuses to boot without it** (`server/config.js`).

The base URL may include or omit a trailing `/v1`. `joinApiPath` in `server/ai/url.js` strips
trailing slashes and collapses a duplicated `/v1`, so all four of these resolve to
`http://host:8000/v1/chat/completions`:

```text
http://host:8000        http://host:8000/
http://host:8000/v1     http://host:8000/v1/
```

Worked settings:

```dotenv
# vLLM — python -m vllm.entrypoints.openai.api_server --model <vision-model>
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://127.0.0.1:8000/v1
AI_MODEL=<the model id vLLM reports at /v1/models>
```

```dotenv
# LM Studio — enable the local server in the Developer tab
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://127.0.0.1:1234/v1
AI_MODEL=<the model id shown in LM Studio's server panel>
```

```dotenv
# llama.cpp — llama-server -m <vision-gguf> --mmproj <projector-gguf> --port 8080
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://127.0.0.1:8080/v1
AI_MODEL=<any string; llama-server serves the model it was started with>
```

llama.cpp needs the multimodal projector (`--mmproj`) loaded alongside the model for image
input to work at all. Without it the server will answer, but not about your photo.

```dotenv
# OpenRouter — hosted, photos leave your machine
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=<vendor/model from openrouter.ai/models, filtered to vision>
AI_API_KEY=sk-or-...
AI_EXTRA_HEADERS={"HTTP-Referer":"https://diary.example.com","X-Title":"SnapGut"}
```

If the server runs on the same host as your model server but SnapGut is in a container, replace
`127.0.0.1` with `host.docker.internal` as described above.

## Hosted APIs: openai, anthropic, gemini

**With any of these three, meal photos leave your machine.** Every recognition request uploads
the photo to the vendor. That is the trade for accuracy and speed. If it is not an acceptable
trade for your data, use `ollama` or a local `openai-compatible` server.

```dotenv
AI_PROVIDER=openai
AI_BASE_URL=https://api.openai.com   # default; override for Azure or a gateway
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-...
```

```dotenv
AI_PROVIDER=anthropic
AI_BASE_URL=https://api.anthropic.com   # default
AI_MODEL=<a current Claude model id>
AI_API_KEY=sk-ant-...
```

```dotenv
AI_PROVIDER=gemini
AI_BASE_URL=https://generativelanguage.googleapis.com   # default
AI_MODEL=gemini-2.5-flash
AI_API_KEY=...
```

Notes from the adapters:

- `anthropic` and `gemini` **fail at boot without `AI_API_KEY`** (`server/config.js`). `openai`
  does not, because an OpenAI-shaped server on your own network may need no key. All three fail at
  boot without `AI_MODEL`.
- The Anthropic adapter posts to `/v1/messages` with `anthropic-version: 2023-06-01` and
  `max_tokens: 4096`, places the image before the text, and sends no structured-output field —
  the Messages API has none, so `AI_JSON_MODE` does not change its requests.
- The Gemini adapter posts to `{base}/v1beta/models/{AI_MODEL}:generateContent?key=...` and
  sends `generationConfig.responseMimeType: "application/json"` unless `AI_JSON_MODE=off`.
- Model names for these vendors change on their own schedule. Check the vendor's model list
  rather than trusting a name written down here.

## mock

```dotenv
AI_PROVIDER=mock
```

That is the whole configuration — `mock` is the one provider that needs no `AI_MODEL`, so this is
also the shortest `.env` that boots.

No network call, no API key, no model server. `server/ai/mock.js` returns a synthetic meal for
recognition (chosen from four fixed dishes, folding note-implied ingredients in when the prompt
carries a note) and a templated insight keyed on the summary's `focus` field. Responses come
back in under 50 ms and respect the abort signal.

Use it to evaluate the app end to end before committing to a model server, to develop UI
against, and in tests. The synthetic dishes are obviously fictional — do not mistake them for
recognition working.

## AI_JSON_MODE

`auto` (the default) sends each provider's native structured-output field: `format: "json"` for
Ollama, `response_format: {"type": "json_object"}` for the OpenAI-shaped providers,
`responseMimeType: "application/json"` for Gemini. `json_object` is the same behaviour under
the OpenAI field's name.

`off` sends none of them. It exists because some models behind gateways reject
`response_format` outright with a 400 — commonly a model whose upstream API has no equivalent
field, proxied through an OpenAI-shaped endpoint that passes the field along.

What the operator sees when this is the problem:

- Recognition returns `503 {"error": "ai_unavailable"}` — every time, immediately, not
  intermittently.
- The `ai` log line reads `outcome: 'error'` with a small `elapsedMs` (a rejected request is
  fast; a real inference problem is slow).
- The provider's own log, if you have it, shows a 400 mentioning `response_format`.

The fix is `AI_JSON_MODE=off`. The prompt asks for JSON regardless, and both call sites already
tolerate an unparseable reply, so turning the field off degrades quality slightly at worst.

## AI_EXTRA_HEADERS

A JSON object of header name to string value, added to every AI request. Boot fails if it is
not parseable JSON, is not an object, is an array, or has a non-string value. Headers the
adapter sets itself (`Content-Type`, `Authorization`, `x-api-key`, `anthropic-version`) take
precedence — `mergeHeaders` in `server/ai/url.js` spreads the adapter's own headers last — so
an entry here cannot break authentication.

Two real uses:

```dotenv
# OpenRouter attribution
AI_EXTRA_HEADERS={"HTTP-Referer":"https://diary.example.com","X-Title":"SnapGut"}
```

```dotenv
# A LiteLLM deployment that keys tenants off a custom header
AI_EXTRA_HEADERS={"x-litellm-tenant":"household"}
```

It must be one line of valid JSON with double-quoted keys and values. In a `.env` file, do not
wrap it in extra quotes.

## Troubleshooting

Recognition failing while the rest of the app works is almost always one of the following. Read
the `ai` log line first: `outcome: 'timeout'` and `outcome: 'error'` point in different
directions.

### Connection refused

`outcome: 'error'`, small `elapsedMs`. The model server is not listening where `AI_BASE_URL`
says. Check from the same network namespace the server runs in:

```bash
# on the host
curl http://127.0.0.1:11434/api/tags

# from inside the container
docker compose exec snapgut node -e "
  fetch('http://host.docker.internal:11434/api/tags')
    .then((r) => console.log('status', r.status))
    .catch((e) => console.log('fail', e.message));
"
```

If the host check passes and the container check fails, it is the Docker networking problem:
`AI_BASE_URL` still points at `127.0.0.1`, or Ollama is bound to loopback only, or a firewall is
blocking the bridge subnet.

### 404 on the chat-completions path

`outcome: 'error'`. The adapter's error text carries the status. A doubled `/v1/v1/` is handled
by `joinApiPath`, so a 404 now means the base URL is wrong in some other way: a missing `/v1`
where the server requires one under a different prefix, a path component the gateway does not
serve, or a base URL pointing at a web UI rather than an API. Confirm the exact path by hand:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model>","messages":[{"role":"user","content":"ping"}]}'
```

For Gemini the path is `/v1beta/models/{model}:generateContent`, so a 404 there usually means
`AI_MODEL` names a model that does not exist or is not available to your key.

### 401 or 403 from the provider

`AI_API_KEY` is missing, wrong, revoked, or belongs to a different project. Remember that
`openai` does not require a key at boot — a missing key surfaces here instead. For LiteLLM,
check that the virtual key is still valid and inside its budget.

### Model not found

The provider answers with a message naming your model. For Ollama, `ollama list` shows what is
actually pulled; a model referenced but not pulled is a 404. For OpenAI-shaped servers, `GET
{AI_BASE_URL}/v1/models` lists the ids the server will accept — the id vLLM reports is often the
full path you launched it with, not a short name.

### Timeouts on a slow local model

`outcome: 'timeout'`, `elapsedMs` close to `AI_TIMEOUT_MS`. A large vision model on CPU can
exceed two minutes for a single photo. Raise the limit:

```dotenv
AI_TIMEOUT_MS=300000
```

`AI_TIMEOUT_MS=0` is rejected at boot. There is no way to disable the timeout: the call site
passes the value straight to `AbortSignal.timeout()`, and `AbortSignal.timeout(0)` fires on the
next macrotask, so a zero would abort every AI request within a few milliseconds. `server/config.js`
therefore requires a number greater than zero and errors on `0`, on a negative value, and on
anything non-numeric — rather than silently substituting `120000`, which would leave an operator
running on a value they did not choose. Use a large number instead.

Faster than raising the timeout: use a smaller model, or run it on a GPU.

### A non-vision model asked to read a photo

Symptoms vary by provider. Some reject the request outright, giving `503 ai_unavailable` with
`outcome: 'error'` and a message about an unexpected content type or an unsupported `images`
field. Others accept it, ignore the image, and answer from the prompt alone — which shows up as
recognition that returns plausible-looking food you did not eat, or the fallback
`{"dish": "Meal", "ingredients": []}` with a 200.

Insights working while recognition fails is the tell: insights sends no image.

## Privacy summary

| `AI_PROVIDER` | Where the photo goes | API key |
| --- | --- | --- |
| `ollama` | The Ollama host — your machine or your LAN | No |
| `openai-compatible` | Wherever `AI_BASE_URL` points. Local (vLLM, LM Studio, llama.cpp) stays local; OpenRouter and friends do not | Depends on the server |
| `litellm` | Your proxy, then whichever backend it routes to | Optional (virtual key) |
| `openai` | OpenAI | Recommended; not required at boot |
| `anthropic` | Anthropic | Required |
| `gemini` | Google | Required |
| `mock` | Nowhere — no network call | No |

Independent of the provider, two things always hold: photos are **never** stored server-side or
uploaded by sync (see [cloud-sync.md](cloud-sync.md)), and prompts, images, and diary content
never reach a log line.
