// @vitest-environment node
//
// Sync_Service route tests — the HTTP shell of `server/sync.js`, driven in
// process.
//
// Validates: Requirements 2.5, 2.6, 2.10, 6.10, 6.11, 7.2, 18.2, 19.1, 19.4, 19.5, 19.6, 19.10
//
// `registerSyncRoutes` is mounted on a fresh `new Hono()` and driven with
// `app.fetch(new Request(...))` against the in-memory event store — no listener,
// no port, and no mocking of the middleware chain, so what these tests exercise
// is the real order of the real guards:
//
//   protocol 400 → declared `Content-Length` 413 → per-IP 429 → 401 →
//   per-user 429 → 402 → handler
//
// There is no retention step: Decision D1 settled on retaining a lapsed user's
// Event_Records indefinitely, so nothing between the Pro gate and the handler
// evaluates a retention window.
//
// The node environment is deliberate: the chain reads `c.req.raw.body` as a
// stream, and the streaming size guard of Requirement 19.10 needs a real
// `ReadableStream` request body, which jsdom does not provide.
//
// Redaction (Req 18.4) and deletion (Req 17.x) live in
// `src/syncRoutes.privacy.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eventStore,
  freeUser,
  IP_REQUESTS_PER_WINDOW,
  MAX_RECORD_BYTES,
  MAX_SYNC_BODY_BYTES,
  mealRecord,
  mintToken,
  proUser,
  pushBody,
  syncApp,
  syncCall,
  syncFetch,
  uniqueEmail,
  uniqueIp,
  USER_REQUESTS_PER_WINDOW,
  userStore,
  type WireRecord,
} from "./test/syncHarness";

const PUSH = "/api/sync/push";
const PULL = "/api/sync/pull";
const CLOUD_DELETE = "/api/sync/data";

/** A user whose Pro ran out — the entitlement failure the 402 path describes. */
async function lapsedUser(): Promise<{ email: string; token: string; proUntil: number }> {
  const email = uniqueEmail("lapsed");
  const proUntil = Date.now() - 60_000;
  const store = await userStore();
  await store.upsertUser(email);
  await store.setPro(email, proUntil);
  return { email, token: mintToken(email), proUntil };
}

/** The Server_Sequence a cursor token identifies — `"{epoch}:{seq}"`. */
const cursorSeq = (cursor: string): number => Number(cursor.split(":")[1]);

