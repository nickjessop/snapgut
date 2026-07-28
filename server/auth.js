import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
const SESSION_DAYS = 30;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Stateless signed session token: base64url(payload).hmac */
export function signToken(email) {
  const payload = b64url(
    JSON.stringify({ e: email, exp: Date.now() + SESSION_DAYS * 86_400_000 })
  );
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Returns the email if the token is valid & unexpired, else null. */
export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = createHmac("sha256", SECRET).update(payload).digest("base64url");
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

export function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashCode(code) {
  return createHmac("sha256", SECRET).update(String(code)).digest("hex");
}

export function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "hex");
  const bb = Buffer.from(String(b), "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
