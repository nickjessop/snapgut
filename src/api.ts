import type { MealAnalysis, Ingredient } from "./db";
import type { EvidenceSummary } from "./insights";
import { authHeaders, clearToken } from "./session";

export class AuthError extends Error {}
export class NoCreditsError extends Error {}

function buildHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders() };
}

function handleAuthStatus(status: number) {
  if (status === 401) {
    clearToken();
    throw new AuthError("Session expired");
  }
  if (status === 402) {
    throw new NoCreditsError("Out of credits");
  }
}

/** Recognize a meal photo. Returns dish + ingredients (+ remaining credits). */
export async function recognizeMeal(
  imageBlob: Blob,
  note?: string
): Promise<MealAnalysis & { credits?: number }> {
  const base64 = await blobToBase64(imageBlob);
  const res = await fetch("/api/recognize", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      image: base64,
      mimeType: imageBlob.type || "image/jpeg",
      note: note || undefined,
    }),
  });

  handleAuthStatus(res.status);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Recognition failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Partial<MealAnalysis> & { credits?: number };
  const ingredients: Ingredient[] = Array.isArray(data.ingredients)
    ? data.ingredients
        .filter((i): i is Ingredient => !!i && typeof i.name === "string")
        .map((i) => ({
          name: i.name,
          confidence: i.confidence === "maybe" ? "maybe" : "confident",
        }))
    : [];
  return { dish: data.dish || "Meal", ingredients, credits: data.credits };
}

/** Send the on-device evidence summary and get back a narrated insight. */
export async function getInsights(
  summary: EvidenceSummary
): Promise<{ headline: string; body: string; redFlag?: string }> {
  const res = await fetch("/api/insights", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ summary }),
  });
  handleAuthStatus(res.status);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Insights failed (${res.status}): ${text}`);
  }
  return res.json();
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
