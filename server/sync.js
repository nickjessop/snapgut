// HTTP shell for Cloud sync (the Sync_Service). Owns transport concerns only:
// protocol, payload size, rate limits, and session verification.
// Everything that touches stored Event_Records lives in `server/eventStore.js`.
//
// The routes live here rather than in `server/index.js` because that module calls
// `serve()` at import time, which makes it untestable in-process. `index.js`
// mounts this with one line, and tests mount the same `registerSyncRoutes` on a
// fresh `new Hono()` and drive it with `app.fetch(new Request(...))` — no
// listener, no port.

import { getStore, norm } from "./store.js";
import { verifyToken } from "./auth.js";
import { getEventStore, MAX_PULL_LIMIT, storableId } from "./eventStore.js";
import { clientIp } from "./clientIp.js";

// Module-scope secret used by verifyToken when no deps are injected (legacy tests).
const SECRET = process.env.SESSION_SECRET || "test-secret-for-vitest-only-do-not-use-in-production";

/** A sync request body may declare at most this many bytes (Req 19.1, 19.10). */
export const MAX_SYNC_BODY_BYTES = 1_048_576;

/** A push request may carry at most this many Event_Records (Req 19.2). */
export const MAX_RECORDS_PER_PUSH = 200;

/** An Event_Record may serialize to at most this many bytes (Req 19.3). */
export const MAX_RECORD_BYTES = 16_384;

/**
 * A user may hold at most this many stored Event_Records, Tombstones included
 * (Req 19.7, Decision D3 — an abuse ceiling, not a product limit).
 */
export const MAX_STORED_RECORDS = 100_000;

/** Rate limit windows, evaluated through the shared store (Req 19.4–19.6). */
export const RATE_WINDOW_MS = 60_000;
export const IP_REQUESTS_PER_WINDOW = 120;
export const USER_REQUESTS_PER_WINDOW = 60;

/**
 * A deletion request under Requirement 17 must finish within this long, and
 * report an error rather than a success when it does not (Req 17.1, 17.2, 18.11).
 */
export const DELETION_DEADLINE_MS = 30_000;

/** Context keys the middleware chain hands to the route handlers. */
const CTX_EMAIL = "syncEmail";
const CTX_LOG = "syncLogMeta";

/** The sync path for cloud data deletion. */
const CLOUD_DELETE_PATH = "/api/sync/data";

/**
 * The Client_IP, derived by the one shared trusted-proxy-aware implementation in
 * `server/clientIp.js` (Req 14.1a). Re-exported here so the existing importers of
 * this module keep working; the limits it keys are unchanged.
 */
export { clientIp };

