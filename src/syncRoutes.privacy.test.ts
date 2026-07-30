// @vitest-environment node
//
// Sync_Service redaction and deletion tests.
//
// Validates: Requirements 17.1, 17.2, 18.2, 18.4
//
// Two halves:
//
//   - Logging. `server/sync.js` emits exactly one structured line per sync
//     request, built from a fixed vocabulary of four metadata fields plus a
//     reason and an error *class name*. These tests spy on the console and assert
//     on the whole of what was written — every key, not a sample — so no dish
//     name, ingredient, symptom, Bristol score, stress or sleep value, note text,
//     or Session_Token can reach a log line by any path, including a thrown error
//     that quotes the payload it was handling.
//
//   - Deletion. `POST /api/account/delete` lives in `server/index.js`, which
//     calls `serve()` at import time and so cannot be imported into a test. The
//     ordering Requirement 17.1 demands — events removed, *then* the user record,
//     success only after both — is therefore tested through `purgeEventData` and
//     the two stores, which is exactly what that route composes, rather than
//     through the route itself. `DELETE /api/sync/data`, which lives here in
//     `sync.js`, is driven end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eventStore,
  mealRecord,
  proUser,
  purgeEventData,
  pushBody,
  syncApp,
  syncCall,
  userStore,
  type WireRecord,
} from "./test/syncHarness";

// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { verifyToken } from "../server/auth.js";

const PUSH = "/api/sync/push";
const PULL = "/api/sync/pull";
const CLOUD_DELETE = "/api/sync/data";

/**
 * A Log_Event with something in every content field Requirement 18.4 excludes,
 * and values distinctive enough that a substring search over the log is a real
 * test rather than a coincidence.
 */
const SECRETS = [
  "Szechuan hotpot",
  "fermented garlic",
  "abdominal cramping",
  "unbearable",
  "private note about my gut",
];

function healthRecord(id: string): WireRecord {
  return mealRecord(id, {
    dish: "Szechuan hotpot",
    ingredients: ["fermented garlic", "chilli oil"],
    note: "private note about my gut",
    symptoms: [{ name: "abdominal cramping", severity: "unbearable" }],
    bristol: 6,
    stress: 4,
    sleep: 5,
  });
}

/** Every field name a Log_Event carries — none of which belongs in a log line. */
const CONTENT_KEYS = ["dish", "ingredients", "note", "symptoms", "bristol", "stress", "sleep"];

/** The whole vocabulary of a sync log line (Req 18.4). */
const LOG_KEYS = new Set(["method", "path", "status", "records", "user", "reason", "error"]);

let logged: string[];
let errored: string[];

const emitted = () => [...logged, ...errored];

/** Split one line into its fields, asserting it carries no key outside the set. */
function fields(line: string): Record<string, string> {
  expect(line.startsWith("sync ")).toBe(true);
  const parsed: Record<string, string> = {};
  for (const pair of line.slice("sync ".length).split(" ")) {
    const at = pair.indexOf("=");
    expect(at).toBeGreaterThan(0);
    const key = pair.slice(0, at);
    // Values are whitespace-collapsed by the logger, so splitting on spaces is
    // lossless — and a key outside this set would be a field nobody authorized.
    expect(LOG_KEYS.has(key)).toBe(true);
    parsed[key] = pair.slice(at + 1);
  }
  return parsed;
}

/** Nothing a Log_Event or a Session_Token holds appears anywhere in the log. */
function expectRedacted(token: string) {
  const all = emitted().join("\n");
  for (const secret of SECRETS) expect(all).not.toContain(secret);
  for (const key of CONTENT_KEYS) expect(all).not.toContain(key);
  expect(all).not.toContain(token);
}

