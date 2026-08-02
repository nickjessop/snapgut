// Symptom selection, severity behind a hold, and the one-time hint.
//
// The behaviour worth guarding is that a chip stays put. Selected symptoms used to be
// lifted into a separate list above the grid, so the chip you just tapped was no
// longer where you tapped it — fine for one selection, disorienting for four.
//
// The rest is the hold gesture, and most of that is the cases that must *not* fire:
// the rows scroll horizontally, so a drag beginning on a chip is usually a scroll.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import SymptomPicker from "./SymptomPicker";
import { SYMPTOMS, getSymptom, type Severity } from "./symptoms";

const HINT_KEY = "food-snap-symptom-hold-hint";

/** The most recent emitted selection. `Array.prototype.at` needs a newer lib target
 *  than this project sets, so index arithmetic it is. */
function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

/** Harness that owns the selection, as the log flows do. */
function Harness({ onChange }: { onChange?: (m: Map<string, Severity>) => void } = {}) {
  const [selected, setSelected] = useState<Map<string, Severity>>(new Map());
  return (
    <SymptomPicker
      selected={selected}
      onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }}
    />
  );
}

/** The chip button for a symptom label. */
function chip(label: string): HTMLElement {
  const el = screen
    .getAllByRole("button")
    .find((b) => b.className.includes("symptom-chip") && b.textContent?.includes(label));
  if (!el) throw new Error(`no chip for ${label}`);
  return el;
}

const pointer = (x = 100, y = 100) => ({ isPrimary: true, button: 0, clientX: x, clientY: y });

/** Tap: press, release, click — the order a browser sends. */
async function tap(el: Element) {
  await act(async () => {
    fireEvent.pointerDown(el, pointer());
    fireEvent.pointerUp(el);
    fireEvent.click(el);
  });
}

