import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isNonEmptyClientId } from "./googleSheets";

// Feature: google-sheets-integration, Property 1: Config gate matches non-whitespace content
//
// For any string value (including empty string, whitespace-only strings, and
// undefined), isNonEmptyClientId(value) returns true if and only if the value
// contains at least one non-whitespace character (equivalently,
// value.trim().length > 0).
//
// Validates: Requirements 1.1, 1.2

describe("isNonEmptyClientId (Property 1: config gate matches non-whitespace content)", () => {
  it("returns true iff the value has a non-whitespace character", () => {
    // Whitespace characters to interleave with arbitrary content.
    const whitespace = fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v", "\u00a0");

    // A generator that produces strings across the whole input space:
    // empty strings, whitespace-only strings, strings with non-whitespace
    // content, and mixtures of both.
    const arbValue = fc.oneof(
      fc.string(),
      // whitespace-only strings (including empty)
      fc.array(whitespace).map((parts) => parts.join("")),
      // guaranteed non-whitespace content, optionally padded with whitespace
      fc
        .tuple(
          fc.array(whitespace).map((p) => p.join("")),
          fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
          fc.array(whitespace).map((p) => p.join("")),
        )
        .map(([lead, core, trail]) => lead + core + trail),
    );

    fc.assert(
      fc.property(fc.option(arbValue, { nil: undefined }), (value) => {
        const oracle = value != null && value.trim().length > 0;
        expect(isNonEmptyClientId(value)).toBe(oracle);
      }),
      { numRuns: 100 },
    );
  });

  it("handles undefined and empty/whitespace-only strings as false", () => {
    expect(isNonEmptyClientId(undefined)).toBe(false);
    expect(isNonEmptyClientId("")).toBe(false);
    expect(isNonEmptyClientId("   ")).toBe(false);
    expect(isNonEmptyClientId("\t\n\r ")).toBe(false);
  });

  it("recognizes values with non-whitespace content as true", () => {
    expect(isNonEmptyClientId("abc")).toBe(true);
    expect(isNonEmptyClientId("  abc  ")).toBe(true);
    expect(isNonEmptyClientId("123.apps.googleusercontent.com")).toBe(true);
  });
});
