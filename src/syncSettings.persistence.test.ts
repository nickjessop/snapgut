import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DISCLOSURE_VERSION,
  ackDisclosure,
  applyEntitlement,
  clearPersistedSyncSettingsForTests,
  getEntitlementSnapshot,
  getSnapshot,
  hasAckedDisclosure,
  isDestinationEnabled,
  isProEntitled,
  isRestored,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
  subscribe,
  type DestinationId,
} from "./syncSettings";

// Feature: cloud-sync — task 3.4
//
// Unit tests for the stateful half of `syncSettings`: persistence of the two
// enabled states, the fail-closed reads, the restore lifecycle, the
// persistence-failure path, the cold-start entitlement default, and the
// disclosure acknowledgement.
//
// The pure predicates (`isDestinationActive`, `shouldNudgeBackup`) are covered by
// `syncSettings.nudge.test.ts` and are not re-tested here.

const CLOUD_KEY = "snapgut-sync-cloud-enabled";
const SHEETS_KEY = "snapgut-sync-sheets-enabled";
const ENTITLEMENT_KEY = "snapgut-sync-entitlement";
const DISCLOSURE_KEY = "snapgut-sync-disclosure-ack";

const KEY_OF: Record<DestinationId, string> = { cloud: CLOUD_KEY, sheets: SHEETS_KEY };
const OTHER: Record<DestinationId, DestinationId> = { cloud: "sheets", sheets: "cloud" };
const DESTINATIONS: readonly DestinationId[] = ["cloud", "sheets"];

/**
 * An app restart: in-memory state (including the memoized `restore()` promise and
 * every subscriber) is dropped, persisted values are left alone, and the module
 * reads them back exactly as a cold launch would.
 */
async function restart(): Promise<void> {
  resetSyncSettingsForTests();
  await restore();
}

/** `setItem` that throws for one key — quota exhaustion, blocked storage. */
function throwOnWrite(key: string) {
  const original = Storage.prototype.setItem;
  return vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === key) throw new DOMException("quota exceeded", "QuotaExceededError");
      original.call(this, k, v);
    });
}

/**
 * `setItem` that accepts the write and silently discards it — the private-mode /
 * evicted-storage case Req 3.10 treats identically to a thrown error, caught only
 * by the write-then-read-back check.
 */
function dropWrite(key: string) {
  const original = Storage.prototype.setItem;
  return vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === key) return;
      original.call(this, k, v);
    });
}

/** Every key/value pair currently in `localStorage`, for before/after comparison. */
function dumpStorage(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key !== null) out[key] = localStorage.getItem(key);
  }
  return out;
}

/** `getItem` that throws for one key — a persisted value that cannot be read. */
function throwOnRead(key: string) {
  const original = Storage.prototype.getItem;
  return vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(function (this: Storage, k: string) {
      if (k === key) throw new DOMException("blocked", "SecurityError");
      return original.call(this, k);
    });
}