/** The Session_Token, only when presented as a Bearer credential (Req 2.1). */
function bearer(c) {
  const h = c.req.header("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/**
 * Whole seconds until the current limit window resets, clamped to 1…60
 * (Req 19.4, 19.5).
 *
 * Derived from the same window `store.rateLimit` applies, which is what
 * Requirement 19.6 insists on: every backend counts into a fixed bucket keyed
 * `floor(now / windowMs)` (see `rateLimitWindow` in `server/store.js`), so the
 * wait reported here is the instant the limiter itself rolls over — not an
 * independent guess that could let a caller back in early or hold it out late.
 */
export function retryAfterSeconds(windowMs = RATE_WINDOW_MS, now = Date.now()) {
  const remaining = windowMs - (now % windowMs);
  return Math.min(60, Math.max(1, Math.ceil(remaining / 1000)));
}

function rateLimited(c) {
  noteReason(c, "rate_limited");
  const retry = retryAfterSeconds();
  c.header("Retry-After", String(retry));
  return c.json({ error: "rate_limited", retryAfterSeconds: retry }, 429);
}

/** The authenticated user identity — the only identity any handler may use. */
export function syncEmail(c) {
  return c.get(CTX_EMAIL);
}

// ---------------------------------------------------------------------------
// Redacted request logging (Req 18.4, 18.5, 18.10)
//
// Requirement 18.4 names exactly four things a log entry may carry — endpoint,
// status, record count, user identity — and everything a Log_Event holds is on
// the exclusion list, along with the Session_Token. That is an easier property to
// hold by construction than by discipline, so this is the *only* place in the
// module that writes to the log, and it emits a fixed set of fields built from
// values it derives itself rather than anything it is handed:
//
//   - the endpoint comes from the method and `c.req.path`, never the query string
//     (which is where a cursor or limit would be) and never a header;
//   - the status comes from the response;
//   - the record count is an integer, counted, never a record;
//   - the identity is the verified email from step 4, never a body or query field.
//
// Nothing else can reach a log line. A caught error contributes its *class name*
// only — never `message`, never `stack`, never the value thrown — because an
// error raised while handling a payload is the one realistic way event content
// could travel into a log: a JSON or store error is free to quote the offending
// value in its message, and interpolating the error object would print it (and
// its stack) verbatim. A class name cannot carry a dish name, and a non-Error
// throw of a string full of note text labels as `String`.
//
// There is no captured request body anywhere in this module, which is the other
// half of Requirement 18.5, and no destination other than the process log, which
// is the Requirement 18.10 half: no analytics, monitoring, or crash reporter sees
// any of this.
// ---------------------------------------------------------------------------

/** Field order of a log line — the whole vocabulary, and all of it metadata. */
const LOG_FIELDS = ["method", "path", "status", "records", "user", "reason", "error"];

/**
 * One field value, reduced to something that cannot break the line or smuggle
 * content: printable ASCII only, whitespace collapsed, and truncated. Applied to
 * every value including ones this module derives itself, so a request path with
 * odd bytes in it cannot forge a second log line.
 */
function safeValue(value) {
  return String(value)
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

/** A count, or `-` when the request had none to count. */
function safeCount(value) {
  return Number.isFinite(value) ? String(Math.trunc(value)) : "-";
}

/**
 * A label for a caught error: its class name, and nothing that came from its
 * message, its stack, or the thrown value. Anything that does not look like a
 * class name at all degrades to `Error` rather than being printed.
 */
export function errorLabel(err) {
  const name = err?.constructor?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "Error";
}

/**
 * Emit one structured line for one request (Req 18.4).
 *
 * Exactly one line per request, `key=value` separated by spaces, so a reader — or
 * a test — can assert on the whole of what was logged rather than on a sample of
 * it. 5xx goes to `console.error` and everything else to `console.log`, so the
 * severity split matches the status without changing the shape.
 */
export function logSyncRequest({ method, path, status, records, user, reason, error }) {
  const values = {
    method: safeValue(method || "-"),
    path: safeValue(path || "-"),
    status: safeCount(status),
    records: safeCount(records),
    user: safeValue(user || "-"),
    reason: reason ? safeValue(reason) : null,
    error: error ? safeValue(error) : null,
  };
  const line =
    "sync " +
    LOG_FIELDS.filter((key) => values[key] !== null)
      .map((key) => `${key}=${values[key]}`)
      .join(" ");
  if (Number(status) >= 500) console.error(line);
  else console.log(line);
}

/** The mutable log metadata for this request, created on first use. */
function logMeta(c) {
  let meta = c.get(CTX_LOG);
  if (!meta) {
    meta = {};
    c.set(CTX_LOG, meta);
  }
  return meta;
}

/**
 * Emit this request's one line, at most once.
 *
 * Two paths can reach it — the normal one after the chain unwinds, and the error
 * boundary — and a request that takes both must still produce a single line, so
 * that "everything logged about this request" is one string a reader or a test can
 * check in full.
 */
function emitSyncLog(c, { method, path, status, reason, error }) {
  const meta = logMeta(c);
  if (meta.logged) return;
  meta.logged = true;
  logSyncRequest({
    method,
    path,
    status,
    records: meta.records,
    user: syncEmail(c),
    reason: reason ?? meta.reason,
    error: error ?? meta.error,
  });
}

/**
 * Record how many Event_Records this request carried or served. A count is
 * metadata about the request, not content from it (Req 18.4).
 */
function noteRecords(c, count) {
  logMeta(c).records = count;
}

/**
 * Record why this request ended the way it did. Callers pass one of this module's
 * own fixed reason strings — the same short codes the response body carries —
 * never a value read from the request and never an error message.
 */
function noteReason(c, reason) {
  logMeta(c).reason = reason;
}

/**
 * Read and parse a JSON request body under a hard byte budget (Req 19.10).
 *
 * `await c.req.json()` reads the whole body before anything can measure it, so a
 * chunked upload that declares no `Content-Length` slips straight past the
 * declared-size guard in step 2 of the chain. This reads `c.req.raw.body` chunk
 * by chunk instead, keeping a running byte count, and gives up the *moment* the
 * count passes `maxBytes`: it cancels the reader rather than draining the rest,
 * so an oversize body costs only the bytes already in flight.
 *
 * The result is a value, never a throw, so the caller can answer 413 or 400
 * without a try/catch:
 *
 *   { ok: true, value }              — parsed JSON, within budget
 *   { ok: false, reason: "too_large" } — over `maxBytes`; answer 413
 *   { ok: false, reason: "bad_json" }  — within budget but unparseable, or no
 *                                        body at all; answer 400, not a 500
 *
 * An absent body (`GET`, or a `POST` with none) and a zero-length body both land
 * on `bad_json`: there is no JSON value in either, and the distinction does not
 * matter to a caller that is about to reject the request anyway.
 */
export async function readJsonLimited(c, maxBytes = MAX_SYNC_BODY_BYTES) {
  const body = c.req.raw.body;
  if (!body) return { ok: false, reason: "bad_json" };

  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      bytes += value.byteLength;
      // Over budget: stop here. Cancelling releases the connection without
      // reading the remaining chunks (Req 19.10 "stop reading that request body").
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // A truncated or aborted stream is indistinguishable from malformed input
    // from here, and is the client's problem either way.
    await reader.cancel().catch(() => {});
    return { ok: false, reason: "bad_json" };
  }

  if (bytes === 0) return { ok: false, reason: "bad_json" };

  const buf = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { ok: false, reason: "bad_json" };
  }
}

// ---------------------------------------------------------------------------
// Push payload validation (Req 6.3, 6.10, 6.11, 16.2, 19.2, 19.3, 19.7, 19.12)
//
// Every check below runs *before* `eventStore.push`, which is what makes
// Requirement 6.10 all-or-nothing per request: a payload that fails any check
// never reaches the store, so zero Event_Records are written and no
// Server_Sequence is assigned.
//
// The reason strings are exactly the client's `RejectReason` union in
// `src/cloudSync.ts`, and the choice per id is load-bearing rather than
// cosmetic. `reconcileOutbox` treats `photo_field`, `record_too_large`, and
// `invalid_record` as permanent properties of the record — the id leaves the
// Outbox — and `record_limit`, `payload_too_large`, and `record_cap` as
// properties of the request, which keep the id queued for the next Sync_Cycle.
// Requirement 19.9 wants both halves of that at once: the ids a 400 *identifies*
// leave the Outbox, and every other id sent in the same request stays in it.
// ---------------------------------------------------------------------------

/**
 * The reason carried by an id that broke no check of its own and was rejected
 * only because a sibling record in the same request did (Req 6.10).
 *
 * The union offers no "some other record poisoned this request" reason, and the
 * choice is constrained from both sides: it must not be one of the three
 * permanent reasons, or Requirement 19.9's "retain in the Outbox every other
 * `id` sent in that request" would be violated and a perfectly good Log_Event
 * would never sync. Of the transient reasons, `record_cap` would have the client
 * announce a cloud limit that was not reached and `payload_too_large` a byte
 * limit that was not exceeded, so `record_limit` — the union's request-shape
 * reason, whose client response is "re-pack and send again next cycle" — is the
 * one that leaves the client doing the right thing.
 */
const COLLATERAL_REJECT_REASON = "record_limit";

/** Base64 alphabet plus the line breaks a wrapped payload carries (Req 16.2). */
const BASE64_ONLY = /^[A-Za-z0-9+/=\r\n]+$/;
const MAX_BASE64_FREE_LENGTH = 4_096;

/** How deep the photo scan descends before it stops looking. */
const MAX_PHOTO_SCAN_DEPTH = 16;

const encoder = new TextEncoder();

/**
 * The Requirement 16.2 shape of Photo data in a string: a data URL, or a run of
 * more than 4,096 characters containing nothing but base64 alphabet characters.
 * Mirrors `looksLikePhotoData` in `src/cloudSync.ts`, which is what stops the
 * client from ever building a payload this rejects.
 */
function looksLikePhotoData(value) {
  if (value.startsWith("data:")) return true;
  return value.length > MAX_BASE64_FREE_LENGTH && BASE64_ONLY.test(value);
}

/**
 * A binary value rather than event data. Unreachable through `JSON.parse`, which
 * yields only strings, numbers, booleans, `null`, arrays, and plain objects — but
 * the check costs nothing and keeps the rejection structural rather than a
 * promise about the value types this particular body parser happens to produce.
 */
function isBlobish(value) {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  return typeof value?.arrayBuffer === "function";
}

/**
 * True when a field value carries Photo data anywhere inside it.
 *
 * The scan descends because a field carrying unrecognized data from a newer
 * `schemaVersion` travels inline and may nest (Req 16.4), and a data URL buried
 * in a nested object is as much a Photo as one at the top level. Below the depth
 * ceiling the scan stops: the 16,384-byte per-record limit already bounds what
 * could hide down there to a fraction of a Photo.
 */
function carriesPhotoData(value, depth = 0) {
  if (typeof value === "string") return looksLikePhotoData(value);
  if (value === null || typeof value !== "object") return false;
  if (isBlobish(value)) return true;
  if (depth >= MAX_PHOTO_SCAN_DEPTH) return false;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.some((item) => carriesPhotoData(item, depth + 1));
}

/** Whether this Event_Record carries a Photo-bearing field (Req 16.2). */
function photoBearing(record) {
  if ("photo" in record) return true;
  return Object.values(record).some((value) => carriesPhotoData(value));
}

/** Serialized size of an Event_Record in bytes, as Requirement 19.3 measures it. */
function serializedBytes(record) {
  return encoder.encode(JSON.stringify(record)).length;
}

/**
 * The `id` this record can be identified by in the response, or `null` when it
 * has none. A record that is not an object, or whose `id` is not a non-empty
 * string, cannot be named in an outcome at all, which is why a payload carrying
 * one is rejected whole rather than partly stored.
 *
 * Being nameable is a weaker property than being *storable* — see the
 * `storableId` check in `validatePushPayload`, which rejects an id that can be
 * named in a response but cannot key a stored Event_Record (Req 6.3).
 */
function usableId(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const id = record.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function rejectedOutcome(id, reason) {
  return { id, outcome: "rejected", reason };
}

/** Distinct ids of a payload, in first-sent order. */
function distinctIds(records) {
  const ids = [];
  const seen = new Set();
  for (const record of records) {
    const id = usableId(record);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Which check to name at the top level when a payload broke several. All three
 * answer 400 and every offending id already carries its own reason, so this only
 * decides the summary; Photo data leads because it is the one check about content
 * that should never have left the device at all (Req 16.1).
 */
const ERROR_PRECEDENCE = ["photo_field", "record_too_large", "invalid_record"];

/**
 * Check one push payload, ahead of the store transaction.
 *
 * `{ ok: true, ids }` — the distinct ids in first-sent order, ready to store.
 * `{ ok: false, status, error, outcomes }` — a rejection reporting one outcome
 * for every id the request carried (Req 6.10, 6.11), by `id` alone (Req 19.12).
 *
 * The per-user stored-record cap is not checked here: it needs the current
 * stored count, which is the caller's one store read.
 */
function validatePushPayload(records) {
  // Req 19.2 — the whole request is over the record limit, which is a property of
  // the request rather than of any record in it, so every id reads transient and
  // the client re-packs (Req 19.9).
  if (records.length > MAX_RECORDS_PER_PUSH) {
    return {
      ok: false,
      status: 400,
      error: "record_limit",
      outcomes: distinctIds(records).map((id) => rejectedOutcome(id, "record_limit")),
    };
  }

  const ids = [];
  const seen = new Set();
  const duplicated = new Set();
  /** id → the permanent reason that id's own record earned. */
  const offenses = new Map();
  let unnamed = 0;

  for (const record of records) {
    const id = usableId(record);
    if (id === null) {
      unnamed += 1;
      continue;
    }
    if (seen.has(id)) duplicated.add(id);
    else {
      seen.add(id);
      ids.push(id);
    }
    if (offenses.has(id)) continue;
    // An `id` the store cannot key a record by (Req 6.3). Rejected here, per id,
    // rather than deeper down: `eventStore.assertPathSegment` *throws* on one of
    // these, which the error boundary answers with a 500 — and a 500 is transient
    // to the client, so the id would stay in the Outbox and the same unstorable
    // record would be re-sent every Sync_Cycle forever. Named as `invalid_record`,
    // it is a permanent property of the record, so the client drops the id and
    // keeps the Log_Event (Req 19.9).
    if (!storableId(id)) offenses.set(id, "invalid_record");
    else if (serializedBytes(record) > MAX_RECORD_BYTES)
      offenses.set(id, "record_too_large"); // Req 19.3
    else if (photoBearing(record)) offenses.set(id, "photo_field"); // Req 16.2
  }

  // One `id` carried more than once in a single payload (Req 6.5).
  //
  // A real client never does this: `planPush` emits one Event_Record per Outbox
  // id. It is rejected because the store cannot keep the push idempotence
  // Requirement 6.5 demands across two *different* records sharing an `id`. The
  // clock clamp of Requirement 8.8 is what breaks: the store recognizes a re-sent
  // far-future payload by the Revision_Time the clamp consumed for that `id`, and
  // it holds one such value per `id`. Two different records under one `id` leave
  // the second one's value recorded, so the re-send of the *first* is no longer
  // recognized and the stored revision drifts on every re-push. Refusing the
  // payload keeps the store's precondition — at most one record per `id` per
  // request — true by construction, and costs nothing a real client relies on.
  for (const id of duplicated) offenses.set(id, "invalid_record");

  if (offenses.size === 0 && unnamed === 0) return { ok: true, ids };

  const present = new Set(offenses.values());
  if (unnamed > 0) present.add("invalid_record");

  return {
    ok: false,
    status: 400,
    error: ERROR_PRECEDENCE.find((reason) => present.has(reason)) ?? "invalid_record",
    // Every id the request carried, each with its own reason where it broke a
    // check itself and the collateral reason where a sibling did (Req 6.10, 19.9).
    // A record with no usable `id` cannot appear here — there is nothing to name
    // it by, which is why the payload is rejected rather than partly stored.
    outcomes: ids.map((id) => rejectedOutcome(id, offenses.get(id) ?? COLLATERAL_REJECT_REASON)),
  };
}

// ---------------------------------------------------------------------------
// Deletion (Req 17.1, 17.2, 17.4, 18.11)
//
// Both deletion paths remove exactly the same thing — every stored Event_Record
// and every Tombstone for one user — and differ only in what happens afterwards:
// `DELETE /api/sync/data` keeps the account, `POST /api/account/delete` removes
// the user record next. They therefore share one purge helper, which is also
// where the 30-second deadline of Requirements 17.1 and 18.11 lives, so neither
// path can be the one that forgets it.
// ---------------------------------------------------------------------------

/** Sentinel resolved by the deadline timer, distinguishable from any store result. */
const DEADLINE_EXCEEDED = Symbol("deadline_exceeded");

/**
 * Delete every stored Event_Record and Tombstone for one user, under a deadline.
 *
 * `{ ok: true, deleted, epoch }` — the purge completed. `epoch` is the new purge
 * generation: bumping it is what makes every cursor issued before this request
 * report invalid on the next pull, so a device that still holds one re-enqueues
 * its timeline instead of silently skipping records (Req 13.13, 17.5).
 *
 * `{ ok: false, reason }` — the purge did not complete, either because it
 * outran the deadline (`"timeout"`, Req 17.2) or because the store failed
 * (`"failed"`). The caller must answer with an error status and change nothing
 * else: Requirement 17.2 wants the user record and the Session_Token both still
 * valid so the client can simply repeat the request.
 *
 * Repeating it is safe. `deleteAll` on an already-empty user reports
 * `deleted: 0` and succeeds, which is the idempotence Requirement 17.2 asks for.
 *
 * The timeout is a report, not a cancellation — a store write already in flight
 * is not recalled, and a purge that lands a moment after the deadline simply
 * leaves the retry with less to do. Nothing here reads or logs Log_Event content,
 * not even from a caught error (Req 18.5).
 */
export async function purgeEventData(email, deadlineMs = DELETION_DEADLINE_MS, injectedEventStore = null) {
  let timer;
  try {
    const purge = (async () => {
      const store = injectedEventStore || await getEventStore();
      return store.deleteAll(email);
    })();
    const result = await Promise.race([
      purge,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), deadlineMs);
      }),
    ]);
    if (result === DEADLINE_EXCEEDED) return { ok: false, reason: "timeout" };
    return { ok: true, deleted: result.deleted, epoch: result.epoch };
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Retention — settled: stored Event_Records are retained indefinitely
//
// A user's stored Event_Records are kept for as long as the account exists. There
// is no retention window and no automatic purge, so there is nothing here for a
// request to evaluate: the middleware chain below has no retention step, and the
// only thing that ever empties a user is a deletion they asked for
// (`DELETE /api/sync/data`, Req 17.4, or account deletion, Req 17.1). Worth
// stating as an absence, so a reader looking for the retention step can stop.
//
// The `epoch` in the Sync_Cursor is what Requirement 17.4 needs on its own:
// `deleteAll` bumps it so every cursor issued before a deletion is reported
// invalid on the next pull, and the client re-enqueues its timeline instead of
// silently skipping it (Req 13.13, 17.5).
// ---------------------------------------------------------------------------

/**
 * Mount the sync endpoints and their middleware chain on a Hono app.
 *
 * The chain order below is part of the design, not an implementation detail:
 * Requirement 2.10 requires auth to complete before any stored Event_Record is
 * read or written. Registering the guards as middleware — and reading the body
 * only inside the handlers — makes that true by construction: no handler runs
 * until every guard has passed.
 */
export function registerSyncRoutes(app, injectedDeps = null) {
  // When deps are injected, use them directly; otherwise fall back to the module-scope
  // singletons (getStore/getEventStore) for backward compatibility with existing tests.
  const resolveStore = injectedDeps ? () => Promise.resolve(injectedDeps.store) : getStore;
  const resolveEventStore = injectedDeps ? () => Promise.resolve(injectedDeps.eventStore) : getEventStore;
  const resolveSecret = injectedDeps ? injectedDeps.secret : SECRET;
  // 0a. The error boundary for an unexpected throw (Req 18.5).
  //
  //     Registered as the app's error handler rather than as a `try` around
  //     `next()`, because Hono's `compose` catches a thrown `Error` at the level
  //     that threw it and hands it to the app's error handler *there* — so an
  //     outer middleware's `catch` never sees it. Left unset, the default handler
  //     runs `console.error(err)`, which prints the message and the whole stack:
  //     the one realistic way a dish name or a note could reach the log, since an
  //     error raised while handling a payload is free to quote the payload.
  //
  //     Sync paths therefore get the generic body Requirement 18.5 specifies and a
  //     log line carrying the error's class name alone. The label and reason are
  //     stashed rather than logged here, so the line is emitted once, by 0b, with
  //     the record count the handler had already counted.
  //
  //     Every other route keeps the default behavior exactly: this module has no
  //     business changing how `/api/recognize` reports a failure.
  app.onError((err, c) => {
    if (c.req.path.startsWith("/api/sync/")) {
      const meta = logMeta(c);
      meta.reason = "server_error";
      meta.error = errorLabel(err);
      return c.json({ error: "server_error" }, 500);
    }
    // Same two branches Hono's own default handler has, so an `HTTPException`
    // raised by, say, the `/api/*` size guard still answers with its own response.
    if (err && typeof err.getResponse === "function") return err.getResponse();
    console.error(err);
    return c.text("Internal Server Error", 500);
  });

  // 0b. The redacted request log (Req 18.4).
  //
  //     Outermost of the middleware, so every sync response gets exactly one line
  //     — including the ones the guards below return, where there is no identity
  //     yet and `user` reads `-`.
  //
  //     The `catch` covers what 0a cannot: `compose` only routes a thrown `Error`
  //     to the error handler and rethrows anything else, so a `throw "…"` of a
  //     string built from a payload would otherwise escape the process. It is
  //     logged the same way — class name only, so the string's contents are never
  //     printed — and answered with the same generic 500.
  app.use("/api/sync/*", async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    try {
      await next();
    } catch (err) {
      emitSyncLog(c, { method, path, status: 500, reason: "server_error", error: errorLabel(err) });
      return c.json({ error: "server_error" }, 500);
    }
    emitSyncLog(c, { method, path, status: c.res.status });
  });

  // 1. (removed — HTTPS enforcement is now a global opt-in via REQUIRE_HTTPS in config)

  // 2. Declared body size (Req 19.1). The global `/api/*` guard in `index.js`
  //    only rejects above 8 MiB, so `/api/sync/*` needs its own tighter check.
  //    A body with no `Content-Length`, or one that lies about it, is caught
  //    while streaming instead — see `readJsonLimited` (Req 19.10).
  app.use("/api/sync/*", async (c, next) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SYNC_BODY_BYTES) {
      noteReason(c, "payload_too_large");
      return c.json({ error: "payload_too_large" }, 413);
    }
    return next();
  });

  // 3. Per-IP rate limit (Req 19.5). Before auth, because it needs no identity
  //    and shields the HMAC verification itself from a flood.
  app.use("/api/sync/*", async (c, next) => {
    const store = await resolveStore();
    const ok = await store.rateLimit(
      `sync-ip:${clientIp(c)}`,
      IP_REQUESTS_PER_WINDOW,
      RATE_WINDOW_MS
    );
    if (!ok) return rateLimited(c);
    return next();
  });

  // 4. Session verification (Req 2.1). Before any event access (Req 2.10).
  //    The identity it yields is the *only* identity
  //    used downstream: a user or email carried by the body or query string is
  //    never read (Req 2.4, 2.5).
  app.use("/api/sync/*", async (c, next) => {
    const email = verifyToken(bearer(c), resolveSecret);
    if (!email) {
      noteReason(c, "unauthorized");
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set(CTX_EMAIL, norm(email));
    return next();
  });

  // 5. Per-user rate limit (Req 19.4, 19.6), keyed by the verified identity.
  app.use("/api/sync/*", async (c, next) => {
    const store = await resolveStore();
    const ok = await store.rateLimit(
      `sync-user:${syncEmail(c)}`,
      USER_REQUESTS_PER_WINDOW,
      RATE_WINDOW_MS
    );
    if (!ok) return rateLimited(c);
    return next();
  });

  // 6. Body read and validation happen inside the handlers, which by definition
  //    run only after every guard above has passed. `readJsonLimited` does the
  //    byte-counted read; record count, per-record size, photo fields, and the
  //    stored-record cap are checked before the store transaction so a rejected
  //    request stores nothing (Req 6.10).

  /**
   * Store up to 200 Event_Records for the authenticated user, all-or-nothing.
   *
   * Every response — stored or rejected — carries one outcome per `id` the
   * request sent (Req 6.11), `highestSequence` (`null` when nothing was stored).
   *
   * A rejection names ids and nothing else: no Log_Event content, no note text,
   * no Session_Token (Req 19.12).
   */
  app.post("/api/sync/push", async (c) => {
    const now = Date.now();
    const email = syncEmail(c);

    const body = await readJsonLimited(c);
    if (!body.ok) {
      // A body that outran the budget while streaming — no `Content-Length`, or a
      // dishonest one (Req 19.10). The exact body Requirement 19.1 specifies.
      if (body.reason === "too_large") {
        noteReason(c, "payload_too_large");
        return c.json({ error: "payload_too_large" }, 413);
      }
      noteReason(c, "invalid_request");
      return c.json(
        { error: "invalid_request", outcomes: [], highestSequence: null },
        400
      );
    }

    const records = body.value?.records;
    if (!Array.isArray(records)) {
      noteReason(c, "invalid_request");
      return c.json(
        { error: "invalid_request", outcomes: [], highestSequence: null },
        400
      );
    }

    // The count, which the log line may carry — the records themselves never
    // leave this handler (Req 18.4).
    noteRecords(c, records.length);

    const verdict = validatePushPayload(records);
    if (!verdict.ok) {
      noteReason(c, verdict.error);
      return c.json(
        {
          error: verdict.error,
          outcomes: verdict.outcomes,
          highestSequence: null,
        },
        verdict.status
      );
    }

    const store = await resolveEventStore();

    // Req 19.7 — the stored-record cap, the last check before the transaction.
    //
    // `verdict.ids.length` is an upper bound on how far this request could raise
    // the count: an `id` already stored replaces its record rather than adding
    // one. Bounding it that way over-rejects only a request that is already at
    // the ceiling, and the alternative — reading every id to see which are new —
    // would touch stored Event_Records on the way to refusing them. The cap is an
    // abuse ceiling roughly 45 years of logging away (Decision D3), so the
    // conservative side is the right side.
    const storedCount = await store.countFor(email, now);
    if (storedCount + verdict.ids.length > MAX_STORED_RECORDS) {
      noteReason(c, "record_cap");
      return c.json(
        {
          error: "record_cap",
          limit: MAX_STORED_RECORDS,
          storedCount,
          // Transient for every id, so the client keeps them queued and they land
          // once the cap is freed (Req 19.11).
          outcomes: verdict.ids.map((id) => rejectedOutcome(id, "record_cap")),
          highestSequence: null,
        },
        409
      );
    }

    // Validation is complete, so the store may be written: one atomic step that
    // merges each record, assigns Server_Sequence values above every value
    // previously assigned for this user, and reports one outcome per id sent
    // (Req 6.3, 6.4, 6.5, 6.11).
    const { outcomes, highestSequence } = await store.push(email, records, now);
    return c.json({ outcomes, highestSequence }, 200);
  });

  /**
   * Serve the next page of at most 500 Event_Records for the authenticated user,
   * ordered by ascending Server_Sequence (Req 7.1, 7.2).
   *
   * `cursor` and `limit` are the only inputs read from the request, both from the
   * query string. No identity is read from the query string or the body: the user
   * whose records are served is the one the Session_Token verified in step 4
   * (Req 2.4, 2.5). That is also the whole of the cross-user isolation story here
   * — the store is keyed by that email and a caller can only ever address its own
   * subtree (Req 18.1), so an `id` stored under another identity does not match
   * and the page comes back as though no such record exists, with no ownership
   * comparison to get wrong (Req 18.2).
   *
   * A page carries the Server_Sequence of its last record as the `cursor` to
   * present next and `hasMore` for whether records remain beyond it (Req 7.2).
   */
  app.get("/api/sync/pull", async (c) => {
    const now = Date.now();
    const cursor = c.req.query("cursor") ?? null;
    // An absent, empty, or non-numeric `limit` means the full page. The store
    // clamps whatever it is given into 1…500, so this need not (Req 7.2).
    const requested = Number(c.req.query("limit"));
    const limit = Number.isFinite(requested) ? requested : MAX_PULL_LIMIT;

    const store = await resolveEventStore();
    const page = await store.pull(syncEmail(c), cursor, limit, now);

    // A cursor from a superseded purge generation — or one that is not a cursor at
    // all. Answered with the reset signal rather than data, which is what makes
    // the client drop its cursor and re-enqueue its whole timeline instead of
    // silently skipping it (Req 13.13, 17.5).
    //
    // Deliberately a 200 carrying `error`, not a 4xx: Requirement 7.5 has the
    // client treat a failed pull as an error that retains the cursor and retries,
    // which is the opposite of the reset Requirement 13.13 wants. Keeping this
    // inside the success range keeps the two paths distinguishable by body rather
    // than by status. It carries neither `records` nor `hasMore`, so it cannot be
    // mistaken for an empty final page — the one that completes a pull (Req 7.8).
    if (page.cursorInvalid) {
      noteReason(c, "cursor_invalid");
      noteRecords(c, 0);
      return c.json({ error: "cursor_invalid", cursor: null }, 200);
    }

    // How many records this page served. The page itself goes to the client and
    // nowhere near the log (Req 18.4).
    noteRecords(c, page.records.length);

    return c.json(
      { records: page.records, cursor: page.cursor, hasMore: page.hasMore },
      200
    );
  });

  /**
   * Delete the cloud copy while keeping the account (Req 17.4).
   *
   * Removes every stored Event_Record and Tombstone for the authenticated user and
   * bumps the purge generation. The user record lives in `store.js` and is not
   * touched, so the account stays usable and a later re-enable starts from an
   * empty cloud with a cursor the client knows is stale.
   *
   * Local data is the client's business: on success it disables the destination,
   * resets the cursor, clears the Outbox, and keeps every Log_Event and Photo on
   * the device (Req 17.5). Nothing here can affect that, which is why the failure
   * path only has to be honest about not having deleted anything.
   */
  app.delete(CLOUD_DELETE_PATH, async (c) => {
    const eStore = await resolveEventStore();
    const purge = await purgeEventData(syncEmail(c), undefined, eStore);

    if (!purge.ok) {
      // Deletion did not complete, so this must not read as success: the client
      // keeps the destination enabled and its cursor, and offers a retry. The
      // reason is one of `purgeEventData`'s two fixed codes — `timeout` or
      // `failed` — and never a store error's message (Req 18.5).
      noteReason(c, `delete_incomplete_${purge.reason}`);
      noteRecords(c, 0);
      return c.json({ error: "delete_incomplete" }, 500);
    }

    // The number of records removed, which is what an operator needs to see and
    // all they may see (Req 18.4).
    noteRecords(c, purge.deleted);

    return c.json({ ok: true, deleted: purge.deleted }, 200);
  });

  return app;
}
