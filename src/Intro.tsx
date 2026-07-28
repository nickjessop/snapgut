import { useEffect, useState } from "react";
import { CameraIcon, SymptomIcon, InsightsIcon, MealIcon, type IconProps } from "./icons";
import type { ComponentType } from "react";

export const ONBOARDED_KEY = "food-snap-onboarded";

interface Slide {
  icon: ComponentType<IconProps>;
  title: string;
  body: string;
}

const SLIDES: Slide[] = [
  {
    icon: CameraIcon,
    title: "Snap your meals",
    body: "Photo-first logging. AI pulls out the ingredients so you never have to type a food diary again.",
  },
  {
    icon: SymptomIcon,
    title: "Log how you feel",
    body: "Symptoms, bowel movements, stress and sleep — all on one simple timeline.",
  },
  {
    icon: InsightsIcon,
    title: "Find your triggers",
    body: "See which foods agree with you and which to avoid — backed by your own data, not guesswork.",
  },
];

/** First-run experience: a branded splash, then a short 3-slide intro. */
export default function Intro({ onFinish }: { onFinish: () => void }) {
  const [phase, setPhase] = useState<"splash" | "slides">("splash");
  const [i, setI] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setPhase("slides"), 1150);
    return () => clearTimeout(t);
  }, []);

  function done() {
    localStorage.setItem(ONBOARDED_KEY, "1");
    onFinish();
  }

  if (phase === "splash") {
    return (
      <div className="app intro splash-screen">
        <div className="intro-badge splash-badge">
          <MealIcon size={54} strokeWidth={1.75} />
        </div>
        <div className="wordmark">SnapGut</div>
        <div className="tagline">Know what your gut is telling you</div>
      </div>
    );
  }

  const slide = SLIDES[i];
  const Icon = slide.icon;
  const last = i === SLIDES.length - 1;

  return (
    <div className="app intro">
      <button className="intro-skip" onClick={done}>
        Skip
      </button>

      <div className="intro-body">
        <div className="intro-badge" key={i}>
          <Icon size={52} strokeWidth={1.75} />
        </div>
        <h1 className="intro-title">{slide.title}</h1>
        <p className="intro-sub">{slide.body}</p>
      </div>

      <div className="intro-footer">
        <div className="intro-dots">
          {SLIDES.map((_, d) => (
            <span key={d} className={`dot${d === i ? " on" : ""}`} />
          ))}
        </div>
        <button className="primary" onClick={() => (last ? done() : setI(i + 1))}>
          {last ? "Get started" : "Next"}
        </button>
      </div>
    </div>
  );
}