beforeEach(() => {
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Independent toggling: all four combinations reachable and persisted
// Requirements 3.11, 3.2
// ---------------------------------------------------------------------------

describe("independent toggling (Req 3.11, 3.2)", () => {
  const COMBINATIONS: ReadonlyArray<[boolean, boolean]> = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ];

  it.each(COMBINATIONS)(
    "reaches and persists cloud=%s sheets=%s across a restart",
    async (cloud, sheets) => {
      await restore();

      expect(setDestinationEnabled("cloud", cloud)).toEqual({ persisted: true });
      expect(setDestinationEnabled("sheets", sheets)).toEqual({ persisted: true });

      expect(isDestinationEnabled("cloud")).toBe(cloud);
      expect(isDestinationEnabled("sheets")).toBe(sheets);
      expect(getSnapshot().enabled).toEqual({ cloud, sheets });

      // Persisted as the two independent boolean values of Req 3.1, one key each.
      expect(localStorage.getItem(CLOUD_KEY)).toBe(String(cloud));
      expect(localStorage.getItem(SHEETS_KEY)).toBe(String(sheets));

      await restart();
      expect(getSnapshot().enabled).toEqual({ cloud, sheets });
    },
  );

  it.each(DESTINATIONS)("toggling %s leaves the other destination untouched", async (id) => {
    await restore();
    const other = OTHER[id];

    // Start from "only the other one enabled" so a leak in either direction shows.
    setDestinationEnabled(other, true);
    const otherPersistedBefore = localStorage.getItem(KEY_OF[other]);

    for (const value of [true, false, true]) {
      setDestinationEnabled(id, value);
      expect(isDestinationEnabled(id)).toBe(value);
      expect(isDestinationEnabled(other)).toBe(true);
      expect(localStorage.getItem(KEY_OF[other])).toBe(otherPersistedBefore);
    }
  });

  it("writes only the toggled destination's own key, touching no cursor or outbox state", async () => {
    await restore();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    setDestinationEnabled("cloud", true);

    expect(setItem.mock.calls.map(([k]) => k)).toEqual([CLOUD_KEY]);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("notifies subscribers of a changed enabled state (Req 3.8)", async () => {
    await restore();
    const seen: Array<Record<DestinationId, boolean>> = [];
    const unsubscribe = subscribe((s) => seen.push(s.enabled));

    setDestinationEnabled("sheets", true);
    // Same value again: nothing changed, so nothing to report.
    setDestinationEnabled("sheets", true);
    unsubscribe();
    setDestinationEnabled("sheets", false);

    expect(seen).toEqual([{ cloud: false, sheets: true }]);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed reads for absent, non-boolean, and unreadable values
// Requirements 3.6
// ---------------------------------------------------------------------------

describe("disabled fallback for absent or corrupt persisted values (Req 3.6)", () => {
  it("reports both destinations disabled when nothing is persisted", async () => {
    await restore();
    expect(getSnapshot().enabled).toEqual({ cloud: false, sheets: false });
  });

  const CORRUPT_VALUES = [
    "",
    " ",
    "1",
    "0",
    "yes",
    "no",
    "TRUE",
    "True",
    " true",
    "true ",
    "null",
    "undefined",
    '"true"',
    "{}",
    "[true]",
    "\u0000",
  ];

  it.each(CORRUPT_VALUES)("reads the non-boolean value %j as disabled", async (raw) => {
    localStorage.setItem(CLOUD_KEY, raw);
    localStorage.setItem(SHEETS_KEY, raw);
    await restore();
    expect(getSnapshot().enabled).toEqual({ cloud: false, sheets: false });
  });

  it("reads the two boolean values exactly", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    localStorage.setItem(SHEETS_KEY, "false");
    await restore();
    expect(getSnapshot().enabled).toEqual({ cloud: true, sheets: false });
  });

  it.each(DESTINATIONS)(
    "reads an unreadable %s value as disabled without disturbing the other",
    async (id) => {
      localStorage.setItem(CLOUD_KEY, "true");
      localStorage.setItem(SHEETS_KEY, "true");
      throwOnRead(KEY_OF[id]);

      await restore();

      expect(isDestinationEnabled(id)).toBe(false);
      expect(isDestinationEnabled(OTHER[id])).toBe(true);
    },
  );

  it("survives storage that is unreadable entirely", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    const original = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await expect(restore()).resolves.toBeUndefined();
    expect(getSnapshot().enabled).toEqual({ cloud: false, sheets: false });
    expect(isProEntitled()).toBe(false);
    expect(isRestored()).toBe(true);

    vi.restoreAllMocks();
    expect(Storage.prototype.getItem).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Restoration completes before the first sync cycle
// Requirements 3.5, 3.9
// ---------------------------------------------------------------------------

describe("restore lifecycle (Req 3.5, 3.9)", () => {
  it("reports every destination disabled and not restored before restore() runs", () => {
    localStorage.setItem(CLOUD_KEY, "true");
    localStorage.setItem(SHEETS_KEY, "true");

    // Req 3.5: while restoration has not completed, a trigger reading these must
    // see "disabled" and therefore no-op.
    expect(isRestored()).toBe(false);
    expect(getSnapshot().restored).toBe(false);
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(isDestinationEnabled("sheets")).toBe(false);
  });

  it("reports restoration complete synchronously, before any awaiter resumes", async () => {
    localStorage.setItem(CLOUD_KEY, "true");

    const pending = restore();
    // Req 3.9: no window exists in which a caller can observe a resolved restore
    // yet an unrestored state — the flag flips before the promise is handed back.
    expect(isRestored()).toBe(true);
    expect(isDestinationEnabled("cloud")).toBe(true);

    await expect(pending).resolves.toBeUndefined();
    expect(getSnapshot().restored).toBe(true);
  });

  it("is idempotent: one read, one notification, the same promise", async () => {
    localStorage.setItem(SHEETS_KEY, "true");
    let notifications = 0;
    subscribe(() => {
      notifications += 1;
    });

    const first = restore();
    const second = restore();
    await Promise.all([first, second, restore()]);

    expect(second).toBe(first);
    expect(notifications).toBe(1);
    expect(isDestinationEnabled("sheets")).toBe(true);

    // A value written behind the module's back is not re-read by a repeat call.
    localStorage.setItem(SHEETS_KEY, "false");
    await restore();
    expect(isDestinationEnabled("sheets")).toBe(true);
  });

  it("does not overwrite an in-session change made after restoration", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    await restore();
    setDestinationEnabled("cloud", false);

    await restore();

    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(localStorage.getItem(CLOUD_KEY)).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// Persistence failure keeps the change for the session and reports it unsaved
// Requirements 3.10
// ---------------------------------------------------------------------------

describe("persistence failure (Req 3.10)", () => {
  const FAILURE_MODES: ReadonlyArray<[string, (key: string) => unknown]> = [
    ["a thrown write", throwOnWrite],
    ["a silently dropped write", dropWrite],
  ];

  describe.each(FAILURE_MODES)("%s", (_label, install) => {
    it.each(DESTINATIONS)("reports %s unsaved but keeps the change in memory", async (id) => {
      await restore();
      install(KEY_OF[id]);

      expect(setDestinationEnabled(id, true)).toEqual({ persisted: false });

      // Kept for the remainder of the session.
      expect(isDestinationEnabled(id)).toBe(true);
      const snapshot = getSnapshot();
      expect(snapshot.enabled[id]).toBe(true);
      // ...and surfaced as unsaved, which Settings renders.
      expect(snapshot.persistFailed).toBe(id);
    });

    it.each(DESTINATIONS)(
      "leaves the other destination's state and persisted value unchanged when %s fails",
      async (id) => {
        await restore();
        const other = OTHER[id];
        setDestinationEnabled(other, true);
        const otherPersisted = localStorage.getItem(KEY_OF[other]);

        install(KEY_OF[id]);
        setDestinationEnabled(id, true);

        expect(isDestinationEnabled(other)).toBe(true);
        expect(localStorage.getItem(KEY_OF[other])).toBe(otherPersisted);
      },
    );

    it("writes nothing else — no cursor, no outbox, no other key", async () => {
      await restore();
      const before = dumpStorage();
      install(CLOUD_KEY);
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");

      setDestinationEnabled("cloud", true);

      expect(dumpStorage()).toEqual(before);
      expect(removeItem).not.toHaveBeenCalled();
    });
  });

  it("clears the unsaved indication once the destination persists again", async () => {
    await restore();
    const spy = throwOnWrite(CLOUD_KEY);

    setDestinationEnabled("cloud", true);
    expect(getSnapshot().persistFailed).toBe("cloud");

    spy.mockRestore();
    expect(setDestinationEnabled("cloud", true)).toEqual({ persisted: true });
    expect(getSnapshot().persistFailed).toBeNull();
    expect(localStorage.getItem(CLOUD_KEY)).toBe("true");
  });

  it("keeps one destination's unsaved indication when the other persists", async () => {
    await restore();
    const spy = throwOnWrite(CLOUD_KEY);
    setDestinationEnabled("cloud", true);

    setDestinationEnabled("sheets", true);

    expect(getSnapshot().persistFailed).toBe("cloud");
    spy.mockRestore();
  });

  it("notifies subscribers when a change is kept but unsaved", async () => {
    await restore();
    const seen: Array<DestinationId | null> = [];
    subscribe((s) => seen.push(s.persistFailed));
    throwOnWrite(SHEETS_KEY);

    setDestinationEnabled("sheets", true);

    expect(seen).toEqual(["sheets"]);
  });

  it("does not carry an unsaved change across a restart", async () => {
    await restore();
    throwOnWrite(CLOUD_KEY);
    setDestinationEnabled("cloud", true);
    vi.restoreAllMocks();

    await restart();

    // Nothing durable was written, so a cold launch fails closed (Req 3.6).
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(getSnapshot().persistFailed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cold-start entitlement default fails closed
// Requirements 1.9
// ---------------------------------------------------------------------------

describe("cold-start entitlement default (Req 1.9)", () => {
  it("is not Pro before restore() and with no persisted snapshot", async () => {
    expect(isProEntitled()).toBe(false);
    expect(getEntitlementSnapshot()).toBeNull();

    await restore();

    expect(isProEntitled()).toBe(false);
    expect(getEntitlementSnapshot()).toBeNull();
    expect(getSnapshot().entitlement).toBeNull();
  });

  it("is not Pro when the enabled state says otherwise", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    localStorage.setItem(SHEETS_KEY, "true");
    await restore();

    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(isProEntitled()).toBe(false);
  });

  const CORRUPT_SNAPSHOTS = [
    "",
    "not json",
    "null",
    "true",
    "42",
    "[]",
    "{}",
    '{"pro":"true","proUntil":null,"receivedAt":1}',
    '{"pro":true,"proUntil":null}',
    '{"pro":true,"receivedAt":1}',
    '{"pro":true,"proUntil":"soon","receivedAt":1}',
    '{"pro":true,"proUntil":null,"receivedAt":"now"}',
    '{"pro":true,"proUntil":null,"receivedAt":null}',
  ];

  it.each(CORRUPT_SNAPSHOTS)("treats the corrupt snapshot %j as never persisted", async (raw) => {
    localStorage.setItem(ENTITLEMENT_KEY, raw);
    await restore();

    expect(getEntitlementSnapshot()).toBeNull();
    expect(isProEntitled()).toBe(false);
  });

  it("becomes Pro only once a server response supplies a snapshot, and retains it", async () => {
    await restore();
    expect(isProEntitled()).toBe(false);

    const proUntil = Date.now() + 30 * 86_400_000;
    applyEntitlement({ pro: true, proUntil });

    expect(isProEntitled()).toBe(true);
    const snapshot = getEntitlementSnapshot();
    expect(snapshot).toMatchObject({ pro: true, proUntil });
    expect(snapshot?.receivedAt).toBeTypeOf("number");

    await restart();

    // Req 1.8: the snapshot, including the receive time, survives the restart.
    expect(getEntitlementSnapshot()).toEqual(snapshot);
    expect(isProEntitled()).toBe(true);
  });

  it("honours an expiry and an open-ended entitlement", async () => {
    await restore();

    applyEntitlement({ pro: true, proUntil: Date.now() - 1 });
    expect(isProEntitled()).toBe(false);

    applyEntitlement({ pro: true, proUntil: null });
    expect(isProEntitled()).toBe(true);

    applyEntitlement({ pro: false, proUntil: null });
    expect(isProEntitled()).toBe(false);

    await restart();
    expect(isProEntitled()).toBe(false);
    expect(getEntitlementSnapshot()).toMatchObject({ pro: false });
  });

  it("keeps the snapshot in memory when it cannot be persisted", async () => {
    await restore();
    throwOnWrite(ENTITLEMENT_KEY);

    applyEntitlement({ pro: true, proUntil: null });

    // Applied to the gate for this session; a cold start then fails closed again.
    expect(isProEntitled()).toBe(true);
    vi.restoreAllMocks();
    await restart();
    expect(isProEntitled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Disclosure acknowledgement survives a restart
// Requirements 18.9
// ---------------------------------------------------------------------------

describe("disclosure acknowledgement (Req 18.9, 18.6)", () => {
  const EMAIL = "user@example.com";

  it("holds no acknowledgement before one is recorded", async () => {
    await restore();
    expect(hasAckedDisclosure(EMAIL)).toBe(false);
    expect(getSnapshot().disclosureAckFor).toBeNull();
  });

  it("survives a restart", async () => {
    await restore();
    ackDisclosure(EMAIL);
    expect(hasAckedDisclosure(EMAIL)).toBe(true);
    expect(localStorage.getItem(DISCLOSURE_KEY)).toBe(`${EMAIL}:${DISCLOSURE_VERSION}`);

    await restart();

    expect(hasAckedDisclosure(EMAIL)).toBe(true);
    expect(getSnapshot().disclosureAckFor).toBe(`${EMAIL}:${DISCLOSURE_VERSION}`);
  });

  it("does not apply to a different signed-in identity", async () => {
    await restore();
    ackDisclosure(EMAIL);
    await restart();

    expect(hasAckedDisclosure("other@example.com")).toBe(false);
    expect(hasAckedDisclosure(EMAIL)).toBe(true);
  });

  it("does not apply to an acknowledgement of older disclosure content", async () => {
    localStorage.setItem(DISCLOSURE_KEY, `${EMAIL}:${DISCLOSURE_VERSION - 1}`);
    await restore();

    expect(hasAckedDisclosure(EMAIL)).toBe(false);
  });

  it("ignores an empty stored acknowledgement", async () => {
    localStorage.setItem(DISCLOSURE_KEY, "");
    await restore();

    expect(getSnapshot().disclosureAckFor).toBeNull();
    expect(hasAckedDisclosure(EMAIL)).toBe(false);
  });

  it("is independent of the enabled state it gates", async () => {
    await restore();
    ackDisclosure(EMAIL);

    // Req 18.9 persists the acknowledgement only; enabling stays a separate action.
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(localStorage.getItem(CLOUD_KEY)).toBeNull();

    await restart();
    expect(hasAckedDisclosure(EMAIL)).toBe(true);
    expect(isDestinationEnabled("cloud")).toBe(false);
  });
});