beforeEach(() => {
  logged = [];
  errored = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errored.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Redacted request logging (Req 18.4, 18.5)
// ---------------------------------------------------------------------------

describe("request logging", () => {
  it("writes one metadata-only line for a push carrying health data", async () => {
    const app = syncApp();
    const { email, token } = await proUser();

    const res = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      body: pushBody([healthRecord("log-1"), healthRecord("log-2")]),
    });
    expect(res.status).toBe(200);

    expect(errored).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(fields(logged[0])).toEqual({
      method: "POST",
      path: PUSH,
      status: "200",
      // A count is metadata about the request; the records themselves never leave
      // the handler.
      records: "2",
      user: email,
    });
    expectRedacted(token);
  });

  it("writes one line for a pull, counting the records served and no more", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();
    await store.push(email, [healthRecord("log-3")]);

    const res = await syncCall(app, { method: "GET", path: `${PULL}?limit=500`, token });
    expect(res.status).toBe(200);
    // The served page really does carry the content — it is the log that must not.
    expect(res.body.records[0].dish).toBe("Szechuan hotpot");

    expect(logged).toHaveLength(1);
    expect(fields(logged[0])).toEqual({
      method: "GET",
      // The query string is where a cursor or limit would be, and it is not logged.
      path: PULL,
      status: "200",
      records: "1",
      user: email,
    });
    expectRedacted(token);
  });

  it("logs a rejected request by its reason code, never by its payload", async () => {
    const app = syncApp();
    const { email, token } = await proUser();

    const res = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      body: pushBody([healthRecord("log-4"), healthRecord("log-4")]),
    });
    expect(res.status).toBe(400);

    expect(logged).toHaveLength(1);
    expect(fields(logged[0])).toEqual({
      method: "POST",
      path: PUSH,
      status: "400",
      records: "2",
      user: email,
      // One of the module's own fixed codes — the same short string the response
      // body carries.
      reason: "invalid_record",
    });
    expectRedacted(token);
  });

  it("logs an unverified request with no identity and no token", async () => {
    const app = syncApp();
    const token = "not.a.valid.token";

    const res = await syncCall(app, { method: "GET", path: PULL, token });
    expect(res.status).toBe(401);

    expect(logged).toHaveLength(1);
    expect(fields(logged[0])).toEqual({
      method: "GET",
      path: PULL,
      status: "401",
      records: "-",
      user: "-",
      reason: "unauthorized",
    });
    expect(emitted().join("\n")).not.toContain(token);
  });

  it("reduces a thrown Error to its class name and answers generically", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();

    // The realistic leak: an error raised while handling a payload is free to
    // quote that payload in its message and its stack.
    vi.spyOn(store as any, "push").mockRejectedValue(
      new Error(`failed writing dish=Szechuan hotpot note=private note about my gut`)
    );

    const res = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      body: pushBody([healthRecord("log-5")]),
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "server_error" });

    // 5xx to console.error, and still exactly one line.
    expect(logged).toEqual([]);
    expect(errored).toHaveLength(1);
    expect(fields(errored[0])).toEqual({
      method: "POST",
      path: PUSH,
      status: "500",
      records: "1",
      user: email,
      reason: "server_error",
      error: "Error",
    });
    expectRedacted(token);
  });

  it("reduces a thrown string to its type name rather than printing it", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();

    // A non-Error throw escapes Hono's error handler, which is why the outermost
    // middleware catches too — and why the label is a type name, not the value.
    vi.spyOn(store as any, "pull").mockImplementation(() => {
      throw "dish=Szechuan hotpot";
    });

    const res = await syncCall(app, { method: "GET", path: PULL, token });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "server_error" });
    expect(logged).toEqual([]);
    expect(errored).toHaveLength(1);
    expect(fields(errored[0])).toEqual({
      method: "GET",
      path: PULL,
      status: "500",
      records: "-",
      user: email,
      reason: "server_error",
      error: "String",
    });
    expectRedacted(token);
  });
});

// ---------------------------------------------------------------------------
// Deleting the cloud copy (Req 17.4) and the account (Req 17.1, 17.2)
// ---------------------------------------------------------------------------