beforeEach(() => {
  // Every request writes one redacted line, which is asserted on in
  // `src/syncRoutes.privacy.test.ts` and is only noise here.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The guard chain (Req 2.6, 2.10, 19.1)
// ---------------------------------------------------------------------------

describe("sync middleware chain", () => {
  it("rejects a plaintext request before looking at anything else", async () => {
    const app = syncApp();
    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      headers: { "x-forwarded-proto": "http" },
      body: pushBody([mealRecord("plaintext-1")]),
    });

    expect(status).toBe(400);
    expect(body).toEqual({ error: "https_required" });
  });

  it("answers 413 for a declared oversize body before verifying the session", async () => {
    const app = syncApp();
    // No token at all: reaching 413 rather than 401 is what places the declared
    // size check ahead of session verification (Req 19.1).
    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      bodyText: "{}",
      headers: { "content-length": String(MAX_SYNC_BODY_BYTES + 1) },
    });

    expect(status).toBe(413);
    expect(body).toEqual({ error: "payload_too_large" });
  });

  it("answers 401 rather than 402 when the session fails for a user without Pro", async () => {
    const app = syncApp();
    const { email } = await freeUser();
    const store = await userStore();
    expect(await store.getUser(email)).not.toBeNull();

    // A token for a real, non-Pro user, with its signature broken: this request
    // would fail *both* checks, and Requirement 2.6 says authentication wins.
    const token = `${mintToken(email)}tampered`;
    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      body: pushBody([mealRecord("precedence-1")]),
    });

    expect(status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
    expect(body.entitlement).toBeUndefined();
  });

  it("answers 402 with the evaluated entitlement once the session verifies", async () => {
    const app = syncApp();
    const { token, proUntil } = await lapsedUser();

    for (const call of [
      { method: "POST", path: PUSH, body: pushBody([mealRecord("gated-1")]) },
      { method: "GET", path: PULL },
    ]) {
      const { status, body } = await syncCall(app, { ...call, token });
      expect(status).toBe(402);
      expect(body.error).toBe("upgrade_required");
      // The Pro_Entitlement the service evaluated, and the expiry it evaluated
      // against (Req 2.2).
      expect(body.entitlement.pro).toBe(false);
      expect(body.entitlement.proUntil).toBe(proUntil);
      expect(body.records).toBeUndefined();
    }
  });

  it("lets a lapsed user delete their cloud copy while keeping push and pull gated", async () => {
    const app = syncApp();
    const { email, token } = await lapsedUser();
    const store = await eventStore();
    await store.push(email, [mealRecord("lapsed-keep-1"), mealRecord("lapsed-keep-2")]);

    // DELETE /api/sync/data is deliberately exempt from the step-6 Pro gate:
    // Requirement 17.4 gives the user the right to remove the cloud copy, and the
    // user most likely to want it is exactly the one whose Pro has lapsed.
    const deleted = await syncCall(app, { method: "DELETE", path: CLOUD_DELETE, token });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ ok: true, deleted: 2 });
    expect(deleted.body.entitlement.pro).toBe(false);
    expect(await store.countFor(email)).toBe(0);

    // The exemption is the delete path only — the paid feature stays paid.
    const pushed = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      body: pushBody([mealRecord("lapsed-push-1")]),
    });
    expect(pushed.status).toBe(402);
    expect(await store.countFor(email)).toBe(0);
  });

  it("requires a session for the cloud delete", async () => {
    const app = syncApp();
    const { status, body } = await syncCall(app, { method: "DELETE", path: CLOUD_DELETE });

    expect(status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("touches no stored Event_Record on the way to a 401 or a 402", async () => {
    const app = syncApp();
    const owner = await proUser();
    const store = await eventStore();
    const seeded = [mealRecord("untouched-1"), mealRecord("untouched-2")];
    await store.push(owner.email, seeded);
    const before = await store.pull(owner.email);

    // Every entry point to stored Event_Records, watched at once. The spies pass
    // through, so the store still behaves normally.
    const watched = ["push", "pull", "deleteAll", "countFor", "getMeta"] as const;
    const spies = watched.map((method) => vi.spyOn(store as any, method));

    const rejected = [
      // 401 — no token, a malformed token, and a token presented other than as a
      // Bearer credential (Req 2.1).
      { init: { method: "POST", path: PUSH, body: pushBody(seeded) }, status: 401 },
      { init: { method: "GET", path: PULL, token: "not-a-token" }, status: 401 },
      {
        init: { method: "GET", path: PULL, headers: { authorization: owner.token } },
        status: 401,
      },
      // 402 — a verified session with no entitlement (Req 2.2).
      { init: { method: "POST", path: PUSH, token: (await lapsedUser()).token }, status: 402 },
      { init: { method: "GET", path: PULL, token: (await freeUser()).token }, status: 402 },
    ];

    for (const { init, status } of rejected) {
      const res = await syncCall(app, init as any);
      expect(res.status).toBe(status);
      // Zero Event_Records in the body of either rejection (Req 2.3).
      expect(res.body.records).toBeUndefined();
    }

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // And nothing stored changed for anyone (Req 2.3).
    expect(await store.pull(owner.email)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Identity comes from the token, never the payload (Req 2.5)
// ---------------------------------------------------------------------------

describe("request identity", () => {
  it("ignores a user identifier in the push body and stores under the token identity", async () => {
    const app = syncApp();
    const caller = await proUser("caller");
    const victim = await proUser("victim");
    const store = await eventStore();

    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token: caller.token,
      body: {
        // Every shape a modified client might try.
        email: victim.email,
        user: victim.email,
        userId: victim.email,
        records: [mealRecord("identity-1")],
      },
    });

    expect(status).toBe(200);
    expect(body.outcomes).toEqual([{ id: "identity-1", outcome: "stored" }]);

    const callerPage = await store.pull(caller.email);
    expect(callerPage.records.map((r) => r.id)).toEqual(["identity-1"]);
    expect(await store.countFor(victim.email)).toBe(0);
  });

  it("ignores a user identifier in the pull query string", async () => {
    const app = syncApp();
    const caller = await proUser("caller");
    const victim = await proUser("victim");
    const store = await eventStore();
    await store.push(caller.email, [mealRecord("mine-1")]);
    await store.push(victim.email, [mealRecord("theirs-1")]);

    const { status, body } = await syncCall(app, {
      method: "GET",
      path: `${PULL}?email=${encodeURIComponent(victim.email)}&user=${encodeURIComponent(victim.email)}`,
      token: caller.token,
    });

    expect(status).toBe(200);
    expect(body.records.map((r: WireRecord) => r.id)).toEqual(["mine-1"]);
  });
});

// ---------------------------------------------------------------------------
// Push (Req 6.10, 6.11)
// ---------------------------------------------------------------------------

describe("push", () => {
  it("reports exactly one outcome per id sent, with the highest sequence assigned", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const records = ["one", "two", "three"].map((id) => mealRecord(id));

    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      body: pushBody(records),
    });

    expect(status).toBe(200);
    expect(body.outcomes).toEqual([
      { id: "one", outcome: "stored" },
      { id: "two", outcome: "stored" },
      { id: "three", outcome: "stored" },
    ]);
    expect(body.highestSequence).toBe(3);
    expect(body.entitlement.pro).toBe(true);
    expect(await (await eventStore()).countFor(email)).toBe(3);
  });

  it("stores nothing and names every id when one record breaks a check", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();

    const payload = [
      mealRecord("good-1"),
      mealRecord("oversize-1", { note: "x".repeat(MAX_RECORD_BYTES) }),
      mealRecord("good-2"),
    ];
    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      body: pushBody(payload),
    });

    expect(status).toBe(400);
    expect(body.error).toBe("record_too_large");
    expect(body.highestSequence).toBeNull();
    // One outcome per id carried by the request (Req 6.11): the offender names its
    // own permanent reason, and the two innocent ids carry the transient reason
    // that keeps them queued in the client's Outbox (Req 19.9).
    expect(body.outcomes).toEqual([
      { id: "good-1", outcome: "rejected", reason: "record_limit" },
      { id: "oversize-1", outcome: "rejected", reason: "record_too_large" },
      { id: "good-2", outcome: "rejected", reason: "record_limit" },
    ]);
    // All-or-nothing: nothing stored, no Server_Sequence assigned (Req 6.10).
    expect(await store.countFor(email)).toBe(0);
    expect((await store.getMeta(email)).seq).toBe(0);
  });

  it("rejects a payload carrying one id twice", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();

    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      // A real client never does this — `planPush` emits one record per Outbox id
      // — and the store cannot keep push idempotence across two different records
      // sharing an `id` (Req 6.5), so the payload is refused outright.
      body: pushBody([mealRecord("dup-1"), mealRecord("dup-1", { dish: "toast" })]),
    });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_record");
    expect(body.outcomes).toEqual([
      { id: "dup-1", outcome: "rejected", reason: "invalid_record" },
    ]);
    expect(await store.countFor(email)).toBe(0);
  });

  it("rejects an id the store cannot key a record by", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();

    // Each of these is a non-empty string, so it can be *named* in a response, but
    // none of them can key a stored Event_Record: `/` would address a different
    // document, `.` and `..` are relative segments, and `__x__` is reserved. Before
    // this check they reached the store and threw, which the error boundary
    // answered with a 500 — transient to the client, so the same unstorable record
    // would be re-sent every Sync_Cycle forever.
    for (const id of ["a/b", ".", "..", "__meta__", "x".repeat(1_501)]) {
      const { status, body } = await syncCall(app, {
        method: "POST",
        path: PUSH,
        token,
        body: pushBody([mealRecord(id)]),
      });

      expect(status).toBe(400);
      expect(body.error).toBe("invalid_record");
      // Named, and named permanently, so the client drops the id from its Outbox
      // and keeps the Log_Event (Req 19.9).
      expect(body.outcomes).toEqual([{ id, outcome: "rejected", reason: "invalid_record" }]);
    }

    expect(await store.countFor(email)).toBe(0);
  });

  it("answers 400 for a body that is not a push payload", async () => {
    const app = syncApp();
    const { token } = await proUser();

    const malformed = await syncCall(app, { method: "POST", path: PUSH, token, bodyText: "{" });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      error: "invalid_request",
      outcomes: [],
      highestSequence: null,
    });

    const noRecords = await syncCall(app, { method: "POST", path: PUSH, token, body: { nope: 1 } });
    expect(noRecords.status).toBe(400);
    expect(noRecords.body.error).toBe("invalid_request");
  });

  it("assigns gap-free ascending sequences across two interleaved pushes", async () => {
    const app = syncApp();
    const { token } = await proUser();

    const first = ["a-1", "a-2", "a-3"].map((id) => mealRecord(id));
    const second = ["b-1", "b-2", "b-3"].map((id) => mealRecord(id));
    const [pushA, pushB] = await Promise.all([
      syncCall(app, { method: "POST", path: PUSH, token, body: pushBody(first) }),
      syncCall(app, { method: "POST", path: PUSH, token, body: pushBody(second) }),
    ]);

    expect(pushA.status).toBe(200);
    expect(pushB.status).toBe(200);
    // Whichever request ran second allocated the block above the first one's, so
    // the two highest sequences are the two block ends and neither overlaps.
    expect([pushA.body.highestSequence, pushB.body.highestSequence].sort((x, y) => x - y)).toEqual([
      3, 6,
    ]);

    // Walking the timeline one record at a time exposes each Server_Sequence
    // through the cursor: ascending, gap-free, one per stored record (Req 6.3).
    const sequences: number[] = [];
    const ids: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : "?limit=1";
      const res = await syncCall(app, { method: "GET", path: `${PULL}${query}`, token });
      expect(res.status).toBe(200);
      if (res.body.records.length === 0) {
        expect(res.body.hasMore).toBe(false);
        break;
      }
      ids.push(...res.body.records.map((r: WireRecord) => r.id));
      sequences.push(cursorSeq(res.body.cursor));
      cursor = res.body.cursor;
      if (!res.body.hasMore) break;
    }

    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids.sort()).toEqual([...first, ...second].map((r) => r.id).sort());
  });
});

