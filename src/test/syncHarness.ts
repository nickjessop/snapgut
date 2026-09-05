// Harness for driving the Sync_Service HTTP shell in-process.
//
// `server/sync.js` exists as its own module precisely so that it can be mounted
// on a fresh `new Hono()` and driven with `app.fetch(new Request(...))` — no
// listener, no port, no `serve()`. Everything below is the plumbing for that:
// building a request, minting a real Session_Token, and reaching the in-memory
// backends to seed and inspect state.
//
// Two things about that state are worth stating once here rather than in every
// test:
//
//   - `getStore()` and `getEventStore()` memoize one backend per module registry,
//     and Vitest gives each test *file* its own registry — so state is shared
//     across the tests within a file and isolated between files.
//   - The rate-limit counters live in that shared store, keyed by IP and by
//     email. Both `uniqueEmail` and `uniqueIp` therefore hand out a fresh key
//     every call, so one test's traffic can never spend another's budget.

import { Hono } from "hono";

// The Sync_Service is plain ESM JavaScript with no type declarations, so each
// module is imported untyped and given a local shape below. `@ts-ignore`
// suppresses the *following line* only, and the missing-declaration error is
// reported on the line carrying the module specifier — hence a namespace import
// for `sync.js`, whose named exports the tests reach through the typed
// re-exports further down.
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import * as syncModule from "../../server/sync.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { signToken } from "../../server/auth.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { getStore } from "../../server/store.js";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { getEventStore } from "../../server/eventStore.js";

// ---------------------------------------------------------------------------
// Local typing of the untyped server modules
// ---------------------------------------------------------------------------

/** A wire Event_Record, as the client pushes and the server stores it. */
export type WireRecord = Record<string, unknown>;

export interface PushResult {
  outcomes: { id: string; outcome: string }[];
  stored: number;
  highestSequence: number | null;
}

export interface PullPage {
  cursorInvalid: boolean;
  records: WireRecord[];
  cursor: string | null;
  hasMore: boolean;
}

export interface EventStore {
  push(email: string, records: WireRecord[], now?: number): Promise<PushResult>;
  pull(email: string, cursor?: string | null, limit?: number, now?: number): Promise<PullPage>;
  deleteAll(email: string): Promise<{ deleted: number; epoch: number }>;
  countFor(email: string, now?: number): Promise<number>;
  getMeta(email: string): Promise<{ seq: number; epoch: number }>;
}

export interface UserRecord {
  email: string;
}

export interface UserStore {
  getUser(email: string): Promise<UserRecord | null>;
  upsertUser(email: string): Promise<UserRecord>;
  deleteUser(email: string): Promise<void>;
  rateLimit(key: string, max: number, windowMs: number): Promise<boolean>;
}

export const userStore = (): Promise<UserStore> => getStore() as Promise<UserStore>;
export const eventStore = (): Promise<EventStore> => getEventStore() as Promise<EventStore>;

// The limits the routes enforce, read from the module under test rather than
// restated, so a test can never assert against a stale copy of a constant.
export const MAX_SYNC_BODY_BYTES: number = syncModule.MAX_SYNC_BODY_BYTES;
export const MAX_RECORDS_PER_PUSH: number = syncModule.MAX_RECORDS_PER_PUSH;
export const MAX_RECORD_BYTES: number = syncModule.MAX_RECORD_BYTES;
export const RATE_WINDOW_MS: number = syncModule.RATE_WINDOW_MS;
export const IP_REQUESTS_PER_WINDOW: number = syncModule.IP_REQUESTS_PER_WINDOW;
export const USER_REQUESTS_PER_WINDOW: number = syncModule.USER_REQUESTS_PER_WINDOW;

/** `purgeEventData`, the helper both deletion paths share (Req 17.1, 17.2). */
export const purgeEventData = (
  email: string,
  deadlineMs?: number
): Promise<{ ok: boolean; deleted?: number; epoch?: number; reason?: string }> =>
  syncModule.purgeEventData(email, deadlineMs);

/** The Session_Token verifier's own signer — a real token, not a stub. */
export const mintToken = (email: string): string =>
  signToken(email, process.env.SESSION_SECRET || "test-secret-for-vitest-only-do-not-use-in-production") as string;

// ---------------------------------------------------------------------------
// Fresh app, fresh identities
// ---------------------------------------------------------------------------

/** A Hono app carrying nothing but the sync routes and their middleware chain. */
export function syncApp(): Hono {
  const app = new Hono();
  syncModule.registerSyncRoutes(app);
  return app;
}

let counter = 0;
const nextId = () => ++counter;

/** An email no other test in this file has used, so rate-limit budgets are per-test. */
export function uniqueEmail(label = "user"): string {
  return `${label}-${nextId()}@example.com`;
}

/** A client IP no other test in this file has used, for the same reason. */
export function uniqueIp(): string {
  return `198.51.100.${nextId()}`;
}

/** A user record plus a valid Session_Token for it. All features are ungated. */
export async function proUser(label = "pro"): Promise<{ email: string; token: string }> {
  const email = uniqueEmail(label);
  const store = await userStore();
  await store.upsertUser(email);
  return { email, token: mintToken(email) };
}

/** A user record with no Pro_Entitlement, plus a valid Session_Token for it. */
export async function freeUser(label = "free"): Promise<{ email: string; token: string }> {
  const email = uniqueEmail(label);
  const store = await userStore();
  await store.upsertUser(email);
  return { email, token: mintToken(email) };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface SyncRequestInit {
  method?: string;
  /** Path only — the harness supplies an origin the routes never look at. */
  path: string;
  /** Omitted means no `Authorization` header at all. */
  token?: string | null;
  /** Omitted means a fresh IP; pass one to share a rate-limit bucket on purpose. */
  ip?: string;
  /** Serialized to JSON, with a matching `Content-Type` and `Content-Length`. */
  body?: unknown;
  /** A body sent verbatim, for malformed JSON. */
  bodyText?: string;
  /** A body with no `Content-Length`, for the streaming size guard. */
  bodyStream?: ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
}

/** Drive one request through the mounted chain and hand back the response. */
export function syncFetch(app: Hono, init: SyncRequestInit): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  headers.set("x-forwarded-for", init.ip ?? uniqueIp());

  let body: BodyInit | undefined;
  if (init.bodyStream) {
    body = init.bodyStream as unknown as BodyInit;
  } else if (init.bodyText !== undefined) {
    body = init.bodyText;
    headers.set("content-type", "application/json");
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set("content-type", "application/json");
  }

  const request = new Request(`http://sync.test${init.path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    // Required by Node whenever the body is a stream.
    ...(init.bodyStream ? { duplex: "half" } : {}),
  } as RequestInit);

  // `app.fetch` is typed as returning a Response *or* a promise of one; every
  // caller here awaits, so it is normalized to a promise.
  return Promise.resolve(app.fetch(request));
}

/** Status plus parsed body, which is what nearly every assertion here wants. */
export async function syncCall(
  app: Hono,
  init: SyncRequestInit
): Promise<{ status: number; body: any; res: Response }> {
  const res = await syncFetch(app, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

let clock = Date.UTC(2025, 0, 1);

/**
 * A small, valid meal Event_Record. Revision_Times advance with each call so
 * generated records never tie, and stay well inside the clock-skew window.
 */
export function mealRecord(id: string, overrides: WireRecord = {}): WireRecord {
  const at = (clock += 1_000);
  return { id, type: "meal", createdAt: at, updatedAt: at, dish: "oatmeal", ...overrides };
}

/** A push body carrying the given records. */
export const pushBody = (records: WireRecord[]) => ({ records });
