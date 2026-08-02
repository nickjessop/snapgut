// Restoring a backup that contains photos.
//
// This is the regression test for a real data-recovery failure. The import decoded a
// photo with `fetch(dataUrl).then(r => r.blob())` — tidy, and silently broken from
// the moment the Content-Security-Policy was tightened. `connect-src 'self'` governs
// `fetch`, a `data:` URL is not `'self'`, so every restore of a file containing a
// meal photo failed with a bare "Failed to fetch".
//
// It stayed hidden because a photo-free backup imports perfectly, and a test suite
// running without the production CSP cannot reproduce the block at all. So these
// tests pin the *decoding* rather than the network behaviour: no `fetch` in the path
// means no directive can reach it.
//
// The other half is blast radius. One unreadable entry used to abandon the whole
// import, which is the worst possible failure for the feature that exists to recover
// data.

import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { dataUrlToBlob, importBackup } from "./backup";
import { getRecord } from "./db";

/** A backup file, in the on-disk shape `exportBackup` writes. */
function backupFile(entries: unknown[]): File {
  const payload = { app: "snapgut", version: 1, exportedAt: Date.now(), events: entries };
  const json = JSON.stringify(payload);
  return { name: "snapgut-backup.json", text: async () => json } as unknown as File;
}

let seq = 0;
const freshId = () => `photo-import-${++seq}`;

// jsdom's Blob implements neither `.text()` nor `.arrayBuffer()`, so the contents are
// read the way the app itself reads them on export — through FileReader.
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsText(blob);
  });
}

function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = reject;
    r.readAsArrayBuffer(blob);
  });
}

/** A base64 `data:` URL, exactly as `blobToDataUrl` produces on export. */
function dataUrl(bytes: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${btoa(bytes)}`;
}

/** A meal entry carrying a photo. */
function mealWith(id: string, photoDataUrl: string | undefined) {
  return {
    id,
    type: "meal",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    dish: "Ramen",
    ingredients: [{ name: "noodles", confidence: "confident" }],
    ...(photoDataUrl === undefined ? {} : { photoDataUrl }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("restoring photos", () => {
  it("decodes a photo without going through fetch", async () => {
    // The assertion that matters: if the import still used `fetch`, this spy would
    // catch it, and under the real CSP that call is what fails.
    const spy = vi.spyOn(globalThis, "fetch");
    const id = freshId();

    const result = await importBackup(backupFile([mealWith(id, dataUrl("jpeg-bytes-here"))]));

    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("restores the exact bytes", async () => {
    // Asserted on the decoder rather than on what comes back out of the store:
    // jsdom's IndexedDB stand-in does not round-trip a Blob, so reading one back
    // would prove nothing about the decoding.
    const blob = dataUrlToBlob(dataUrl("hello-photo"));
    expect(await readText(blob)).toBe("hello-photo");
    expect(blob.type).toBe("image/jpeg");
  });

  it("preserves the declared mime type", () => {
    expect(dataUrlToBlob(dataUrl("png-bytes", "image/png")).type).toBe("image/png");
    expect(dataUrlToBlob(dataUrl("x", "image/webp")).type).toBe("image/webp");
  });

  it("handles bytes that are not valid text", async () => {
    // A real JPEG is arbitrary binary, and `atob` yields char codes that have to be
    // written as bytes rather than as a string — getting that wrong corrupts every
    // photo while still producing a plausible-looking Blob.
    const raw = String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
    const blob = dataUrlToBlob(`data:image/jpeg;base64,${btoa(raw)}`);
    expect([...(await readBytes(blob))]).toEqual([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  });

  it("accepts a percent-encoded data URL as well as base64", async () => {
    // Legal, and what a hand-edited or third-party-written file is most likely to
    // contain. Rejecting it would fail an import for no good reason.
    expect(await readText(dataUrlToBlob("data:text/plain,hi%20there"))).toBe("hi there");
  });

  it.each([
    ["not a data URL at all", "https://example.com/a.jpg"],
    ["a data URL with no comma", "data:image/jpeg;base64"],
    ["an empty string", ""],
  ])("throws on %s, so the caller can skip just the photo", (_label, input) => {
    expect(() => dataUrlToBlob(input)).toThrow();
  });

  it("still restores the meal when its photo is unreadable", async () => {
    const id = freshId();
    const result = await importBackup(
      backupFile([{ ...mealWith(id, undefined), photoDataUrl: "not-a-data-url-at-all" }]),
    );

    // The dish, ingredients and timestamp are what the analysis uses. Losing the
    // whole entry over its thumbnail would be the wrong trade.
    expect(result).toEqual({ imported: 1, skipped: 0 });
    const stored = (await getRecord(id)) as { dish?: string; photo?: Blob };
    expect(stored.dish).toBe("Ramen");
    expect(stored.photo).toBeUndefined();
  });

  it("keeps importing after an entry it cannot read", async () => {
    const good1 = freshId();
    const good2 = freshId();

    const result = await importBackup(
      backupFile([
        mealWith(good1, dataUrl("one")),
        { id: 42, type: "meal" }, // no usable id
        null,
        "junk",
        mealWith(good2, dataUrl("two")),
      ]),
    );

    // Before this, one bad entry threw and abandoned the file — so a single corrupt
    // record cost a year of logs.
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(3);
    expect(await getRecord(good1)).toBeTruthy();
    expect(await getRecord(good2)).toBeTruthy();
  });

  it("refuses a file where nothing at all could be read", async () => {
    // Reporting "Restored 0 items" would read as success.
    await expect(
      importBackup(backupFile([null, "junk", { type: "meal" }])),
    ).rejects.toThrow(/couldn't be read/i);
  });

  it("is idempotent for a photo entry", async () => {
    const id = freshId();
    const file = () => backupFile([mealWith(id, dataUrl("same-bytes"))]);

    await importBackup(file());
    const first = await getRecord(id);
    await importBackup(file());
    const second = await getRecord(id);

    // `touch: false` keeps the revision the file carries, so a second import of the
    // same file changes nothing.
    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(second?.updatedAt).toBe(1_700_000_000_000);
  });

  it("reads a photo-free backup unchanged", async () => {
    // The case that always worked, and the reason the bug went unnoticed.
    const id = freshId();
    const result = await importBackup(
      backupFile([{ id, type: "checkin", createdAt: 1_700_000_000_000, stress: "low" }]),
    );
    expect(result).toEqual({ imported: 1, skipped: 0 });
  });
});
