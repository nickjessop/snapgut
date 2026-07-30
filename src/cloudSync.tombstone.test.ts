// Property 9: Tombstones round-trip as tombstones carrying no content.
//
// **Validates: Requirements 9.1, 20.8**
//
// Feature: cloud-sync, task 6.4. Design.md groups Properties 6–9 into
// `cloudSync.roundtrip.test.ts`; Property 9 lives here on its own so the
// tombstone rules stay readable next to the content-fidelity properties, which
// assert over a different generator.
//
// Two directions are asserted, because Req 9.1 and Req 20.8 point opposite ways:
//
// - **Outbound (Req 9.1).** A local Tombstone serializes to identity, `type`,
//   `createdAt`, the deletion Revision_Time, the deleted flag, `schemaVersion`,
//   and its preserved unknown fields — and nothing else. No `note`, no `dish`,
//   no `ingredients`, no `symptoms`, no `bristol`, no `stress`, no `sleep`, no
//   `photo`.
// - **Inbound (Req 20.8).** A wire record marked `deleted` comes back as a
//   Tombstone even when it *also* carries content, and that content is
//   discarded rather than stored.
//
// One deliberate boundary: `fromEventRecord` runs its domain checks *before* the
// tombstone branch, so a deleted record whose payload is out of domain (a
// `bristol` of 9, say) is skipped like any other malformed record rather than
// being salvaged as a tombstone. The inbound generator therefore builds its
// content from `arbLogEvent`, whose every field is in domain; the out-of-domain
// case belongs to Property 10.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { SCHEMA_VERSION, fromEventRecord, toEventRecord } from "./cloudSync";
import { isTombstone, type StoredRecord } from "./db";
import {
  arbLogEvent,
  arbTombstone,
  isSyncTombstone,
  toWireLike,
  type SyncLogEvent,
  type SyncTombstone,
} from "./test/arbitraries";

const RUNS = { numRuns: 200 } as const;

/** Every field that carries event content — none of it may survive a deletion. */
const CONTENT_KEYS = [
  "note",
  "dish",
  "ingredients",
  "symptoms",
  "bristol",
  "stress",
  "sleep",
  "photo",
] as const;

/** The identity/revision keys a tombstone is allowed to carry on the wire. */
const TOMBSTONE_WIRE_KEYS = [
  "id",
  "type",
  "createdAt",
  "updatedAt",
  "schemaVersion",
  "deleted",
] as const;

function contentKeysOn(o: object): string[] {
  return CONTENT_KEYS.filter((k) => k in o);
}

/**
 * The `unknownFields` container as it survives a round trip: an empty container
 * round-trips as *absent*, because the wire carries preserved fields inline and
 * has no container key, so "no preserved fields" has exactly one representation.
 */
function carriedUnknown(fields: Record<string, unknown> | undefined): {
  unknownFields?: Record<string, unknown>;
} {
  return fields && Object.keys(fields).length > 0 ? { unknownFields: fields } : {};
}

describe("Property 9: tombstones round-trip as tombstones carrying no content", () => {
  it("serializes a tombstone to identity, revision, and the deleted flag only", () => {
    fc.assert(
      fc.property(arbTombstone, (t: SyncTombstone) => {
        const wire = toEventRecord(t);

        expect(wire.id).toBe(t.id);
        expect(wire.type).toBe(t.type);
        expect(wire.createdAt).toBe(t.createdAt);
        expect(wire.updatedAt).toBe(t.updatedAt);
        expect(wire.deleted).toBe(true);
        expect(wire.schemaVersion).toBe(SCHEMA_VERSION);

        // Req 9.1: those keys plus the preserved unknown fields, and nothing else.
        expect(new Set(Object.keys(wire))).toEqual(
          new Set([...TOMBSTONE_WIRE_KEYS, ...Object.keys(t.unknownFields ?? {})]),
        );
        expect(contentKeysOn(wire)).toEqual([]);
      }),
      RUNS,
    );
  });

  it("deserializes back to a tombstone with the same id and revision", () => {
    fc.assert(
      fc.property(arbTombstone, (t: SyncTombstone) => {
        const back = fromEventRecord(toEventRecord(t));

        expect(back).not.toBeNull();
        const record = back as StoredRecord;
        expect(isTombstone(record)).toBe(true);
        expect(record.id).toBe(t.id);
        expect(record.updatedAt).toBe(t.updatedAt);
        expect((record as { deleted?: unknown }).deleted).toBe(true);
        expect(contentKeysOn(record)).toEqual([]);

        // Req 20.8 in full: identity, revision, deleted flag, preserved fields.
        expect(record).toEqual({
          id: t.id,
          type: t.type,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          deleted: true,
          ...carriedUnknown(t.unknownFields),
        });
      }),
      RUNS,
    );
  });

  it("discards content on a wire record that is marked deleted", () => {
    // A record built from a real event's fields, then marked deleted — what a
    // peer running an older or buggier client could put on the wire.
    const arbDeletedWireCarryingContent = fc
      .tuple(arbLogEvent, fc.boolean())
      .map(([event, withPhotoish]: [SyncLogEvent, boolean]) => {
        const wire = toWireLike(event);
        wire.deleted = true;
        // `photo` is never legal on the wire; a deleted record must not
        // resurrect one either (Req 16.1, 20.2, 20.8).
        if (withPhotoish) wire.photo = "data:image/png;base64,AAAA";
        return { event, wire };
      });

    fc.assert(
      fc.property(arbDeletedWireCarryingContent, ({ event, wire }) => {
        const back = fromEventRecord(wire);

        expect(back).not.toBeNull();
        const record = back as StoredRecord;
        expect(isTombstone(record)).toBe(true);
        expect(record.id).toBe(event.id);
        expect(record.updatedAt).toBe(event.updatedAt);
        expect(contentKeysOn(record)).toEqual([]);

        expect(record).toEqual({
          id: event.id,
          type: event.type,
          createdAt: event.createdAt,
          updatedAt: event.updatedAt,
          deleted: true,
          ...carriedUnknown(event.unknownFields),
        });

        // The discard sticks: pushing what came back sends no content either.
        const reserialized = toEventRecord(record);
        expect(contentKeysOn(reserialized)).toEqual([]);
        expect(reserialized.deleted).toBe(true);
      }),
      RUNS,
    );
  });

  it("keeps a tombstone a tombstone across repeated round trips", () => {
    fc.assert(
      fc.property(arbTombstone, (t: SyncTombstone) => {
        const once = fromEventRecord(toEventRecord(t)) as StoredRecord;
        const twice = fromEventRecord(toEventRecord(once)) as StoredRecord;

        expect(isSyncTombstone(once as never)).toBe(true);
        expect(twice).toEqual(once);
      }),
      RUNS,
    );
  });
});
