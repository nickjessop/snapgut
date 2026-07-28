// Client-side session + auth/billing API. Token is stored in localStorage and
// attached to API calls as a Bearer header.

const TOKEN_KEY = "snapgut-token";

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

export interface AuthResult {
  token: string;
  email: string;
  credits: number;
}

export function requestCode(email: string): Promise<{ ok: boolean; dev?: boolean; code?: string }> {
  return post("/api/auth/request", { email });
}

export async function verifyCode(email: string, code: string): Promise<AuthResult> {
  const data = (await post("/api/auth/verify", { email, code })) as AuthResult;
  setToken(data.token);
  return data;
}

export async function fetchMe(): Promise<{ email: string; credits: number } | null> {
  const res = await fetch("/api/me", { headers: authHeaders() });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

export interface Pack {
  id: string;
  credits: number;
  price: number;
  label: string;
}
export async function fetchPacks(): Promise<Pack[]> {
  const res = await fetch("/api/billing/packs");
  return res.ok ? res.json() : [];
}

/** Dev: returns { simulated, credits }. Prod: returns { url } to redirect to. */
export function checkout(pack: string): Promise<{ simulated?: boolean; credits?: number; url?: string }> {
  return post("/api/billing/checkout", { pack });
}
