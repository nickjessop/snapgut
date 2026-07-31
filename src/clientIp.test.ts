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

  it("takes the second-from-right X-Forwarded-For entry on Cloud Run", () => {
    process.env.TRUSTED_PROXY = "cloudrun";
    expect(clientIp(ctx({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 172.16.0.1" }))).toBe(
      "203.0.113.7"
    );
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
