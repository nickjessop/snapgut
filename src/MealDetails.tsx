import { useEffect, useState } from "react";
import { recognizeMeal, UpgradeRequiredError, AuthError } from "./api";
import WhenPicker from "./WhenPicker";
import OutcomeToggle from "./OutcomeToggle";
import { putEvent, type Ingredient, type MealEvent } from "./db";
import type { Entitlement } from "./session";
import { NoteIcon, AddIcon, InsightsIcon } from "./icons";
import BackButton from "./BackButton";

interface Props {
  /**
   * Absent when the meal is logged without a photo — something already eaten, or
   * a visitor who chose not to take one. With no image there is nothing for AI to
   * read, so the screen opens in manual mode and spends no free AI use.
   */
  photo: Blob | null;
  initialNote?: string;
  editing?: MealEvent;
  /** Decides whether AI recognition is offered. Absent = let the server decide. */
  entitlement?: Entitlement | null;
  /** Whether a session is held. Recognition needs one, so an anonymous visitor
   *  must be offered sign-in rather than have a request fired on their behalf. */
  authed?: boolean;
  onSaved: () => void;
  onBack: () => void;
  onEntitlement?: (e?: Entitlement) => void;
  onNeedUpgrade?: () => void;
  onNeedSignIn?: () => void;
  onSignedOut?: () => void;
  /** Go back and attach a photo after starting a photo-less meal. */
  onAddPhoto?: () => void;
}

/**
 * Screen 2 of the meal flow: AI-derived dish + ingredients. The photo is a small
 * thumbnail at the bottom (tap to enlarge). The context note stays editable, and
 * changing it lets you re-analyze.
 *
 * AI recognition is the part Pro pays for; taking the photo and logging the meal
 * are not. So when the entitlement says there is no AI use left, this screen skips
 * the request entirely rather than firing a doomed one and answering it with an
 * error banner and a paywall — the photo is already taken, and the manual path has
 * to be the thing that is offered.
 */
