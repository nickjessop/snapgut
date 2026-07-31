// @vitest-environment node
//
// Every model identifier this repo can configure is a First_Party_Model — a model published
// by Google (`publishers/google`). A model from any other publisher bills as a Cloud
// Marketplace charge, which sits outside committed credits, so a swap that looks like a
// one-word config change moves real spend off the credits that pay for this project.
//
// **Why a prefix allowlist and not an exact list.** Two rules are asserted, and the
// structural one carries most of the weight:
//
//  1. *Structural:* the identifier is a bare model id — no `/`, no `:`, no whitespace. This
//     is the load-bearing rule. `@google-cloud/vertexai` turns a bare name into
//     `projects/{p}/locations/{l}/publishers/google/models/{name}`
//     (`formulateResourcePathFromModel`, generative_models.js), so a bare name *cannot*
//     address another publisher. The generation scripts interpolate the value straight into
//     a `.../publishers/google/models/${MODEL}:generateContent` URL, where a value
//     containing `/` could climb out of the Google publisher path
//     (`../../anthropic/models/…`); barring `/` closes that too.
//  2. *Family:* the bare id starts with a known Google model-family prefix. A hardcoded list
//     of exact strings would fail on a legitimate version bump — `gemini-2.5-flash-lite` →
//     `gemini-3-flash-lite` is a benign change that should not need a test edit — while
//     still not catching anything the structural rule misses. A prefix allowlist accepts
//     version movement inside a Google family and rejects every other vendor's naming
//     (`claude-…`, `llama-…-maas`, `mistral-…`, `deepseek-…`, `qwen-…`), which is what the
//     requirement is actually about.
//
// Identifiers are read out of the source files rather than restated here, so the test tracks
// what the code and the scripts really default to.
//
// _Requirements: 18.9, 21.6_

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url).pathname;

/** Source trees that can hold a model identifier or a Vertex URL. */
const SOURCE_DIRS = ["server", "scripts", "shared", "src", "vite", "infra"];

const SOURCE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx"];

/** This file states third-party identifiers on purpose, as the rejection cases. */
const SELF = "src/vertexModel.test.ts";

/**
 * Google-published model families on Vertex AI. Prefixes, not exact ids, so a version bump
 * inside a family stays green — see the header note.
 */
const GOOGLE_MODEL_FAMILIES = [
  "gemini-",
  "gemma-",
  "imagen-",
  "veo-",
  "text-embedding-",
  "text-multilingual-embedding-",
];

/** A First_Party_Model identifier as this repo may configure one. */
function isFirstPartyModel(id: string): boolean {
  // Structural: a bare Model Garden id. Anything with a separator could address another
  // publisher, either through the SDK's full-resource-name branch or by escaping the
  // hardcoded `publishers/google` segment in the scripts' URL template.
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) return false;
  return GOOGLE_MODEL_FAMILIES.some((family) => id.startsWith(family));
}

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const dir of SOURCE_DIRS) {
    const abs = join(repoRoot, dir);
    let entries: string[];
    try {
      entries = readdirSync(abs, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = join(dir, entry);
      if (rel.includes("node_modules")) continue;
      if (!SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext))) continue;
      if (!statSync(join(repoRoot, rel)).isFile()) continue;
      found.push(rel);
    }
  }
  return found;
}

/** Every `process.env.<…MODEL…> || "<default>"` read across the source trees. */
function configuredModelDefaults(): { file: string; env: string; value: string }[] {
  const sites: { file: string; env: string; value: string }[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    for (const m of text.matchAll(/process\.env\.(\w*MODEL\w*)\s*\|\|\s*"([^"]*)"/g)) {
      sites.push({ file, env: m[1], value: m[2] });
    }
  }
  return sites;
}

describe("First_Party_Model rule", () => {
  it("accepts the Google model families and rejects other publishers", () => {
    for (const id of [
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.5-flash-image",
      "gemini-3.1-flash-image",
      "imagen-4.0-generate-001",
    ]) {
      expect(isFirstPartyModel(id), id).toBe(true);
    }

    for (const id of [
      // Other publishers, as Model Garden names them.
      "claude-sonnet-4-5",
      "llama-3.1-405b-instruct-maas",
      "mistral-large-2411",
      "deepseek-v3.1-maas",
      "qwen3-coder-480b-a35b-instruct-maas",
      // Explicit publisher paths, including the one that would escape the scripts' URL
      // template, and a tuned-model resource name whose publisher is not visible here.
      "publishers/anthropic/models/claude-sonnet-4-5",
      "../../anthropic/models/claude-sonnet-4-5",
      "projects/p/locations/us-central1/publishers/meta/models/llama-3.1-405b-instruct-maas",
      "models/gemini-2.5-flash-lite",
      // Degenerate values.
      "",
      " gemini-2.5-flash-lite",
      "gemini-2.5-flash-lite:generateContent",
    ]) {
      expect(isFirstPartyModel(id), id).toBe(false);
    }
  });

  it("finds every model identifier the repo can configure", () => {
    const byEnv = new Map(configuredModelDefaults().map((s) => [s.env, s]));

    // Sanity on the extraction itself: if one of these disappears, the scan silently stopped
    // covering a real configuration point.
    expect([...byEnv.keys()].sort()).toEqual(["IMAGE_MODEL", "TEXT_MODEL", "VERTEX_MODEL"]);
    expect(byEnv.get("VERTEX_MODEL")!.file).toBe("server/index.js");
  });

  it("defaults every configured model identifier to a First_Party_Model", () => {
    const sites = configuredModelDefaults();
    expect(sites.length).toBeGreaterThan(0);

    for (const { file, env, value } of sites) {
      expect(isFirstPartyModel(value), `${file}: ${env}="${value}"`).toBe(true);
    }
  });

  it("sets no non-Google model on the Cloud Run revision", () => {
    // `infra/service.ts` owns the revision's non-secret environment. It sets no model today —
    // the code default applies — but if a later change sets one, it has to be first-party.
    const infra = readFileSync(join(repoRoot, "infra/service.ts"), "utf8");
    const envs = [...infra.matchAll(/\{\s*name:\s*"(\w+)",\s*value:\s*"([^"]*)"\s*\}/g)];

    for (const [, name, value] of envs) {
      if (!name.includes("MODEL")) continue;
      expect(isFirstPartyModel(value), `${name}="${value}"`).toBe(true);
    }
  });

  it("addresses no publisher other than google anywhere in the source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === SELF) continue;
      const text = readFileSync(join(repoRoot, file), "utf8");
      for (const m of text.matchAll(/publishers\/([A-Za-z0-9_$-]+|\$\{[^}]*\})/g)) {
        if (m[1] !== "google") offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Vertex location", () => {
  it("defaults to us-central1 everywhere and matches the deployed region", () => {
    const locations = new Map<string, string>();
    for (const file of sourceFiles()) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      for (const m of text.matchAll(/process\.env\.VERTEX_LOCATION\s*\|\|\s*"([^"]*)"/g)) {
        locations.set(file, m[1]);
      }
    }

    expect(locations.size).toBeGreaterThan(0);
    for (const [file, location] of locations) {
      expect(location, file).toBe("us-central1");
    }

    // `infra/service.ts` sets `VERTEX_LOCATION` from `gcp:region`, so the revision agrees with
    // the code default only as long as the stack's region does. The deployed revision carries
    // `VERTEX_LOCATION=us-central1` (verified with gcloud in task 10.8).
    const stack = readFileSync(join(repoRoot, "infra/Pulumi.prod.yaml"), "utf8");
    expect(stack).toMatch(/^ {2}gcp:region: us-central1$/m);
  });
});
