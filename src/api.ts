/** Send a photo to the backend and get back a list of detected food items. */
export async function recognizeFood(imageBlob: Blob): Promise<string[]> {
  const base64 = await blobToBase64(imageBlob);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = import.meta.env.VITE_APP_TOKEN;
  if (token) headers["x-app-token"] = token;

  const res = await fetch("/api/recognize", {
    method: "POST",
    headers,
    body: JSON.stringify({
      image: base64,
      mimeType: imageBlob.type || "image/jpeg",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Recognition failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { foods?: string[] };
  return Array.isArray(data.foods) ? data.foods : [];
}

import type { EvidenceSummary } from "./insights";

/** Send the on-device evidence summary and get back a narrated insight. */
export async function getInsights(
  summary: EvidenceSummary
): Promise<{ headline: string; body: string; redFlag?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = import.meta.env.VITE_APP_TOKEN;
  if (token) headers["x-app-token"] = token;

  const res = await fetch("/api/insights", {
    method: "POST",
    headers,
    body: JSON.stringify({ summary }),
  });
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
      // strip the "data:<mime>;base64," prefix
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