/** Press and hold past the threshold, then release. */
async function hold(el: Element, ms = 500) {
  await act(async () => {
    fireEvent.pointerDown(el, pointer());
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {
    fireEvent.pointerUp(el);
    // The browser still delivers a click after a long press; it must be swallowed.
    fireEvent.click(el);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  // Off by default so it cannot sit over the grid in the other cases.
  localStorage.setItem(HINT_KEY, "1");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("selecting in place", () => {
  it("marks the chip selected without moving it", async () => {
    render(<Harness />);
    const before = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("symptom-chip"))
      .map((b) => b.textContent);

    await tap(chip("Bloating"));

    // Same chips, same order — the selected one is styled, not relocated.
    const after = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("symptom-chip"))
      .map((b) => b.textContent?.replace("MOD", ""));
    expect(after).toEqual(before);
    expect(chip("Bloating").getAttribute("aria-pressed")).toBe("true");
  });

  it("defaults to moderate and shows it as a corner badge", async () => {
    const seen: Map<string, Severity>[] = [];
    render(<Harness onChange={(m) => seen.push(m)} />);

    await tap(chip("Gassy"));

    expect(last(seen)?.get("gas")).toBe("moderate");
    expect(chip("Gassy").querySelector(".sev-badge")?.textContent).toBe("MOD");
  });

  it("deselects on a second tap", async () => {
    const seen: Map<string, Severity>[] = [];
    render(<Harness onChange={(m) => seen.push(m)} />);

    await tap(chip("Nausea"));
    await tap(chip("Nausea"));

    expect(last(seen)?.has("nausea")).toBe(false);
    expect(chip("Nausea").querySelector(".sev-badge")).toBeNull();
  });

  it("spells the severity out for assistive technology", async () => {
    render(<Harness />);
    await tap(chip("Bloating"));

    // The badge is an abbreviation a screen reader would spell letter by letter.
    expect(chip("Bloating").getAttribute("aria-label")).toBe("Bloating, moderate");
  });
});

describe("holding a chip", () => {
  it("opens the detail with its explanation", async () => {
    render(<Harness />);
    await hold(chip("Distension"));

    await screen.findByRole("dialog", { name: "Distension" });
    // The description exists to separate symptoms people use interchangeably.
    expect(document.body.textContent).toContain("visibly larger");
    expect(screen.getByText("How bad was it?")).toBeTruthy();
  });

  it("does not also toggle the selection", async () => {
    const seen: Map<string, Severity>[] = [];
    render(<Harness onChange={(m) => seen.push(m)} />);

    await hold(chip("Cramping"));

    // The click a browser sends after a hold must be swallowed, or the hold would
    // both open the sheet and select the symptom.
    expect(seen).toHaveLength(0);
    expect(chip("Cramping").getAttribute("aria-pressed")).toBe("false");
  });

  it("sets a severity, which selects the symptom and badges it", async () => {
    const seen: Map<string, Severity>[] = [];
    render(<Harness onChange={(m) => seen.push(m)} />);
    await hold(chip("Reflux / heartburn"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Severe" }));
    });

    expect(last(seen)?.get("reflux")).toBe("severe");
    expect(chip("Reflux / heartburn").querySelector(".sev-badge")?.textContent).toBe("SEV");
  });

  it("reopens on a second hold with the current severity marked", async () => {
    render(<Harness />);
    await hold(chip("Fatigue / sluggish"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mild" }));
      fireEvent.click(screen.getByText("Done"));
    });

    await hold(chip("Fatigue / sluggish"));

    // Editing, not starting over.
    expect(screen.getByRole("button", { name: "Mild" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("offers removal only once the symptom is on the entry", async () => {
    render(<Harness />);
    await hold(chip("Headache"));
    // Nothing to undo yet, so the control would do nothing.
    expect(screen.queryByText("Remove this symptom")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Moderate" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Remove this symptom"));
    });

    expect(chip("Headache").getAttribute("aria-pressed")).toBe("false");
  });

  it("ignores a drag, which is a scroll rather than a hold", async () => {
    render(<Harness />);
    const el = chip("Bloating");

    await act(async () => {
      fireEvent.pointerDown(el, pointer(100, 100));
      fireEvent.pointerMove(el, { clientX: 40, clientY: 104 });
      vi.advanceTimersByTime(600);
      fireEvent.pointerUp(el);
    });

    // The chip rows scroll horizontally. Firing on a drag would make the rows
    // unusable, which is a worse outcome than a missed hold.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a press shorter than the threshold", async () => {
    render(<Harness />);
    await act(async () => {
      fireEvent.pointerDown(chip("Bloating"), pointer());
      vi.advanceTimersByTime(200);
      fireEvent.pointerUp(chip("Bloating"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels when the pointer leaves the chip", async () => {
    render(<Harness />);
    await act(async () => {
      fireEvent.pointerDown(chip("Bloating"), pointer());
      fireEvent.pointerLeave(chip("Bloating"));
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the hold hint", () => {
  it("appears until dismissed, because a hold is not discoverable", async () => {
    localStorage.removeItem(HINT_KEY);
    render(<Harness />);

    expect(screen.getByText(/Hold a symptom/)).toBeTruthy();
  });

  it("stays gone once dismissed, on this and every later log", async () => {
    localStorage.removeItem(HINT_KEY);
    render(<Harness />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dismiss hint"));
    });
    expect(screen.queryByText(/Hold a symptom/)).toBeNull();

    // A new log flow must not bring it back.
    cleanup();
    render(<Harness />);
    expect(screen.queryByText(/Hold a symptom/)).toBeNull();
    expect(localStorage.getItem(HINT_KEY)).toBe("1");
  });
});

describe("the symptom descriptions", () => {
  it("covers every symptom, since any chip can be held", () => {
    // A hold that opens a sheet with no explanation is a dead end.
    const missing = SYMPTOMS.filter((s) => !getSymptom(s.id)?.description).map((s) => s.id);
    expect(missing).toEqual([]);
  });

  it("makes no diagnostic claim", () => {
    // Same line docs/positioning.md draws: these describe a feeling, they do not
    // interpret it.
    const forbidden = [/\bdiagnos/i, /\byou have\b/i, /\bcauses\b/i, /\bintoleran/i, /\ballerg/i];
    for (const s of SYMPTOMS) {
      for (const pattern of forbidden) {
        expect(pattern.test(s.description ?? ""), `${s.id} matches ${pattern}`).toBe(false);
      }
    }
  });
});
