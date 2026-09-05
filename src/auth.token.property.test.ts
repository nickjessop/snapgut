// @vitest-environment node
//
// Property-based tests for the Auth_Service token operations.
//
// Property 10: sign/verify round-trip — verifyToken(signToken(email, secret), secret) === email
// Property 11: tamper rejection — modifying any character of the token → verifyToken returns null
//
// Validates: Requirements 6.6, 6.7

import fc from "fast-check";
import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript
import { signToken, verifyToken } from "../server/auth.js";

// --- Generators ---

/** Valid email-format strings: local@domain */
const arbEmail = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9._%+-]{0,20}$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}\.[a-z]{2,4}$/)
  )
  .map(([local, domain]) => `${local}@${domain}`);

/** Secrets of at least 32 characters (the minimum the system enforces). */
const arbSecret = fc.string({ minLength: 32, maxLength: 128 }).filter((s) => s.length >= 32);

// --- Property 10: Token round-trip ---

describe("Property 10: Token round trip", () => {
  /**
   * **Validates: Requirements 6.6**
   *
   * For all account identifiers, verifying a token the auth service signed
   * yields that same identifier.
   */
  it("verifyToken(signToken(email, secret), secret) === email", () => {
    fc.assert(
      fc.property(arbEmail, arbSecret, (email, secret) => {
        const token = signToken(email, secret);
        const result = verifyToken(token, secret);
        expect(result).toBe(email);
      }),
      { numRuns: 200 }
    );
  });
});

// --- Property 11: Token tamper rejection ---

describe("Property 11: Token tamper rejection", () => {
  /**
   * **Validates: Requirements 6.7**
   *
   * For all tokens with any alteration to the payload or the signature,
   * verification fails (returns null).
   */
  it("modifying any character of the token causes verifyToken to return null", () => {
    fc.assert(
      fc.property(
        arbEmail,
        arbSecret,
        fc.nat(),
        fc.integer({ min: 1, max: 127 }),
        (email, secret, posRaw, delta) => {
          const token = signToken(email, secret);
          // Pick a position within the token to tamper
          const pos = posRaw % token.length;
          const original = token.charCodeAt(pos);
          // Shift the character by delta (wrapping), ensuring it changes
          const tampered =
            token.slice(0, pos) +
            String.fromCharCode(((original + delta) % 128) | 0) +
            token.slice(pos + 1);

          // Only assert on actually-changed tokens
          if (tampered === token) return;

          const result = verifyToken(tampered, secret);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 200 }
    );
  });

  it("wrong secret always rejects", () => {
    fc.assert(
      fc.property(arbEmail, arbSecret, arbSecret, (email, secret1, secret2) => {
        // Only test when secrets differ
        if (secret1 === secret2) return;
        const token = signToken(email, secret1);
        const result = verifyToken(token, secret2);
        expect(result).toBeNull();
      }),
      { numRuns: 200 }
    );
  });

  it("truncated signature rejects", () => {
    fc.assert(
      fc.property(arbEmail, arbSecret, fc.nat({ max: 10 }), (email, secret, trimCount) => {
        const token = signToken(email, secret);
        const dotIdx = token.indexOf(".");
        const payload = token.slice(0, dotIdx);
        const sig = token.slice(dotIdx + 1);
        // Truncate the signature by 1 to trimCount+1 chars
        const truncated = `${payload}.${sig.slice(0, Math.max(0, sig.length - trimCount - 1))}`;
        if (truncated === token) return;
        expect(verifyToken(truncated, secret)).toBeNull();
      }),
      { numRuns: 200 }
    );
  });
});
