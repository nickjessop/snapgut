import { useEffect, useState } from "react";
import { getEvents } from "./db";
import { computeEvidence, type EvidenceSummary } from "./insights";
import { getInsights, AuthError, UpgradeRequiredError } from "./api";
import type { Entitlement } from "./session";
import FoodsTab from "./FoodsTab";

type InsightTab = "patterns" | "foods";

interface AiInsight {
  headline: string;
  body: string;
  redFlag?: string;
}

interface Props {
  reloadKey?: number;
  entitlement: Entitlement | null;
  onEntitlement?: (e?: Entitlement) => void;
  onNeedUpgrade?: () => void;
  onSignedOut?: () => void;
}

export default function InsightsView({
  reloadKey = 0,
  entitlement,
  onEntitlement,
  onNeedUpgrade,
  onSignedOut,
}: Props) {
  const [tab, setTab] = useState<InsightTab>("patterns");

  return (
    <div className="insights">
      <div className="insights-header">
        <h1>Insights</h1>
        {entitlement &&
          (entitlement.pro ? (
            <span className="pro-badge" title="SnapGut Pro">
              ✨ PRO
            </span>
          ) : (
            <button
              className="credits-pill"
              onClick={onNeedUpgrade}
              title="Unlock unlimited AI"
            >
              ✨ {Math.max(0, entitlement.freeAiLimit - entitlement.freeAiUsed)} free
            </button>
          ))}
      </div>

      <div className="tabs">
        <button
          className={`tab-btn${tab === "patterns" ? " on" : ""}`}
          onClick={() => setTab("patterns")}
        >
          Patterns
        </button>
        <button
          className={`tab-btn${tab === "foods" ? " on" : ""}`}
          onClick={() => setTab("foods")}
        >
          Foods
        </button>
      </div>

      {tab === "patterns" ? (
        <PatternsTab
          reloadKey={reloadKey}
          entitlement={entitlement}
          onEntitlement={onEntitlement}
          onNeedUpgrade={onNeedUpgrade}
          onSignedOut={onSignedOut}
        />
      ) : (
        <FoodsTab reloadKey={reloadKey} />
      )}
    </div>
  );
}

function PatternsTab({
  reloadKey,
  entitlement,
  onEntitlement,
  onNeedUpgrade,
  onSignedOut,
}: {
  reloadKey: number;
  entitlement: Entitlement | null;
  onEntitlement?: (e?: Entitlement) => void;
  onNeedUpgrade?: () => void;
  onSignedOut?: () => void;
}) {
  const [summary, setSummary] = useState<EvidenceSummary | null>(null);
  const [ai, setAi] = useState<AiInsight | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pro = entitlement?.pro ?? false;
  const freeLeft = entitlement
    ? Math.max(0, entitlement.freeAiLimit - entitlement.freeAiUsed)
    : 0;

  async function generate(ev: EvidenceSummary) {
    setLoading(true);
    setError(null);
    try {
      const insight = await getInsights(ev);
      setAi(insight);
      onEntitlement?.(insight.entitlement);
    } catch (e) {
      if (e instanceof AuthError) onSignedOut?.();
      else if (e instanceof UpgradeRequiredError) onNeedUpgrade?.();
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setAi(null);
    (async () => {
      const events = await getEvents();
      const ev = computeEvidence(events);
      if (cancelled) return;
      setSummary(ev);
      if (pro) generate(ev); // Pro: auto-narrate; free: user taps to reveal
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, pro]);

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

      {/* Free users: reveal the AI narrative on demand (or upgrade when used up) */}
      {!ai && !loading && !pro && summary && (
        <div className="ai-lock">
          <div className="ai-lock-title">✨ AI insight</div>
          {freeLeft > 0 ? (
            <>
              <p className="ai-lock-sub">
                Get an AI read on your patterns. Uses 1 of your {freeLeft} free AI
                {freeLeft === 1 ? " use" : " uses"}.
              </p>
              <button className="primary reveal" onClick={() => generate(summary)}>
                Reveal AI insight
              </button>
            </>
          ) : (
            <>
              <p className="ai-lock-sub">
                You've used your free AI. Unlock unlimited AI insights with Pro.
              </p>
              <button className="primary" onClick={() => onNeedUpgrade?.()}>
                Unlock Pro
              </button>
            </>
          )}
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
