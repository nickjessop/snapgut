import { useEffect, useMemo, useState } from "react";
import { getEntries, toCSV, type Entry } from "./db";
import { getSymptom } from "./symptoms";

export default function HistoryView() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    getEntries().then(setEntries);
  }, []);

  async function exportCSV() {
    const csv = toCSV(entries, (id) => getSymptom(id)?.label ?? id);
    const blob = new Blob([csv], { type: "text/csv" });
    const file = new File([blob], "food-snap.csv", { type: "text/csv" });

    // Prefer the native share sheet on mobile → "Save to Files / iCloud Drive".
    const nav = navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
    };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: "Food Snap export" });
        return;
      } catch {
        /* user cancelled — fall through to download */
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "food-snap.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="history">
      <div className="history-header">
        <h1>Your log</h1>
        {entries.length > 0 && (
          <button className="link-btn" onClick={exportCSV}>
            Export CSV
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="empty">No meals logged yet. Snap your first one!</p>
      ) : (
        entries.map((e) => <EntryRow key={e.id} entry={e} />)
      )}
    </div>
  );
}

function EntryRow({ entry }: { entry: Entry }) {
  const url = useMemo(
    () => (entry.photo ? URL.createObjectURL(entry.photo) : null),
    [entry.photo]
  );
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const d = new Date(entry.createdAt);
  const when = d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const symptomText = entry.symptoms.length
    ? entry.symptoms
        .map((s) => `${getSymptom(s.id)?.emoji ?? ""} ${getSymptom(s.id)?.label ?? s.id}`)
        .join(", ")
    : "No symptoms logged";

  return (
    <div className="entry">
      {url && <img src={url} alt="" />}
      <div className="meta">
        <div className="foods-line">
          {entry.foods.length ? entry.foods.join(", ") : "Meal"}
        </div>
        <div className="sub">{symptomText}</div>
        <div className="sub">{when}</div>
      </div>
    </div>
  );
}
