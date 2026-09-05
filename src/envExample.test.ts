// @vitest-environment node
//
// Every setting that server/config.js reads from env must appear in .env.example.
//
// Validates: Requirements 9.4, 9.5

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const envExamplePath = path.join(repoRoot, ".env.example");
const configPath = path.join(repoRoot, "server", "config.js");

/** All env variable names read in config.js via env.SOMETHING or env["SOMETHING"]. */
function extractEnvReads(source: string): string[] {
  const reads = new Set<string>();
  // Match env.VARNAME or env["VARNAME"] patterns
  for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
    reads.add(match[1]);
  }
  for (const match of source.matchAll(/\benv\["([A-Z][A-Z0-9_]*)"\]/g)) {
    reads.add(match[1]);
  }
  return [...reads].sort();
}

/** All env variable names mentioned in .env.example (lines like VARNAME= or # VARNAME). */
function extractEnvExampleVars(source: string): string[] {
  const vars = new Set<string>();
  for (const line of source.split("\n")) {
    // Match lines like "VARNAME=..." (the actual settings)
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (match) vars.add(match[1]);
  }
  return [...vars].sort();
}

describe(".env.example completeness (Req 9.4, 9.5)", () => {
  const configSource = readFileSync(configPath, "utf8");
  const envExampleSource = readFileSync(envExamplePath, "utf8");

  const configReads = extractEnvReads(configSource);
  const envExampleVars = extractEnvExampleVars(envExampleSource);

  it("config.js reads at least one env variable", () => {
    expect(configReads.length).toBeGreaterThan(0);
  });

  it(".env.example declares at least one variable", () => {
    expect(envExampleVars.length).toBeGreaterThan(0);
  });

  it("every env variable config.js reads appears in .env.example", () => {
    const missing = configReads.filter((v) => !envExampleVars.includes(v));
    expect(missing, `Missing from .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it(".env.example has no variables that config.js doesn't read", () => {
    const extra = envExampleVars.filter((v) => !configReads.includes(v));
    expect(extra, `Extra in .env.example: ${extra.join(", ")}`).toEqual([]);
  });
});
