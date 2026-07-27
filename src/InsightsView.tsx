import { useEffect, useState } from "react";
import { getEntries } from "./db";
import { computeEvidence, type EvidenceSummary } from "./insights";
import { getInsights } from "./api";

interface AiInsight {
  headline: string;
  body: string;
  redFlag?: string;
}

export default function InsightsView() {
  const [summary, setSummary] = useState<EvidenceSummary | null>(null);
  const [ai, setAi] = useState<AiInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await getEntries();
      const ev = computeEvidence(entries);
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
  }, []);

  return (
    <div className="insights">
      <h1>Insights</h1>
      <p className="disclaimer">
        Patterns from your own logs — meant to help you spot associations and bring
        better questions to a clinician. Not a diagnosis or medical advice.
      </p>

      {summary && (
        <div className="stat-cards">
          <div className="stat-card">
            <div className="n">{summary.entryCount}</div>
            <div className="l">meals logged</div>
          </div>
          <div className="stat-card">
            <div className="n">{summary.dayCount}</div>
            <div className="l">days tracked</div>
          </div>
          <div className="stat-card">
            <div className="n">{summary.symptomEntryCount}</div>
            <div className="l">with symptoms</div>
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

      {error && (
        <div className="error-banner">Couldn't generate insights right now.</div>
      )}

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
    </div>
  );
}
