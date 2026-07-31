// The one place the Client_IP is derived (Req 14.1a). Both rate limiters — the
// auth throttle in `index.js` and the per-IP sync limiter in `sync.js` — import
// this, so a fix here cannot leave one of them bypassable.
//
// Cloudflare sets `CF-Connecting-IP` itself and it holds exactly one address, so
// a client cannot prepend to it. `X-Forwarded-For` is appended to, which means
// its leftmost entry can be a value the client supplied — trusting it hands out
// a fresh rate-limit bucket per request (Req 14.2).
//
// `TRUSTED_PROXY` is `cloudflare` | `cloudrun` | `none`, defaulting to `none`
// (dev, and any deployment with nothing in front of the origin). It is read per
// call rather than captured at import so a test can drive each mode without
// re-importing the module; the cost is one `process.env` lookup per request.

/** The configured proxy in front of the origin, lowercased, `"none"` if unset. */
export function trustedProxy() {
  return (process.env.TRUSTED_PROXY || "none").trim().toLowerCase();
}

/**
 * The address a request is attributed to for rate limiting.
 *
 * - `cloudflare`: the edge-set `CF-Connecting-IP`.
 * - `cloudrun`: the second-from-right `X-Forwarded-For` entry, the one Google's
 *   front end appends and the client therefore cannot control.
 * - unset: the rightmost `X-Forwarded-For` entry, which is proxy-assigned rather
 *   than client-supplied — conservative, and it never fails the request
 *   (Req 14.3); `"local"` when there is no forwarding header at all.
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

  if (mode === "cloudrun" && xff.length >= 2) return xff[xff.length - 2];

  return xff[xff.length - 1] || "local";
}
