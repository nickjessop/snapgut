// The three pre-launch changes in docs/pre-launch-fixes.md:
//
//   1. a meal can be logged with no photo, or with one from the photo library
//   2. the When picker can name an exact instant, clamped to the present
//   3. saving an edit can never drop a photo the user did not touch
//
// The photo-less path is the one worth being careful about, because it inverts an
// assumption the meal flow was built on: `MealDetails` used to be unreachable
// without a Blob, and `putEvent` replaces whole records, so "no photo" and "photo
// removed" are one keystroke apart in the save path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { ONBOARDED_KEY } from "./Intro";
import { DEFAULT_APP_PATH } from "../shared/site.js";
import { parseLocalInputValue } from "./WhenPicker";

const h = vi.hoisted(() => ({
  token: null as string | null,
  /** Records handed to `putEvent`, so the saved shape is inspectable. */
  saved: [] as Record<string, unknown>[],
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [],
    putEvent: async (e: Record<string, unknown>) => {
      h.saved.push(e);
      return 1;
    },
    deleteEvent: async () => {},
    getOutboxCount: async () => 0,
    sweepTombstones: async () => 0,
  };
});

vi.mock("./cloudSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloudSync")>();
  return {
    ...actual,
    hydrateSyncState: async () => {},
    requestSync: async () => {},
    startTriggers: () => () => {},
  };
});

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    getToken: () => h.token,
    fetchMe: async () => null,
    clearToken: () => {},
  };
});

import App from "./App";
import MealDetails from "./MealDetails";

async function click(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
}

/** Object URLs handed out during a test, newest last. */
let objectUrls: { url: string; blob: Blob }[] = [];
/** Object URLs revoked during a test, so a leak or a double-revoke is visible. */
let revokedUrls: string[] = [];

beforeEach(() => {
  h.token = null;
  h.saved = [];
  localStorage.clear();
  localStorage.setItem(ONBOARDED_KEY, "1");
  window.history.pushState(null, "", DEFAULT_APP_PATH);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
  // jsdom implements neither, which is why the thumbnail path had no coverage
  // before now. Stubbed rather than skipped: the effect that builds and revokes
  // these URLs is where the reported photo bug most plausibly lived.
  objectUrls = [];
  revokedUrls = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const u = `blob:mock/${objectUrls.length}`;
    objectUrls.push({ url: u, blob });
    return u;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((u: string) => {
    revokedUrls.push(u);
  }) as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("logging a meal with no photo", () => {
  it("offers the control on the camera screen", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    // Both escapes sit beside the shutter. jsdom grants no camera, so this is the
    // fallback branch — which is exactly where they matter most.
    expect(screen.getByText("Log without a photo")).toBeTruthy();
    expect(screen.getByText("Choose from library")).toBeTruthy();
  });

  it("goes straight to the details screen, skipping the caption step", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await click(screen.getByText("Log without a photo"));

    // The capture screen previews and captions a photo, so with none it has no
    // job. Landing on "Meal details" rather than on a blank preview is the point.
    await screen.findByText("Meal details");
    expect(screen.queryByAltText("Your meal")).toBeNull();
  });

  it("opens in manual mode without explaining a withheld AI use", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await click(screen.getByText("Log without a photo"));
    await screen.findByText("Meal details");

    // No image means nothing to analyse — not an AI use spent, not a paywall, not
    // a sign-in prompt. Showing any of those would explain a restriction that
    // does not exist.
    expect(screen.queryByText("Analyzing your meal…")).toBeNull();
    expect(screen.queryByText("Sign in to use AI")).toBeNull();
    expect(screen.queryByText("Unlock Pro")).toBeNull();
    expect(screen.queryByText("Ingredients are yours to fill in")).toBeNull();
  });

  it("makes no recognition request", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await click(screen.getByText("Log without a photo"));
    await screen.findByText("Meal details");

    const urls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      ([u]) => String(u)
    );
    expect(urls.some((u) => u.includes("/api/recognize"))).toBe(false);
  });

  it("saves a meal with no photo key rather than a broken one", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await click(screen.getByText("Log without a photo"));
    await screen.findByText("Meal details");

    fireEvent.change(screen.getByPlaceholderText("Dish name"), {
      target: { value: "Leftover curry" },
    });
    await click(screen.getByText("Save meal"));

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].dish).toBe("Leftover curry");
    expect(h.saved[0].type).toBe("meal");
    // `undefined` rather than `null`: the field is optional in the schema, and a
    // null would round-trip through the sync codec as a present-but-empty value.
    expect(h.saved[0].photo).toBeUndefined();
  });
});

