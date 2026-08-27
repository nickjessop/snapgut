import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_EXPIRY_MS = 30 * 86_400_000; // 30 days

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Stateless signed session token: base64url(payload).hmac */
export function signToken(email, secret) {
  const payload = b64url(
    JSON.stringify({ e: email, exp: Date.now() + TOKEN_EXPIRY_MS })
  );
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Returns the email if the token is valid & unexpired, else null. */
export function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { e, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!e || !exp || Date.now() > exp) return null;
    return e;
  } catch {
    return null;
  }
}

/**
 * Constant-time credential comparison independent of input length.
 * Computes HMAC-SHA256 of both `submitted` and `expected` using `secret` as the key,
 * then compares the two HMACs using crypto.timingSafeEqual.
 * @param {string} submitted - The credential the user submitted
 * @param {string} expected - The correct credential
 * @param {string} secret - HMAC key
 * @returns {boolean}
 */
export function credentialMatches(submitted, expected, secret) {
  const hmacA = createHmac("sha256", secret)
    .update(String(submitted))
    .digest();
  const hmacB = createHmac("sha256", secret)
    .update(String(expected))
    .digest();
  return timingSafeEqual(hmacA, hmacB);
}
