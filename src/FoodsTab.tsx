import { useEffect, useMemo, useState } from "react";
import { getEvents, type LogEvent } from "./db";
import {
  computeFoodScores,
  RANK_META,
  RANK_ORDER,
  type FoodScore,
  type FoodRank,
} from "./foodScores";
import FoodImage from "./FoodImage";
import InfoNote from "./InfoNote";
import { InsightsIcon as SparklesIcon } from "./icons";

export default function FoodsTab({ reloadKey = 0 }: { reloadKey?: number }) {
  const [events, setEvents] = useState<LogEvent[]>([]);

  useEffect(() => {
    getEvents().then(setEvents);
  }, [reloadKey]);

  const scores = useMemo(() => computeFoodScores(events), [events]);
  const grouped = useMemo(() => {
    const map = new Map<FoodRank, FoodScore[]>();
    for (const s of scores) {
      const arr = map.get(s.rank) ?? [];
      arr.push(s);
      map.set(s.rank, arr);
    }
    return map;
  }, [scores]);

  const hasMeals = events.some((e) => e.type === "meal");

  return (
    <div>
      <InfoNote
        title="How foods get ranked"
        explanation={
          <>
            <p>
              A food's rank is how often a symptom followed it within 24 hours,
              compared with how often you get symptoms generally. Eating it a lot
              without trouble moves it up; symptoms clustering after it move it down.
            </p>
            <p>
              Ranks move as you log more. A food you have eaten two or three times
              sits in "not enough data" until there is something to compare, and a
              food marked low confidence is a hint to keep logging, not a verdict.
            </p>
            <p>
              Something you eat with almost every meal may stay unranked however often
              you log it. Judging a food needs meals <em>without</em> it to compare
              against, and a daily staple leaves too few — so it is held back rather
              than blamed for whatever else was on the plate.
            </p>
            <p>
              These are your own patterns, not allergy tests or medical advice.
              SnapGut cannot tell an intolerance apart from a coincidence — a
              clinician can, and this list is what to bring them.
            </p>
          </>
        }
      >
        Ranked by how often symptoms followed each food within 24h — your patterns,
        not an allergy test.
      </InfoNote>

      {!hasMeals ? (
        <div className="empty-state">
          <div className="empty-badge">
            <SparklesIcon size={34} strokeWidth={1.75} />
          </div>
          <h2 className="empty-title">Nothing to rank yet</h2>
          <p className="empty-sub">Log a few meals and symptoms and we'll surface which foods agree with you.</p>
        </div>
      ) : (
        RANK_ORDER.map((rank) => {
          const items = grouped.get(rank);
          if (!items || items.length === 0) return null;
          const meta = RANK_META[rank];
          return (
            <div key={rank} className="rank-group">
              <div className="rank-head">
                <span className="rank-dot" style={{ background: meta.color }} />
                <span className="rank-label">{meta.label}</span>
                <span className="rank-blurb">{meta.blurb}</span>
              </div>
              {items.map((f) => (
                <FoodRow key={f.name} food={f} color={meta.color} />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}

function FoodRow({ food, color }: { food: FoodScore; color: string }) {
  const showRate = food.rank !== "insufficient";
  const elevated = food.rank === "avoid" || food.rank === "reduce";
  /** Exposures with no verdict: window still open, or nobody around to report. */
  const unsettled = food.pending + food.unobserved;
  const liftLabel =
    food.lift === Infinity ? "only follows this" : `${food.lift.toFixed(1)}× your usual`;

  return (
    <div className="food-row">
      <FoodImage name={food.name} canonical={food.canonical} />
      <div className="food-meta">
        <div className="food-name">
          {food.name}
          {showRate && food.confidence === "low" && (
            <span className="conf-tag">low confidence</span>
          )}
        </div>
        <div className="sub">
          Eaten {food.eaten}×
          {showRate && ` · symptoms ${Math.round(food.foodRate * 100)}% of the time`}
          {elevated && ` · ${liftLabel}`}
        </div>
        {/* The evidence in the food's favour, stated rather than left implicit. A
            symptom rate on its own reads as an accusation with no defence: "17%" and
            "17%, from 5 clear meals out of 6" are the same number and different
            claims. `unsettled` is the honest remainder — exposures we are not
            entitled to count either way (see mealOutcome.ts). */}
        {(food.clear > 0 || unsettled > 0) && (
          <div className="food-evidence">
            {food.clear > 0 && (
              <span className="food-clear">
                {food.clear} symptom-free
              </span>
            )}
            {unsettled > 0 && (
              <span className="food-unsettled">
                {unsettled} not yet counted
              </span>
            )}
          </div>
        )}
        {food.topSymptoms.length > 0 && (
          <div className="food-symptoms">{food.topSymptoms.map((s) => s.label).join(", ")}</div>
        )}
      </div>
      {showRate && (
        <div className="food-rate" style={{ color }}>
          {Math.round(food.foodRate * 100)}%
        </div>
      )}
    </div>
  );
}