// ---------------------------------------------------------------------------
// Pull (Req 7.2, 18.2)
// ---------------------------------------------------------------------------

describe("pull", () => {
  it("pages at 500 records and reports whether more remain", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();

    // Seeded through the store rather than 501 push requests: paging is what is
    // under test, and a push carries at most 200 records (Req 19.2).
    const seeded: WireRecord[] = [];
    for (let i = 0; i < 501; i += 1) seeded.push(mealRecord(`page-${String(i).padStart(4, "0")}`));
    await store.push(email, seeded);

    // A limit above the ceiling is clamped to it, not honoured (Req 7.2).
    const first = await syncCall(app, { method: "GET", path: `${PULL}?limit=1000`, token });
    expect(first.status).toBe(200);
    expect(first.body.records).toHaveLength(500);
    expect(first.body.hasMore).toBe(true);
    expect(cursorSeq(first.body.cursor)).toBe(500);
    // Ascending Server_Sequence order, which for this seed is insertion order.
    expect(first.body.records.map((r: WireRecord) => r.id)).toEqual(
      seeded.slice(0, 500).map((r) => r.id)
    );

    const second = await syncCall(app, {
      method: "GET",
      path: `${PULL}?cursor=${encodeURIComponent(first.body.cursor)}`,
      token,
    });
    expect(second.status).toBe(200);
    expect(second.body.records.map((r: WireRecord) => r.id)).toEqual([seeded[500].id]);
    expect(second.body.hasMore).toBe(false);

    // The page that completes the pull: zero records, no more remaining (Req 7.8).
    const third = await syncCall(app, {
      method: "GET",
      path: `${PULL}?cursor=${encodeURIComponent(second.body.cursor)}`,
      token,
    });
    expect(third.body.records).toEqual([]);
    expect(third.body.hasMore).toBe(false);
  });

  it("reports an unusable cursor as a 200 carrying the reset signal", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();
    await store.push(email, [mealRecord("reset-1")]);

    const issued = await syncCall(app, { method: "GET", path: PULL, token });
    expect(issued.status).toBe(200);

    // A purge bumps the generation, so every cursor issued before it is stale.
    await store.deleteAll(email);

    for (const cursor of ["not-a-cursor", issued.body.cursor]) {
      const res = await syncCall(app, {
        method: "GET",
        path: `${PULL}?cursor=${encodeURIComponent(cursor)}`,
        token,
      });
      // Deliberately inside the success range: Requirement 7.5 has the client
      // retain its cursor and retry on a *failed* pull, which is the opposite of
      // the reset Requirement 13.13 wants. The two are told apart by the body.
      expect(res.status).toBe(200);
      expect(res.body.error).toBe("cursor_invalid");
      expect(res.body.cursor).toBeNull();
      // Neither records nor hasMore, so it cannot be read as an empty final page.
      expect(res.body.records).toBeUndefined();
      expect(res.body.hasMore).toBeUndefined();
    }
  });

  it("serves each user only their own records for a shared id", async () => {
    const app = syncApp();
    const a = await proUser("iso-a");
    const b = await proUser("iso-b");
    const store = await eventStore();

    const shared = "shared-id-1";
    await syncCall(app, {
      method: "POST",
      path: PUSH,
      token: a.token,
      body: pushBody([mealRecord(shared, { dish: "porridge" })]),
    });

    // B holds nothing, so the id stored under A reads as though it does not exist
    // (Req 18.2) — there is no ownership comparison, only a different subtree.
    const bEmpty = await syncCall(app, { method: "GET", path: PULL, token: b.token });
    expect(bEmpty.status).toBe(200);
    expect(bEmpty.body.records).toEqual([]);
    expect(bEmpty.body.hasMore).toBe(false);

    // B pushing the same id writes B's own copy and leaves A's untouched.
    await syncCall(app, {
      method: "POST",
      path: PUSH,
      token: b.token,
      body: pushBody([mealRecord(shared, { dish: "toast" })]),
    });

    const aPage = await syncCall(app, { method: "GET", path: PULL, token: a.token });
    const bPage = await syncCall(app, { method: "GET", path: PULL, token: b.token });
    expect(aPage.body.records).toHaveLength(1);
    expect(aPage.body.records[0].dish).toBe("porridge");
    expect(bPage.body.records).toHaveLength(1);
    expect(bPage.body.records[0].dish).toBe("toast");
    expect(await store.countFor(a.email)).toBe(1);
    expect(await store.countFor(b.email)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Payload size and rate limits (Req 19.1, 19.4, 19.5, 19.10)
// ---------------------------------------------------------------------------

describe("payload limits", () => {
  it("answers 413 for a declared oversize push and stores nothing", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();
    await store.push(email, [mealRecord("kept-1")]);
    const before = await store.pull(email);

    const { status, body } = await syncCall(app, {
      method: "POST",
      path: PUSH,
      token,
      bodyText: JSON.stringify(pushBody([mealRecord("declared-1")])),
      headers: { "content-length": String(MAX_SYNC_BODY_BYTES + 1) },
    });

    expect(status).toBe(413);
    expect(body).toEqual({ error: "payload_too_large" });
    expect(await store.pull(email)).toEqual(before);
  });

  it("answers 413 for a chunked oversize body and stops reading it", async () => {
    const app = syncApp();
    const { email, token } = await proUser();
    const store = await eventStore();
    await store.push(email, [mealRecord("kept-2")]);
    const before = await store.pull(email);

    // A body with no `Content-Length` at all, so the declared-size guard cannot
    // see it: the streaming read is what has to stop this one (Req 19.10).
    const chunkBytes = 128 * 1024;
    const chunks = 24; // 3 MiB in total, three times the budget
    let pulled = 0;
    const bodyStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
    });

    const res = await syncFetch(app, { method: "POST", path: PUSH, token, bodyStream });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    // The reader is cancelled the moment the count passes the budget rather than
    // draining the rest: the budget is 8 of these chunks, and what actually gets
    // pulled is that plus whatever was already in flight — nowhere near the 24
    // chunks the client was willing to send.
    expect(pulled).toBeLessThan(chunks / 2);
    expect(await store.pull(email)).toEqual(before);
  });
});

