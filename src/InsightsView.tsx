import { useEffect, useState } from "react";
import { getEvents } from "./db";
import { computeEvidence, type EvidenceSummary } from "./insights";
import { getInsights } from "./api";
import FoodsTab from "./FoodsTab";

type InsightTab = "patterns" | "foods";

interface AiInsight {
  headline: string;
  body: string;
  redFlag?: string;
}

export default function InsightsView({ reloadKey = 0 }: { reloadKey?: number }) {
  const [tab, setTab] = useState<InsightTab>("patterns");

  return (
    <div className="insights">
      <h1>Insights</h1>

      <div className="seg">
        <button
          className={`seg-btn${tab === "patterns" ? " on" : ""}`}
          onClick={() => setTab("patterns")}
        >
          Patterns
        </button>
        <button
          className={`seg-btn${tab === "foods" ? " on" : ""}`}
          onClick={() => setTab("foods")}
        >
          Foods
        </button>
      </div>

      {tab === "patterns" ? <PatternsTab reloadKey={reloadKey} /> : <FoodsTab reloadKey={reloadKey} />}
    </div>
  );
}

function PatternsTab({ reloadKey }: { reloadKey: number }) {
  const [summary, setSummary] = useState<EvidenceSummary | null>(null);
  const [ai, setAi] = useState<AiInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const events = await getEvents();
      const ev = computeEvidence(events);
      if (cancelled) return;
      setSummary(ev);
      try {
        const insight = await getInsights(ev);
        if (!cancelled) setAi(insight);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <>
      <p className="disclaimer">
        Patterns from your own logs — meant to help you spot associations and bring
        better questions to a clinician. Not a diagnosis or medical advice.
      </p>

      {summary && (
        <div className="stat-cards">
          <div className="stat-card">
            <div className="n">{summary.mealCount}</div>
            <div className="l">meals logged</div>
          </div>
          <div className="stat-card">
            <div className="n">{summary.symptomCount}</div>
            <div className="l">symptom check-ins</div>
          </div>
          <div className="stat-card">
            <div className="n">{summary.dayCount}</div>
            <div className="l">days tracked</div>
          </div>
          <div className="stat-card">
            <div className="n" style={{ fontSize: 16 }}>
              {summary.topSymptoms[0]?.label ?? "—"}
            </div>
            <div className="l">most common</div>
          </div>
        </div>
      )}

      {ai?.redFlag && <div className="redflag">⚠️ {ai.redFlag}</div>}

      {loading && <p className="status">Analyzing your patterns…</p>}

      {error && <div className="error-banner">Couldn't generate insights right now.</div>}

      {ai && (
        <div className="insight-block">
          <strong>{ai.headline}</strong>
          {"\n\n"}
          {ai.body}
        </div>
      )}

      {summary && summary.associations.length > 0 && (
        <>
          <p className="section-title" style={{ marginTop: 20 }}>
            Possible associations
          </p>
          <p className="disclaimer" style={{ marginBottom: 10 }}>
            Symptoms logged within {summary.lagWindowHours}h after a meal are linked
            back to it. Count = how often it followed; % = how reliably.
          </p>
          {summary.associations.map((a, i) => (
            <div className="assoc" key={i}>
              <div className="pair">
                {a.trigger} → {a.symptom}
              </div>
              <div className="conf">
                {a.count}× · {Math.round(a.confidence * 100)}%
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