describe("saving an edit never drops the photo", () => {
  /** A meal already in the log, with a photo. */
  const existing = {
    id: "meal-1",
    type: "meal" as const,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    dish: "Ramen",
    ingredients: [{ name: "noodles", confidence: "confident" as const }],
    photo: new Blob(["jpeg-bytes"], { type: "image/jpeg" }),
  };

  it("carries the stored Blob through a save that was handed none", async () => {
    // The regression guard. `putEvent` replaces the whole record, so if this
    // screen ever renders with `photo` already cleared — a reset, a remount, an
    // unreadable Blob — the save must fall back to the stored image rather than
    // write the record without it.
    render(
      <MealDetails
        photo={null}
        editing={existing}
        authed={false}
        onSaved={() => {}}
        onBack={() => {}}
      />
    );

    await click(await screen.findByText("Update"));

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].photo).toBe(existing.photo);
  });

  it("keeps the Blob on an ordinary edit", async () => {
    render(
      <MealDetails
        photo={existing.photo}
        editing={existing}
        authed={false}
        onSaved={() => {}}
        onBack={() => {}}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Dish name"), {
      target: { value: "Ramen with egg" },
    });
    await click(screen.getByText("Update"));

    expect(h.saved[0].dish).toBe("Ramen with egg");
    expect(h.saved[0].photo).toBe(existing.photo);
  });

  it("builds a preview URL from the stored Blob and revokes it on unmount", async () => {
    const { unmount } = render(
      <MealDetails
        photo={existing.photo}
        editing={existing}
        authed={false}
        onSaved={() => {}}
        onBack={() => {}}
      />
    );
    await screen.findByText("Update");

    expect(objectUrls.some((o) => o.blob === existing.photo)).toBe(true);
    const issued = objectUrls[objectUrls.length - 1].url;

    unmount();
    // A leaked object URL pins the Blob in memory for the life of the document,
    // which for a photo-heavy log is not a small leak.
    expect(revokedUrls).toContain(issued);
  });

  it("builds no preview URL for a photo-less meal", async () => {
    render(
      <MealDetails photo={null} authed={false} onSaved={() => {}} onBack={() => {}} />
    );
    await screen.findByText("Save meal");

    expect(objectUrls).toHaveLength(0);
    expect(screen.queryByAltText("Meal")).toBeNull();
  });
});

describe("backdating a meal", () => {
  it("offers the When picker on a new meal", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await click(screen.getByText("Log without a photo"));
    await screen.findByText("Meal details");

    // Meals were the only log type that could not be backdated — this screen
    // hardcoded `Date.now()` while every other flow offered the picker. Backwards,
    // since a meal is both the most often logged after the fact and the anchor
    // every association is measured forward from.
    expect(screen.getByText("When?")).toBeTruthy();
    expect(screen.getByText("Date…")).toBeTruthy();
  });

  it("saves the chosen instant rather than now", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await click(screen.getByText("Log without a photo"));
    await screen.findByText("Meal details");

    await click(screen.getByText("Date…"));
    const field = screen.getByLabelText("Date and time") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "2026-07-25T19:15" } });
    fireEvent.change(screen.getByPlaceholderText("Dish name"), {
      target: { value: "Yesterday's curry" },
    });
    await click(screen.getByText("Save meal"));

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].createdAt).toBe(new Date("2026-07-25T19:15").getTime());
  });

  it("opens on the stored time when editing, not on now", async () => {
    const earlier = Date.now() - 5 * 60 * 60 * 1000;
    render(
      <MealDetails
        photo={null}
        editing={{
          id: "m1",
          type: "meal",
          createdAt: earlier,
          updatedAt: earlier,
          dish: "Soup",
          ingredients: [],
        }}
        authed={false}
        onSaved={() => {}}
        onBack={() => {}}
      />
    );

    await click(await screen.findByText("Update"));

    // Re-dating an edited meal to now would quietly move it out of the window that
    // links it to the symptoms that followed, which is the opposite of a no-op.
    expect(h.saved[0].createdAt).toBe(earlier);
  });
});

describe("the exact-time option", () => {
  const NOON = new Date("2026-08-01T12:00:00").getTime();

  it("parses a datetime-local value as local time", () => {
    expect(parseLocalInputValue("2026-08-01T09:30", NOON)).toBe(
      new Date("2026-08-01T09:30").getTime()
    );
  });

  it("clamps a future instant to now", () => {
    // Every correlation runs forward from a meal to the symptoms that follow it,
    // so a future timestamp would not error — it would silently fall out of the
    // analysis, which is worse.
    expect(parseLocalInputValue("2030-01-01T00:00", NOON)).toBe(NOON);
  });

  it("returns null for an unparseable value, leaving the selection alone", () => {
    // A half-typed date must not reset what the user already picked.
    expect(parseLocalInputValue("", NOON)).toBeNull();
    expect(parseLocalInputValue("not-a-date", NOON)).toBeNull();
  });

  it("accepts an instant far older than the longest chip", () => {
    const lastWeek = new Date("2026-07-25T19:15").getTime();
    expect(parseLocalInputValue("2026-07-25T19:15", NOON)).toBe(lastWeek);
  });

  it("is offered in the symptom flow alongside the relative chips", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await click(screen.getByLabelText("Add log"));
    await click(screen.getByText("Symptom"));

    // An addition, not a redesign: the quick options stay exactly as they were.
    await screen.findByText("When?");
    for (const label of ["Now", "15m ago", "3h ago"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Date…")).toBeTruthy();
  });

  it("reveals a datetime field capped at the present", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await click(screen.getByLabelText("Add log"));
    await click(screen.getByText("Symptom"));
    await click(await screen.findByText("Date…"));

    const field = screen.getByLabelText("Date and time") as HTMLInputElement;
    expect(field.type).toBe("datetime-local");
    // The `max` attribute stops a future date at the picker, before the clamp has
    // to correct it — the clamp is the backstop, not the only defence.
    expect(field.max).toBeTruthy();
  });
});
