# Security policy

SnapGut stores personal health data on hardware the operator controls. Security reports are taken
seriously, and self-hosting mistakes are easy to make, so this file covers both.

## Supported versions

SnapGut is a young project maintained in spare time. Only the most recent release receives fixes.
There is no long-term support branch and no backporting to older tags.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No — upgrade first, then report if the issue persists |

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. That opens a private advisory visible only
to you and the maintainers.

Please do not open a public issue, discussion, or pull request for a vulnerability. There is no
security email address to publish, and no public hosted instance to coordinate with.

### What to include

- The version or commit you are running.
- How the instance is deployed: Docker Compose, Docker, or `npm start` from source.
- Configuration relevant to the issue — `AI_PROVIDER`, `BIND_HOST`, `TRUSTED_PROXY`, whether a
  reverse proxy or tunnel sits in front. Redact secrets.
- What an attacker can do, and what access they need to start.
- Reproduction steps, ideally against a fresh instance with no real diary data.
- Any logs or requests that show the behaviour, with `AUTH_PASSWORD`, `AI_API_KEY`,
  `SESSION_SECRET`, and personal diary content removed.

### What to expect

Best-effort targets, not guarantees — this is a volunteer-maintained project with no company
behind it:

- Acknowledgement within about a week.
- An assessment of whether it is a vulnerability, and a rough fix plan, within about two weeks.
- Credit in the advisory and changelog if you want it.

There is **no bug bounty** and no paid disclosure programme. Nobody is being paid to maintain
SnapGut, so nobody can be paid for reports either.

## Self-hosting security notes

This section is the part most operators need. SnapGut holds food photos, symptom logs, and other
personal health data. The defaults are conservative; exposing the service is where risk enters.

### Network exposure and TLS

The server binds `127.0.0.1` by default, so it is reachable only from the machine it runs on. It
provides no TLS of its own. To reach it from another device, put a TLS-terminating tunnel or
reverse proxy in front of it — Tailscale Funnel, cloudflared, nginx with a certificate, or
equivalent. Do not move `BIND_HOST` to `0.0.0.0` on an untrusted network and call it done.

### `AUTH_PASSWORD`

Set `AUTH_PASSWORD` to at least 12 characters before the service is reachable by anything other
than localhost. With it unset, sign-in is disabled entirely and the diary is readable by anyone
who can reach the port. The server logs a warning at boot when it is bound to an exposed address
without a password, but it will still start.

### `SESSION_SECRET`

If `SESSION_SECRET` is unset, the server generates one on first run and writes it to
`${DATA_DIR}/session-secret` with mode 0600. Rotating the secret — replacing the file or setting
the variable to a new value — invalidates every session token already issued, so every device has
to sign in again. That is the lever to pull if you believe a token has leaked.

### Session tokens

Session tokens are signed with HMAC-SHA256 and are valid for 30 days. They live in browser
storage on the device, which means a compromised or shared device retains access for the life of
the token. Rotate `SESSION_SECRET` to cut existing tokens off.

### `TRUSTED_PROXY`

`TRUSTED_PROXY` must describe the proxy actually in front of the server, because it decides how
the client IP is derived for rate limiting. Getting it wrong fails in one of two directions: too
permissive, where every client shares one rate-limit bucket because they all appear to come from
the proxy, or bypassable, where a client can forge its own address through a request header. Also
enable the tunnel's or proxy's own authentication where it has any — defence in depth costs
little here.

### AI providers and where photos go

Meal photos and prompts are sent to whichever provider `AI_PROVIDER` selects:

| Provider | Where the image and prompt go |
| --- | --- |
| `ollama` (default) | Your own model server. Stays on the host or your network. |
| `mock` | Nowhere. Synthetic responses, no network call. |
| `openai`, `openai-compatible`, `litellm`, `anthropic`, `gemini` | Sent to that third party, under their terms and retention policy. |

Choosing a hosted provider is a deliberate decision to send health-related images off the machine.
Nothing in SnapGut prevents it; it just will not happen unless you configure it.

### Backups

Back up `${DATA_DIR}`. It holds both the SQLite diary and the generated session secret. Treat
those backups as sensitive health data: encrypt them, keep them off shared storage, and be as
careful deleting them as you are creating them.

## Scope

- A self-hoster's own misconfiguration — exposed to the internet with no `AUTH_PASSWORD`, served
  over plain HTTP, `DATA_DIR` world-readable — is a documentation issue, not a vulnerability.
  Reports like that are still welcome as normal issues if the docs led you astray.
- The server failing to enforce a guarantee it documents — authentication bypass, session token
  forgery, rate limiting that can be sidestepped despite correct `TRUSTED_PROXY`, diary data
  leaking to an unconfigured destination, path traversal, injection — is a vulnerability. Report
  those privately.