describe("rate limits", () => {
  it("answers 429 with the seconds remaining once one user exceeds the window", async () => {
    const app = syncApp();
    const { token } = await proUser();

    for (let i = 0; i < USER_REQUESTS_PER_WINDOW; i += 1) {
      const ok = await syncFetch(app, { method: "GET", path: PULL, token });
      expect(ok.status).toBe(200);
    }

    const limited = await syncCall(app, { method: "GET", path: PULL, token });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    // A whole number of seconds from 1 to 60, matching the `Retry-After` header
    // and derived from the window the limiter itself applies (Req 19.4, 19.6).
    expect(Number.isInteger(limited.body.retryAfterSeconds)).toBe(true);
    expect(limited.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(limited.res.headers.get("retry-after")).toBe(String(limited.body.retryAfterSeconds));
  });

  it("applies the per-IP limit before session verification", async () => {
    const app = syncApp();
    const ip = uniqueIp();

    // Unauthenticated traffic from one address: it is the IP counter that has to
    // stop this, since there is no identity to count against (Req 19.5).
    for (let i = 0; i < IP_REQUESTS_PER_WINDOW; i += 1) {
      const unauthorized = await syncFetch(app, { method: "GET", path: PULL, ip });
      expect(unauthorized.status).toBe(401);
    }

    const limited = await syncCall(app, { method: "GET", path: PULL, ip });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
