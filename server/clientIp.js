// The one place the Client_IP is derived (Req 14.1a). Both rate limiters — the
// auth throttle in `index.js` and the per-IP sync limiter in `sync.js` — import
// this, so a fix here cannot leave one of them bypassable.
//
// Cloudflare sets `CF-Connecting-IP` itself and it holds exactly one address, so
// a client cannot prepend to it. `X-Forwarded-For` is appended to, which means
// its leftmost entry can be a value the client supplied — trusting it hands out
// a fresh rate-limit bucket per request (Req 14.2). The *rightmost* entry is the
// one the closest proxy appended, which is the one value in that header a client
// cannot forge, so that is what is read.
//
// `TRUSTED_PROXY` is `none` | `xff` | `cloudflare` (validated in `config.js`),
// defaulting to `none`. It is read per call rather than captured at import so a
// test can drive each mode without re-importing the module; the cost is one
// `process.env` lookup per request.
//
// Why `none` and `xff` share one branch: behind a single trusted reverse proxy —
// nginx with `$proxy_add_x_forwarded_for`, Caddy, Traefik, a Tailscale Funnel —
// the rightmost `X-Forwarded-For` entry *is* the correct derivation, and with no
// proxy in front there is no forwarding header to read, so the same code answers
// both cases correctly. Giving `xff` a second, subtly different branch would add
// a divergence in a security-relevant path with nothing to gain from it, so the
// two values are deliberately one derivation that differs only in operator
// intent: `none` says no proxy is expected, `xff` says one is. Anything that
// needs to tell them apart should read `config.trustedProxy`, not this module.

/** The configured proxy in front of the origin, lowercased, `"none"` if unset. */
export function trustedProxy() {
  return (process.env.TRUSTED_PROXY || "none").trim().toLowerCase();
}

/**
 * The address a request is attributed to for rate limiting.
 *
 * - `cloudflare`: the edge-set `CF-Connecting-IP`, falling back to the rightmost
 *   `X-Forwarded-For` entry when that header is absent.
 * - `none`, `xff`, or unset: the rightmost `X-Forwarded-For` entry, which is
 *   proxy-assigned rather than client-supplied — conservative, and it never
 *   fails the request (Req 14.3).
 *
 * In every mode, `"local"` is the key when no forwarding header carries an
 * address, which means every direct client shares one bucket. That is correct on
 * loopback and wrong if the port is published to a network with nothing in
 * front, which is what the `TRUSTED_PROXY` documentation warns about.
 *
 * The value is only ever used as a rate-limit key. It must stay out of logs,
 * error bodies, and response bodies (Req 14.6).
 */
export function clientIp(c) {
  const mode = trustedProxy();

  if (mode === "cloudflare") {
    const cf = (c.req.header("cf-connecting-ip") || "").trim();
    if (cf) return cf;
  }

  const xff = (c.req.header("x-forwarded-for") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return xff[xff.length - 1] || "local";
}
