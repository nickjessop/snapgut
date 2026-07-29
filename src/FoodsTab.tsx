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
      <p className="disclaimer">
        How often each food was followed by symptoms within 24h. These are personal
        patterns from your logs, not allergy tests or medical advice.
      </p>

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
