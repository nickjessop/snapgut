import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DISCLOSURE_VERSION,
  ackDisclosure,
  clearPersistedSyncSettingsForTests,
  getSnapshot,
  hasAckedDisclosure,
  isDestinationEnabled,
  isRestored,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
  subscribe,
} from "./syncSettings";

// Feature: cloud-sync — task 3.4
//
// Unit tests for the stateful half of `syncSettings`: persistence of the
// enabled state, the fail-closed reads, the restore lifecycle, the
// persistence-failure path, and the disclosure acknowledgement.
//
// The pure predicates (`isDestinationActive`, `shouldNudgeBackup`) are covered by
// `syncSettings.nudge.test.ts` and are not re-tested here.

const CLOUD_KEY = "snapgut-sync-cloud-enabled";
const DISCLOSURE_KEY = "snapgut-sync-disclosure-ack";

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
// Independent toggling: enabled/disabled reachable and persisted
// Requirements 3.11, 3.2
// ---------------------------------------------------------------------------

describe("toggling (Req 3.11, 3.2)", () => {
  it("reaches and persists cloud enabled/disabled across a restart", async () => {
    await restore();

    expect(setDestinationEnabled("cloud", true)).toEqual({ persisted: true });
    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(getSnapshot().enabled).toEqual({ cloud: true });
    expect(localStorage.getItem(CLOUD_KEY)).toBe("true");

    await restart();
    expect(getSnapshot().enabled).toEqual({ cloud: true });

    setDestinationEnabled("cloud", false);
    await restart();
    expect(getSnapshot().enabled).toEqual({ cloud: false });
  });

  it("writes only the cloud key, touching no cursor or outbox state", async () => {
    await restore();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    setDestinationEnabled("cloud", true);

    expect(setItem.mock.calls.map(([k]) => k)).toEqual([CLOUD_KEY]);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("notifies subscribers of a changed enabled state (Req 3.8)", async () => {
    await restore();
    const seen: Array<Record<string, boolean>> = [];
    const unsubscribe = subscribe((s) => seen.push(s.enabled));

    setDestinationEnabled("cloud", true);
    // Same value again: nothing changed, so nothing to report.
    setDestinationEnabled("cloud", true);
    unsubscribe();
    setDestinationEnabled("cloud", false);

    expect(seen).toEqual([{ cloud: true }]);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed reads for absent, non-boolean, and unreadable values
// Requirements 3.6
// ---------------------------------------------------------------------------

describe("disabled fallback for absent or corrupt persisted values (Req 3.6)", () => {
  it("reports cloud disabled when nothing is persisted", async () => {
    await restore();
    expect(getSnapshot().enabled).toEqual({ cloud: false });
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
    await restore();
    expect(getSnapshot().enabled).toEqual({ cloud: false });
  });

  it("reads the boolean value exactly", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    await restore();
    expect(getSnapshot().enabled).toEqual({ cloud: true });
  });

  it("reads an unreadable cloud value as disabled", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    throwOnRead(CLOUD_KEY);
    await restore();
    expect(isDestinationEnabled("cloud")).toBe(false);
  });

  it("survives storage that is unreadable entirely", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await expect(restore()).resolves.toBeUndefined();
    expect(getSnapshot().enabled).toEqual({ cloud: false });
    expect(isRestored()).toBe(true);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Restoration completes before the first sync cycle
// Requirements 3.5, 3.9
// ---------------------------------------------------------------------------

describe("restore lifecycle (Req 3.5, 3.9)", () => {
  it("reports disabled and not restored before restore() runs", () => {
    localStorage.setItem(CLOUD_KEY, "true");

    expect(isRestored()).toBe(false);
    expect(getSnapshot().restored).toBe(false);
    expect(isDestinationEnabled("cloud")).toBe(false);
  });

  it("reports restoration complete synchronously, before any awaiter resumes", async () => {
    localStorage.setItem(CLOUD_KEY, "true");

    const pending = restore();
    expect(isRestored()).toBe(true);
    expect(isDestinationEnabled("cloud")).toBe(true);

    await expect(pending).resolves.toBeUndefined();
    expect(getSnapshot().restored).toBe(true);
  });

  it("is idempotent: one read, one notification, the same promise", async () => {
    localStorage.setItem(CLOUD_KEY, "true");
    let notifications = 0;
    subscribe(() => {
      notifications += 1;
    });

    const first = restore();
    const second = restore();
    await Promise.all([first, second, restore()]);

    expect(second).toBe(first);
    expect(notifications).toBe(1);
    expect(isDestinationEnabled("cloud")).toBe(true);

    // A value written behind the module's back is not re-read by a repeat call.
    localStorage.setItem(CLOUD_KEY, "false");
    await restore();
    expect(isDestinationEnabled("cloud")).toBe(true);
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
    it("reports cloud unsaved but keeps the change in memory", async () => {
      await restore();
      install(CLOUD_KEY);

      expect(setDestinationEnabled("cloud", true)).toEqual({ persisted: false });

      expect(isDestinationEnabled("cloud")).toBe(true);
      const snapshot = getSnapshot();
      expect(snapshot.enabled.cloud).toBe(true);
      expect(snapshot.persistFailed).toBe("cloud");
    });

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

  it("notifies subscribers when a change is kept but unsaved", async () => {
    await restore();
    const seen: Array<string | null> = [];
    subscribe((s) => seen.push(s.persistFailed));
    throwOnWrite(CLOUD_KEY);

    setDestinationEnabled("cloud", true);

    expect(seen).toEqual(["cloud"]);
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

    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(localStorage.getItem(CLOUD_KEY)).toBeNull();

    await restart();
    expect(hasAckedDisclosure(EMAIL)).toBe(true);
    expect(isDestinationEnabled("cloud")).toBe(false);
  });
});
