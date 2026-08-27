// Client-side session + auth. Token stored in localStorage, attached to
// API calls as a Bearer header.

const TOKEN_KEY = "snapgut-token";

export interface Me {
  email: string;
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

export async function signIn(password: string): Promise<Me> {
  const data = (await post("/api/auth/signin", { password })) as Me & { token: string };
  setToken(data.token);
  return { email: data.email };
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

/** Delete the server-side account (entitlement). Caller wipes local data + token. */
export function deleteAccount(): Promise<{ ok: boolean }> {
  return post("/api/account/delete");
}