describe("cloud copy deletion", () => {
  it("removes every stored record, keeps the account, and invalidates the cursor", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();
    const users = await userStore();
    await store.push(email, [healthRecord("del-1"), healthRecord("del-2")]);

    const issued = await syncCall(app, { method: "GET", path: PULL, token });
    expect(issued.body.records).toHaveLength(2);

    const res = await syncCall(app, { method: "DELETE", path: CLOUD_DELETE, token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deleted: 2 });
    expect(await store.countFor(email)).toBe(0);

    // The account and its entitlement live in the user store and are untouched.
    expect(await users.getUser(email)).toMatchObject({ email, pro: true });
    expect(verifyToken(token)).toBe(email);

    // Every cursor issued before the purge now reports invalid, so a device
    // holding one re-enqueues its timeline instead of skipping it (Req 17.5).
    const stale = await syncCall(app, {
      method: "GET",
      path: `${PULL}?cursor=${encodeURIComponent(issued.body.cursor)}`,
      token,
    });
    expect(stale.status).toBe(200);
    expect(stale.body.error).toBe("cursor_invalid");

    // The count is what the log may carry, and all of it.
    expect(logged.map(fields)).toEqual([
      { method: "GET", path: PULL, status: "200", records: "2", user: email },
      { method: "DELETE", path: CLOUD_DELETE, status: "200", records: "2", user: email },
      { method: "GET", path: PULL, status: "200", records: "0", user: email, reason: "cursor_invalid" },
    ]);
    expectRedacted(token);
  });

  it("reports failure without deleting anything when the purge fails", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();
    const users = await userStore();
    await store.push(email, [healthRecord("del-3")]);

    vi.spyOn(store as any, "deleteAll").mockRejectedValue(new Error("store unavailable"));

    const res = await syncCall(app, { method: "DELETE", path: CLOUD_DELETE, token });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("delete_incomplete");

    vi.restoreAllMocks();
    // Nothing was removed, and the account is still usable, so the client can
    // simply repeat the request (Req 17.2).
    expect(await store.countFor(email)).toBe(1);
    expect(await users.getUser(email)).toMatchObject({ email, pro: true });
    expect(verifyToken(token)).toBe(email);
  });
});

describe("account deletion ordering", () => {
  // NOTE: `POST /api/account/delete` cannot be exercised here — it is defined in
  // `server/index.js`, which calls `serve()` at import time and would start a
  // listener. What that route does is `purgeEventData(email)` and then, only on
  // success, `store.deleteUser(email)`; both steps are tested below in that order
  // through the same helpers the route uses.

  it("purges every stored record before the user record is removed", async () => {
    const { email, token } = await proUser();
    const store = await eventStore();
    const users = await userStore();
    await store.push(email, [healthRecord("acct-1"), healthRecord("acct-2")]);

    // Step 1 — events. The user record is deliberately still present afterwards:
    // removing it first would drop the entitlement `/api/sync/*` checks and leave
    // the stored events unreachable through any authenticated path (Req 17.1).
    const purge = await purgeEventData(email);
    expect(purge).toMatchObject({ ok: true, deleted: 2 });
    expect(await store.countFor(email)).toBe(0);
    expect(await users.getUser(email)).toMatchObject({ email });

    // Step 2 — the user record, and success only after both.
    await users.deleteUser(email);
    expect(await users.getUser(email)).toBeNull();

    // Repeating the purge on an already-empty user succeeds with nothing to do,
    // which is the idempotence Requirement 17.2 asks for.
    expect(await purgeEventData(email)).toMatchObject({ ok: true, deleted: 0 });
    expect(errored).toEqual([]);
    expectRedacted(token);
  });

  it("fails safe when the purge outruns its deadline", async () => {
    const { email, token } = await proUser();
    const store = await eventStore();
    const users = await userStore();
    await store.push(email, [healthRecord("acct-3")]);

    // A purge that never lands: the deadline reports, and reports honestly.
    vi.spyOn(store as any, "deleteAll").mockImplementation(() => new Promise(() => {}));

    const purge = await purgeEventData(email, 20);
    expect(purge).toEqual({ ok: false, reason: "timeout" });

    vi.restoreAllMocks();
    // The user record, the entitlement, and the Session_Token all survive, so the
    // account remains usable and the request can be repeated (Req 17.2).
    expect(await store.countFor(email)).toBe(1);
    expect(await users.getUser(email)).toMatchObject({ email, pro: true });
    expect(verifyToken(token)).toBe(email);
  });

  it("fails safe when the purge errors", async () => {
    const { email, token } = await proUser();
    const store = await eventStore();
    const users = await userStore();
    await store.push(email, [healthRecord("acct-4")]);

    vi.spyOn(store as any, "deleteAll").mockRejectedValue(
      // A store error is free to quote the data it was handed; nothing here reads
      // its message (Req 18.5).
      new Error("write failed for dish=Szechuan hotpot")
    );

    const purge = await purgeEventData(email);
    expect(purge).toEqual({ ok: false, reason: "failed" });

    vi.restoreAllMocks();
    expect(await store.countFor(email)).toBe(1);
    expect(await users.getUser(email)).toMatchObject({ email, pro: true });
    expect(verifyToken(token)).toBe(email);
    expectRedacted(token);
  });
});