export default function MealDetails({
  photo,
  initialNote = "",
  editing,
  entitlement,
  authed = true,
  onSaved,
  onBack,
  onEntitlement,
  onNeedUpgrade,
  onNeedSignIn,
  onSignedOut,
  onAddPhoto,
}: Props) {
  // Fail *open* when the entitlement is unknown: the server is the enforcement
  // point either way (it returns 402), and guessing "no AI" from a missing
  // snapshot would withhold a use the user has.
  //
  // A missing *session* is different, and is not a guess. `/api/recognize`
  // answers 401 without one, so firing the request would spend the visitor's
  // first impression on an error and, worse, route them out of the flow through
  // `onSignedOut` — taking the photo with it. So recognition is withheld and
  // sign-in is offered in its place.
  const hasAiQuota = entitlement
    ? entitlement.pro || entitlement.freeAiUsed < entitlement.freeAiLimit
    : true;
  // No photo, no recognition — there is nothing to send. This is not a
  // restriction to explain or an upsell to make, so the screen simply opens in
  // manual mode.
  const canUseAi = authed && hasAiQuota && photo !== null;
  const [photoUrl, setPhotoUrl] = useState("");
  const [dish, setDish] = useState(editing?.dish ?? "");
  const [ingredients, setIngredients] = useState<Ingredient[]>(editing?.ingredients ?? []);
  const [note, setNote] = useState(editing?.note ?? initialNote);
  const [analyzedNote, setAnalyzedNote] = useState(editing?.note ?? initialNote);
  const [analyzing, setAnalyzing] = useState(!editing && canUseAi);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  /**
   * When the meal was eaten. Meals were the one log type that could not be
   * backdated — this screen hardcoded `Date.now()` while the symptom, bowel, and
   * check-in flows all offered `WhenPicker`. That is backwards: a meal is the thing
   * most often logged after the fact, and it is the anchor every correlation
   * measures forward from, so a wrong meal time skews more than a wrong symptom
   * time. Seeded from the existing timestamp when editing.
   */
  const [when, setWhen] = useState<number>(editing?.createdAt ?? Date.now());
  /**
   * Whether the user has said this meal sat fine. Editable from here for the life of
   * the meal, in either direction — the analysis treats "not stated" and "fine" as
   * different things, so being able to get back to "not stated" matters as much as
   * being able to set it.
   */
  const [outcome, setOutcome] = useState<"fine" | undefined>(editing?.outcome);

  // Create the object URL inside an effect so it survives StrictMode's
  // mount/unmount/mount and each instance revokes its own URL.
  useEffect(() => {
    if (!photo) {
      setPhotoUrl("");
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function analyze(withNote: string) {
    if (!photo) return;
    setAnalyzing(true);
    setError(null);
    try {
      const meal = await recognizeMeal(photo, withNote || undefined);
      setDish(meal.dish);
      setIngredients(meal.ingredients);
      setAnalyzedNote(withNote);
      onEntitlement?.(meal.entitlement);
    } catch (e) {
      if (e instanceof UpgradeRequiredError) {
        setError("You've used your free AI — add ingredients manually below, or unlock Pro.");
        onNeedUpgrade?.();
      } else if (e instanceof AuthError) {
        onSignedOut?.();
      } else {
        setError((e as Error).message);
      }
    } finally {
      setAnalyzing(false);
    }
  }

  useEffect(() => {
    if (!editing && canUseAi) analyze(initialNote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confident = ingredients.filter((i) => i.confidence === "confident");
  const maybe = ingredients.filter((i) => i.confidence === "maybe");
  const noteChanged = note.trim() !== analyzedNote.trim();

  const removeIngredient = (name: string) =>
    setIngredients((list) => list.filter((i) => i.name !== name));
  const promote = (name: string) =>
    setIngredients((list) =>
      list.map((i) => (i.name === name ? { ...i, confidence: "confident" } : i))
    );
  function addIngredient() {
    const name = window.prompt("Add an ingredient")?.trim();
    if (name) setIngredients((list) => [...list, { name, confidence: "confident" }]);
  }

  async function save() {
    setSaving(true);
    const event: Omit<MealEvent, "updatedAt"> = {
      id: editing?.id ?? crypto.randomUUID(),
      type: "meal",
      createdAt: when,
      dish: dish || "Meal",
      ingredients,
      note: note.trim() || undefined,
      // Spread rather than assigned, so clearing the answer removes the key instead of
      // leaving it present with an `undefined` value. IndexedDB preserves such a key,
      // and "not stated" should be indistinguishable from a meal logged before this
      // field existed.
      ...(outcome ? { outcome } : {}),
      // `putEvent` replaces the whole record, so a `photo` that is absent here is
      // a `photo` deleted from the store. When editing, fall back to the stored
      // Blob rather than to nothing: this screen can be reached with `photo`
      // already cleared (a reset, a remount, an unreadable Blob), and none of
      // those are a request to discard the image. Saving an edit must never be
      // able to lose a photo the user did not touch.
      photo: photo ?? (editing?.photo || undefined),
    };
    // `putEvent` assigns the Revision_Time and records the id in the Outbox in
    // the same transaction as the content (Req 4.6, 5.2).
    await putEvent(event);
    onSaved();
  }

  return (
    <div className="sheet">
      <div className="log-header">
        <BackButton
          onClick={onBack}
          label={editing ? "Back, without saving these changes" : "Back"}
        />
        <span className="log-title">{editing ? "Edit meal" : "Meal details"}</span>
        <span style={{ width: 40 }} />
      </div>

      {/* Context note (editable) */}
      {editingNote ? (
        <div className="note-editor">
          <textarea
            autoFocus
            className="search"
            rows={2}
            placeholder="Add context…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div style={{ display: "flex", gap: 10 }}>
            <button className="link-btn" onClick={() => setEditingNote(false)}>
              Done
            </button>
            {noteChanged && canUseAi && (
              <button
                className="chip selected"
                onClick={() => {
                  setEditingNote(false);
                  analyze(note.trim());
                }}
              >
                Re-analyze with context
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="note-caption" onClick={() => setEditingNote(true)}>
          {note ? (
            <><NoteIcon size={14} /> {note}</>
          ) : (
            <><AddIcon size={14} /> Add context</>
          )}
        </div>
      )}

      {analyzing ? (
        <p className="status">Analyzing your meal…</p>
      ) : (
        <>
          {/* No AI on a new meal: say so once, here, and leave the screen
              working. Not shown when editing — the ingredients already exist.
              Two different reasons, and they need different offers: an anonymous
              visitor has AI available and only needs an account, so pointing them
              at Pro would ask for money to solve a problem a free sign-in fixes. */}
          {/* With no photo there is nothing to explain — no AI was withheld, there
              was simply no image to read — so neither offer below applies. */}
          {!canUseAi && !editing && photo !== null && (
            <div className="ai-lock">
              <div className="ai-lock-title">
                <InsightsIcon size={16} />
                Ingredients are yours to fill in
              </div>
              {!authed ? (
                <>
                  <p className="ai-lock-sub">
                    Name the dish and add its ingredients below — logging is free and
                    stays on your device. Want the photo read for you? Sign in and
                    your first {entitlement?.freeAiLimit ?? 10} AI reads are free.
                  </p>
                  <button className="primary" onClick={() => onNeedSignIn?.()}>
                    Sign in to use AI
                  </button>
                </>
              ) : (
                <>
                  <p className="ai-lock-sub">
                    You've used your free AI, so this photo wasn't analyzed. Name the
                    dish and add its ingredients below — logging stays free. Pro brings
                    back automatic recognition.
                  </p>
                  <button className="primary" onClick={() => onNeedUpgrade?.()}>
                    Unlock Pro
                  </button>
                </>
              )}
            </div>
          )}

          <input
            className="dish-input"
            value={dish}
            placeholder="Dish name"
            onChange={(e) => setDish(e.target.value)}
          />

          <div>
            <p className="section-title">Ingredients</p>
            <div className="foods">
              {confident.map((i) => (
                <button key={i.name} className="chip selected" onClick={() => removeIngredient(i.name)}>
                  {i.name} <span className="x">×</span>
                </button>
              ))}
              <button className="chip add-food" onClick={addIngredient}>
                + Add
              </button>
            </div>
          </div>

          {/* Shown when editing too, unlike the other flows, which hide it. A meal's
              time is the anchor for every association measured from it, so being
              able to correct one already logged is the point of the control. */}
          <WhenPicker onChange={setWhen} initial={when} />

          {/* Only worth asking about a meal already eaten. On a meal being logged now
              the answer cannot be known yet, and offering it would invite a guess. */}
          {editing && (
            <div>
              <p className="section-title">How it sat</p>
              <OutcomeToggle value={outcome} onChange={setOutcome} />
              <p className="hint">
                A meal that passed without symptoms counts in its ingredients' favour.
                Saying so is stronger evidence than us assuming it from a quiet day —
                and you can change or clear this any time.
              </p>
            </div>
          )}

          {maybe.length > 0 && (
            <div>
              <p className="section-title">Maybe also (tap to confirm)</p>
              <div className="foods">
                {maybe.map((i) => (
                  <button key={i.name} className="chip maybe" onClick={() => promote(i.name)}>
                    {i.name}
                    <span
                      className="x"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeIngredient(i.name);
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="error-banner">
              Couldn't auto-detect the meal. Add ingredients manually.
            </div>
          )}
        </>
      )}

      <div className="spacer" />

      {/* Small photo thumbnail — tap to enlarge. Absent for a photo-less meal. */}
      {photoUrl && (
        <img
          className="mini-photo"
          src={photoUrl}
          alt="Meal"
          onClick={() => setEnlarged(true)}
        />
      )}
      {/* Offered rather than nagged: the meal saves fine without one. */}
      {!photo && !editing && (
        <button className="link-btn" onClick={() => onAddPhoto?.()}>
          Add a photo instead
        </button>
      )}

      <button className="primary" disabled={saving || analyzing} onClick={save}>
        {saving ? "Saving…" : editing ? "Update" : "Save meal"}
      </button>

      {enlarged && (
        <div className="photo-overlay" onClick={() => setEnlarged(false)}>
          <img src={photoUrl} alt="Meal enlarged" />
        </div>
      )}
    </div>
  );
}
