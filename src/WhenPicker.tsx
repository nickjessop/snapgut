import { useEffect, useRef, useState } from "react";

interface Props {
  onChange: (timestamp: number) => void;
}

const OFFSETS: { label: string; minutes: number }[] = [
  { label: "Now", minutes: 0 },
  { label: "15m ago", minutes: 15 },
  { label: "30m ago", minutes: 30 },
  { label: "1h ago", minutes: 60 },
  { label: "2h ago", minutes: 120 },
  { label: "3h ago", minutes: 180 },
];

/**
 * Lets the user backdate an event. Symptoms in particular are often logged a
 * while after they start, so an accurate timestamp matters for correlation.
 */
export default function WhenPicker({ onChange }: Props) {
  const base = useRef(Date.now());
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    onChange(base.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(i: number) {
    setIdx(i);
    onChange(base.current - OFFSETS[i].minutes * 60_000);
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
      </div>
    </div>
  );
}
