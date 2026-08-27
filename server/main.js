// server/main.js — the sole entry point for the Origin_Server.
//
// Five ordered boot phases:
//   1. config  — validate environment
//   2. secret  — resolve or generate session secret
//   3. datastore — open the selected backend
//   4. app     — build the route tree (buildApp)
//   5. listen  — start the server, flip ready, log summary
//
// Any failure in phases 1–3 logs and exits 1 before listening (Req 9.12, 9.13).

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { resolveSessionSecret } from "./secret.js";
import { ConfigError } from "./ai/index.js";
import { createAiProvider } from "./ai/index.js";
import { surveyPack } from "./foodPack.js";
import { buildApp } from "./app.js";

async function boot() {
  // ── Phase 1: config ──────────────────────────────────────────────────────
  const { ok, config, errors, warnings } = loadConfig(process.env);

  if (!ok) {
    for (const err of errors) {
      console.error(`config error: ${err}`);
    }
    process.exit(1);
  }

  // ── Phase 2: secret ──────────────────────────────────────────────────────
  let secretResult;
  try {
    secretResult = resolveSessionSecret(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`secret error: ${err.message}`);
    } else {
      console.error(`secret error: ${err?.message || err}`);
    }
    process.exit(1);
  }

  // ── Phase 3: datastore ───────────────────────────────────────────────────
  for (const w of warnings) {
    console.warn(`warning: ${w}`);
  }

  let store, eventStore;
  if (config.datastoreBackend === "memory") {
    // In-memory backends (dev/test only)
    const storeModule = await import("./store.js");
    store = await storeModule.getStore();
    const eventStoreModule = await import("./eventStore.js");
    eventStore = await eventStoreModule.getEventStore();
  } else {
    // SQLite backend
    const { DatabaseSync } = await import("node:sqlite");
    const { openDatabase } = await import("./sqlite/open.js");
    const { migrate } = await import("./sqlite/schema.js");
    const { createSqliteStore } = await import("./sqlite/store.js");
    const { createSqliteEventStore } = await import("./sqlite/eventStore.js");

    const { db } = openDatabase(DatabaseSync);
    migrate(db);
    store = createSqliteStore(db);
    eventStore = createSqliteEventStore(db);
  }

  // ── Phase 4: build app ───────────────────────────────────────────────────
  let ai;
  try {
    ai = createAiProvider(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`ai config error: ${err.message}`);
    } else {
      console.error(`ai config error: ${err?.message || err}`);
    }
    process.exit(1);
  }

  const ready = { value: false };

  const app = buildApp({ config, store, eventStore, secret: secretResult.secret, ai, ready });

  // ── Phase 5: listen + boot summary ──────────────────────────────────────
  const pack = await surveyPack(config.foodPackDir);
  for (const w of pack.warnings) {
    console.warn(`food-pack: ${w}`);
  }

  const authStatus = config.auth.password ? "AUTH_PASSWORD set" : "no password (open access)";

  serve({ fetch: app.fetch, port: config.port, hostname: config.bindHost }, () => {
    ready.value = true;

    console.log(
      `\nsnapgut listening on http://${config.bindHost}:${config.port}\n` +
        `  datastore  ${config.datastoreBackend}${config.datastoreBackend === "sqlite" ? ` (${config.dbPath})` : ""}\n` +
        `  ai         ${config.ai.provider}${config.ai.baseUrl ? ` (${config.ai.baseUrl}, ${config.ai.model || "default model"})` : config.ai.model ? ` (${config.ai.model})` : ""}\n` +
        `  food pack  ${pack.count} files (${config.foodPackDir})\n` +
        `  session    secret ${secretResult.source === "env" ? "from SESSION_SECRET env" : secretResult.source === "file" ? `loaded from ${secretResult.path}` : `generated at ${secretResult.path}`}\n` +
        `  auth       ${authStatus}\n`
    );
  });
}

boot().catch((err) => {
  console.error(`fatal boot error: ${err?.message || err}`);
  process.exit(1);
});
