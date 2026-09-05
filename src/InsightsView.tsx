import { useEffect, useState } from "react";
import { getEvents, type LogEvent } from "./db";
import ConfirmOutcomes from "./ConfirmOutcomes";
import { computeEvidence, type EvidenceSummary } from "./insights";
import { getInsights, AuthError } from "./api";
import { isStale, listInsights, recordInsight, type PastInsight } from "./insightHistory";
import TriggerInfoSheet from "./TriggerInfoSheet";
import { groupForLabel } from "./triggerInfo";
import FoodsTab from "./FoodsTab";
import HeaderStats from "./HeaderStats";
import InfoNote from "./InfoNote";
import { InsightsIcon, RefreshIcon } from "./icons";

/** "3 days ago" for a recent insight, a date once that stops being useful. */
function formatWhen(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type InsightTab = "patterns" | "foods";

interface AiInsight {
  headline: string;
  body: string;
  redFlag?: string;
}

interface Props {
  reloadKey?: number;
  /** Whether a session is held. The narrative needs one; the on-device stats
   *  above it do not, which is the whole point of deferring sign-in. */
  authed?: boolean;
  onNeedSignIn?: () => void;
  onSignedOut?: () => void;
}

export default function InsightsView({
  reloadKey = 0,
  authed = true,
  onNeedSignIn,
  onSignedOut,
}: Props) {
  const [tab, setTab] = useState<InsightTab>("patterns");

  return (
    <div className="insights">
      <div className="insights-header">
        <h1>Insights</h1>
        <HeaderStats />
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
          authed={authed}
          onNeedSignIn={onNeedSignIn}
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
  authed = true,
  onNeedSignIn,
  onSignedOut,
}: {
  reloadKey: number;
  authed?: boolean;
  onNeedSignIn?: () => void;
  onSignedOut?: () => void;
}) {
  const [summary, setSummary] = useState<EvidenceSummary | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [outcomeKey, setOutcomeKey] = useState(0);
  const [ai, setAi] = useState<AiInsight | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PastInsight[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [explain, setExplain] = useState<string | null>(null);

  const latest: PastInsight | null = history[0] ?? null;
  const stale = isStale(latest);
  const latestIsFresh = ai !== null || (latest !== null && !stale);
  const older = history.slice(1);

  async function generate(ev: EvidenceSummary) {
    setLoading(true);
    setError(null);
    try {
      const insight = await getInsights(ev);
      setAi(insight);
      setHistory(
        await recordInsight({
          headline: insight.headline,
          body: insight.body,
          redFlag: insight.redFlag,
          mealCount: ev.mealCount,
          dayCount: ev.dayCount,
        })
      );
    } catch (e) {
      if (e instanceof AuthError) onSignedOut?.();
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setAi(null);
    (async () => {
      const [events, stored] = await Promise.all([getEvents(), listInsights()]);
      const ev = computeEvidence(events);
      if (cancelled) return;
      setSummary(ev);
      setEvents(events);
      setHistory(stored);

      // Regenerate when the stored one has gone stale.
      if (authed && isStale(stored[0] ?? null)) generate(ev);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, authed, outcomeKey]);

  return (
    <>
      <InfoNote
        title="How to read these patterns"
        explanation={
          <>
            <p>
              Everything here is computed from the meals and symptoms you logged on
              this device. Nothing is compared against anyone else's data.
            </p>
            <p>
              A pattern means two things happened close together, often enough to be
              worth noticing. It does not mean one caused the other — a food you eat
              every day will show up beside almost anything, and a bad week of sleep
              or stress can drive symptoms on its own.
            </p>
            <p>
              SnapGut is not a medical device, it does not diagnose anything, and it
              is not an allergy or intolerance test. Use it to arrive at an
              appointment with specifics instead of a guess, and talk to a clinician
              before cutting foods out.
            </p>
          </>
        }
      >
        Patterns from your own logs — not a diagnosis or medical advice.
      </InfoNote>

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

      {summary && (
        <ConfirmOutcomes
          key={reloadKey}
          events={events}
          onChanged={() => setOutcomeKey((k) => k + 1)}
        />
      )}

      {latest?.redFlag && <div className="redflag">⚠️ {latest.redFlag}</div>}

      {loading && <p className="status">Analyzing your patterns…</p>}
      {error && <div className="error-banner">Couldn't generate insights right now.</div>}

      {latest && !loading && (
        <div className="insight-block">
          <div className="insight-head">
            <span className="insight-when">
              {latestIsFresh ? "Latest insight" : `From ${formatWhen(latest.at)}`}
              {stale && <span className="insight-stale"> · worth refreshing</span>}
            </span>
            <button
              className="insight-refresh"
              onClick={() => summary && generate(summary)}
              disabled={!summary || loading}
              aria-label="Refresh this insight"
              title="Refresh"
            >
              <RefreshIcon size={15} />
            </button>
          </div>
          <strong>{latest.headline}</strong>
          {"\n\n"}
          {latest.body}
        </div>
      )}

      {/* The offer to generate a first one. */}
      {!latest && !loading && summary && (
        <div className="ai-lock">
          <div className="ai-lock-title">
            <InsightsIcon size={16} />
            AI insight
          </div>
          {!authed ? (
            <>
              <p className="ai-lock-sub">
                Your patterns above are computed here on your device. The written
                read-out runs on our server, so it needs an account — sign in to
                use AI.
              </p>
              <button className="primary" onClick={() => onNeedSignIn?.()}>
                Sign in to use AI
              </button>
            </>
          ) : (
            <>
              <p className="ai-lock-sub">
                Get an AI read on your patterns.
              </p>
              <button className="primary reveal" onClick={() => generate(summary)}>
                Reveal AI insight
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
          <InfoNote
            title="What the numbers mean"
            hint="How these are counted"
            explanation={
              <>
                <p>
                  Each row names a <strong>group of foods</strong> rather than a single
                  one — fructans, lactose, high histamine and so on. Tap a row to see
                  what its group means and which foods we put in it. Grouping is what
                  lets a pattern show up at all: you may never eat the same dish twice,
                  but you eat from the same groups constantly.
                </p>
                <p>
                  A symptom logged within {summary.lagWindowHours} hours of a meal is
                  linked back to that meal. Anything later is left out, because the
                  further apart two entries are the more likely something else
                  explains them.
                </p>
                <p>
                  <strong>Count</strong> is how many meals containing that group were
                  followed by that symptom. <strong>Percent</strong> is how reliably it
                  happened — out of every meal containing something from the group, the
                  share that was followed by the symptom.
                </p>
                <p>
                  A pair has to show up at least twice before it appears here at all.
                  Even so, a high percent on a small count is thin evidence: two meals
                  and two symptoms reads as 100%, and means very little until there are
                  more meals behind it.
                </p>
                <p>
                  A food can also land in a group by mistake. We match on names, so
                  "almond milk" can be read as milk — which is why a row is a place to
                  start looking, not a conclusion.
                </p>
              </>
            }
          >
            Symptoms within {summary.lagWindowHours}h of a meal are linked back to it.
          </InfoNote>
          {summary.associations.map((a, i) => {
            const explainable = groupForLabel(a.trigger) !== null;
            const body = (
              <>
                <div className="pair">
                  {a.trigger} → {a.symptom}
                  {explainable && <span className="assoc-why">What's this?</span>}
                </div>
                <div className="conf">
                  {a.count}× · {Math.round(a.confidence * 100)}%
                </div>
              </>
            );
            return explainable ? (
              <button
                className="assoc assoc-btn"
                key={i}
                onClick={() => setExplain(a.trigger)}
                aria-label={`What is ${a.trigger}?`}
              >
                {body}
              </button>
            ) : (
              <div className="assoc" key={i}>
                {body}
              </div>
            );
          })}
        </>
      )}

      {older.length > 0 && (
        <div className="past-insights">
          <button
            className="past-toggle"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
          >
            <span>Past insights</span>
            <span className="past-count">
              {older.length}
              <span className={`past-caret${historyOpen ? " open" : ""}`} aria-hidden="true" />
            </span>
          </button>

          {historyOpen && (
            <div className="past-list">
              {older.map((p) => (
                <div className="past-item" key={p.at}>
                  <div className="past-date">
                    {new Date(p.at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                    {p.mealCount != null && p.dayCount != null && (
                      <span className="past-meta">
                        {" · "}
                        {p.mealCount} meals over {p.dayCount} days
                      </span>
                    )}
                  </div>
                  <div className="past-headline">{p.headline}</div>
                  <div className="past-body">{p.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {explain && <TriggerInfoSheet label={explain} onClose={() => setExplain(null)} />}
    </>
  );
}
