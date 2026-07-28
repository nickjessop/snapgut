// Client-side session + auth/billing. Token stored in localStorage, attached to
// API calls as a Bearer header. Entitlement = Pro flag + free-AI trial counter.

const TOKEN_KEY = "snapgut-token";

export interface Entitlement {
  pro: boolean;
  proUntil: number | null;
  freeAiUsed: number;
  freeAiLimit: number;
}
export interface Me extends Entitlement {
  email: string;
}
export interface Plan {
  id: string;
  price: number; // cents
  label: string;
  caption: string;
  per: string;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request_failed_${res.status}`);
  return data;
}

export function requestCode(email: string): Promise<{ ok: boolean; dev?: boolean; code?: string }> {
  return post("/api/auth/request", { email });
}

export async function verifyCode(email: string, code: string): Promise<Me> {
  const data = (await post("/api/auth/verify", { email, code })) as Me & { token: string };
  setToken(data.token);
  return data;
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/api/me", { headers: authHeaders() });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

export async function fetchPlans(): Promise<Plan[]> {
  const res = await fetch("/api/billing/plans");
  return res.ok ? res.json() : [];
}

/** Dev: returns { simulated, ...entitlement }. Prod: returns { url } to redirect. */
export function checkout(
  plan: string
): Promise<{ simulated?: boolean; url?: string } & Partial<Entitlement>> {
  return post("/api/billing/checkout", { plan });
}
