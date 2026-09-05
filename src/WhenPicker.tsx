import { useEffect, useRef, useState } from "react";

interface Props {
  onChange: (timestamp: number) => void;
  /**
   * The instant to open on. Absent means now, which is the case for a new log.
   * Present when editing an existing event, so the control starts from the time
   * already recorded rather than silently re-dating it to now.
   */
  initial?: number;
}

const OFFSETS: { label: string; minutes: number }[] = [
  { label: "Now", minutes: 0 },
  { label: "15m ago", minutes: 15 },
  { label: "30m ago", minutes: 30 },
  { label: "1h ago", minutes: 60 },
  { label: "2h ago", minutes: 120 },
  { label: "3h ago", minutes: 180 },
];

/** Local-time `YYYY-MM-DDTHH:mm`, the only format `datetime-local` accepts. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * Parse a `datetime-local` value as local time, clamped to the present.
 *
 * A future timestamp is refused rather than accepted, because every correlation
 * in the app runs forward from a meal to the symptoms that follow it. A meal
 * dated tomorrow would silently drop out of the analysis instead of failing
 * visibly, which is the worst of the two outcomes.
 *
 * Returns `null` for an unparseable value, so a half-typed date is ignored
 * rather than resetting the selection.
 */
export function parseLocalInputValue(value: string, nowMs = Date.now()): number | null {
  if (!value) return null;
  // `new Date("YYYY-MM-DDTHH:mm")` is local time; the `Z`-less form is what the
  // input produces, so no timezone maths is needed.
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.min(ms, nowMs);
}

/**
 * Lets the user backdate an event. Symptoms in particular are often logged a
 * while after they start, so an accurate timestamp matters for correlation.
 *
 * The relative chips cover the common cases in one tap. The trailing exact
 * option exists because anything older than the longest chip was previously
 * unloggable at its real time, which is exactly the case when someone fills in
 * yesterday's meals.
 */
export default function WhenPicker({ onChange, initial }: Props) {
  const base = useRef(Date.now());
  /**
   * An `initial` more than a minute in the past is an existing timestamp being
   * edited, so the control opens on the exact instant rather than on "Now" — which
   * would misrepresent the stored value before the user touched anything.
   */
  const opensExact = initial !== undefined && base.current - initial > 60_000;
  /** Which chip is selected, or `"exact"` while the picked instant is in use. */
  const [idx, setIdx] = useState<number | "exact">(opensExact ? "exact" : 0);
  const [exactOpen, setExactOpen] = useState(false);
  const [exactValue, setExactValue] = useState(() =>
    toLocalInputValue(initial ?? base.current)
  );

  useEffect(() => {
    onChange(initial ?? base.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(i: number) {
    setIdx(i);
    setExactOpen(false);
    onChange(base.current - OFFSETS[i].minutes * 60_000);
  }

  /** Open the exact picker seeded with whatever is currently selected. */
  function openExact() {
    const current =
      idx === "exact"
        ? parseLocalInputValue(exactValue) ?? base.current
        : base.current - OFFSETS[idx].minutes * 60_000;
    setExactValue(toLocalInputValue(current));
    setExactOpen(true);
    setIdx("exact");
    onChange(current);
  }

  function onExactChange(value: string) {
    setExactValue(value);
    const ms = parseLocalInputValue(value);
    if (ms === null) return;
    // A clamped value is written back to the input, so the field never shows a
    // future time the app is not going to use.
    const clamped = toLocalInputValue(ms);
    if (clamped !== value) setExactValue(clamped);
    onChange(ms);
  }

  return (
    <div>
      <p className="section-title">When?</p>
      <div className="hscroll">
        {OFFSETS.map((o, i) => (
          <button
            key={o.label}
            className={`chip${idx === i ? " selected" : ""}`}
            onClick={() => pick(i)}
          >
            {o.label}
          </button>
        ))}
        <button
          className={`chip${idx === "exact" ? " selected" : ""}`}
          onClick={openExact}
          aria-expanded={exactOpen}
        >
          {idx === "exact" && !exactOpen
            ? new Date(parseLocalInputValue(exactValue) ?? base.current).toLocaleString(
                undefined,
                { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
              )
            : "Date…"}
        </button>
      </div>

      {exactOpen && (
        <input
          className="search when-exact"
          type="datetime-local"
          aria-label="Date and time"
          value={exactValue}
          max={toLocalInputValue(Date.now())}
          onChange={(e) => onExactChange(e.target.value)}
        />
      )}
    </div>
  );
}
