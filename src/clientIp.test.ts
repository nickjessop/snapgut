// @vitest-environment node
//
// The shared Client_IP derivation in `server/clientIp.js`.
//
// Validates: Requirements 14.1, 14.1a, 14.2, 14.3
//
// The helper only reads headers, so it is driven with a minimal stand-in for the
// Hono context rather than a mounted app — the end-to-end limiter behaviour is
// asserted separately against `/api/auth/request`.

import { afterEach, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { clientIp } from "../server/clientIp.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { clientIp as syncClientIp } from "../server/sync.js";

/** Just enough context for a header read. */
const ctx = (headers: Record<string, string>) => ({
  req: { header: (name: string) => headers[name.toLowerCase()] },
});

const original = process.env.TRUSTED_PROXY;

afterEach(() => {
  if (original === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = original;
});

describe("clientIp", () => {
  it("reads CF-Connecting-IP behind Cloudflare, ignoring a spoofed X-Forwarded-For", () => {
    process.env.TRUSTED_PROXY = "cloudflare";
    const ip = clientIp(
      ctx({
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "1.2.3.4, 203.0.113.7, 172.16.0.1",
      })
    );
    expect(ip).toBe("203.0.113.7");
  });

  it("falls back to the rightmost X-Forwarded-For entry behind Cloudflare with no CF header", () => {
    process.env.TRUSTED_PROXY = "cloudflare";
    expect(clientIp(ctx({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("falls back to the rightmost entry when no proxy is configured", () => {
    delete process.env.TRUSTED_PROXY;
    expect(clientIp(ctx({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("returns \"local\" rather than failing when nothing forwards an address", () => {
    delete process.env.TRUSTED_PROXY;
    expect(clientIp(ctx({}))).toBe("local");
    expect(clientIp(ctx({ "x-forwarded-for": " , " }))).toBe("local");
  });

  it("is the same implementation the sync limiter keys on", () => {
    expect(syncClientIp).toBe(clientIp);
  });
});

// The derivation table for every value `server/config.js` accepts, with and
// without a forwarding header. This is the table `docs/configuration.md` and
// `docs/deployment.md` publish, so a change to `clientIp()` that makes those
// docs wrong fails here instead of drifting quietly.
describe("the derived key for every accepted TRUSTED_PROXY value", () => {
  /** `1.2.3.4` is the client-supplied leftmost entry; `203.0.113.7` the proxy's. */
  const FORWARDED = { "x-forwarded-for": "1.2.3.4, 203.0.113.7" };
  const CLOUDFLARE = { ...FORWARDED, "cf-connecting-ip": "198.51.100.9" };

  const cases: Array<[string, string, string, string]> = [
    // [TRUSTED_PROXY, key with X-Forwarded-For, key with no forwarding header,
    //  key with CF-Connecting-IP alongside X-Forwarded-For]
    ["none", "203.0.113.7", "local", "203.0.113.7"],
    ["xff", "203.0.113.7", "local", "203.0.113.7"],
    ["cloudflare", "203.0.113.7", "local", "198.51.100.9"],
  ];

  for (const [mode, withXff, withNothing, withCf] of cases) {
    it(`TRUSTED_PROXY=${mode} derives ${withXff} / ${withNothing} / ${withCf}`, () => {
      process.env.TRUSTED_PROXY = mode;
      expect(clientIp(ctx(FORWARDED))).toBe(withXff);
      expect(clientIp(ctx({}))).toBe(withNothing);
      expect(clientIp(ctx(CLOUDFLARE))).toBe(withCf);
    });
  }

  it("none and xff are one derivation — identical on every input", () => {
    const inputs = [FORWARDED, CLOUDFLARE, {}, { "x-forwarded-for": " , " }];
    for (const headers of inputs) {
      process.env.TRUSTED_PROXY = "none";
      const asNone = clientIp(ctx(headers));
      process.env.TRUSTED_PROXY = "xff";
      expect(clientIp(ctx(headers))).toBe(asNone);
    }
  });

  it("never returns the client-supplied leftmost entry in any mode", () => {
    for (const mode of ["none", "xff", "cloudflare"]) {
      process.env.TRUSTED_PROXY = mode;
      expect(clientIp(ctx(FORWARDED))).not.toBe("1.2.3.4");
      expect(clientIp(ctx(CLOUDFLARE))).not.toBe("1.2.3.4");
    }
  });

  it("has no branch for a removed mode — cloudrun reads like an unset value", () => {
    // `cloudrun` was a Cloud Run-era mode. `config.js` rejects it at boot now, so
    // reaching this module with that value is impossible; the assertion pins that
    // no second-from-right branch survives in the module.
    process.env.TRUSTED_PROXY = "cloudrun";
    expect(clientIp(ctx({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 172.16.0.1" }))).toBe(
      "172.16.0.1"
    );
  });
});
