import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getAccessToken,
  revokeToken,
  resetTokenCache,
  resetGisForTests,
} from "./googleSheets";

// Task 9.2 — Integration tests for the GIS token client (mocked GIS).
//
// These exercise the I/O-shell boundary of getAccessToken/revokeToken by mocking
// `google.accounts.oauth2`. They assert:
//   - the drive.file scope is requested (Req 2.1)
//   - interactive consent uses prompt "consent" and caches the token
//   - a cached token is reused within its expiry without a new request (Req 3.1)
//   - silent refresh uses prompt "" and returns a fresh token (Req 3.2)
//   - consent (60s) and silent (30s) timeouts reject when no token arrives
//     (Req 2.8, 3.3)
//   - denial and revoke behavior
//
// Validates: Requirements 2.1, 3.1, 3.2, 3.3

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const CONSENT_TIMEOUT_MS = 60_000;
const SILENT_TOKEN_TIMEOUT_MS = 30_000;

// ---- Mock GIS surface ----
//
// getAccessToken assigns `client.callback` right before calling
// `client.requestAccessToken(...)`, so the requestAccessToken mock drives the
// flow by invoking whatever the current `client.callback` is (via a swappable
// responder). Not calling the callback simulates a timeout.

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type Client = {
  callback: (r: TokenResponse) => void;
  requestAccessToken: ReturnType<typeof vi.fn>;
};

let client: Client;
let savedConfig: { client_id: string; scope: string } | undefined;
let lastPrompt: string | undefined;
let mockOauth2: {
  initTokenClient: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
};

/** How the current test wants requestAccessToken to respond. */
let responder: (c: Client) => void;

/** Responder that grants a token with the given lifetime. */
function grants(accessToken: string, expiresIn: number): (c: Client) => void {
  return (c) => c.callback({ access_token: accessToken, expires_in: expiresIn });
}

/** Responder that denies the request. */
function denies(error = "access_denied"): (c: Client) => void {
  return (c) => c.callback({ error });
}

/** Responder that never invokes the callback (simulates a timeout). */
const neverResponds: (c: Client) => void = () => {
  /* intentionally no callback */
};

beforeEach(() => {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
  resetGisForTests();

  savedConfig = undefined;
  lastPrompt = undefined;
  responder = grants("token-abc", 3600);

  client = {
    callback: () => {},
    requestAccessToken: vi.fn((opts?: { prompt?: string }) => {
      lastPrompt = opts?.prompt;
      responder(client);
    }),
  };

  mockOauth2 = {
    initTokenClient: vi.fn((config: { client_id: string; scope: string }) => {
      savedConfig = config;
      return client;
    }),
    revoke: vi.fn((_token: string, done?: () => void) => done && done()),
  };

  (globalThis as unknown as { google: unknown }).google = {
    accounts: { oauth2: mockOauth2 },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetGisForTests();
  resetTokenCache();
  delete (globalThis as unknown as { google?: unknown }).google;
});

describe("getAccessToken — scope and interactive consent", () => {
  it("requests the drive.file scope (Req 2.1)", async () => {
    await getAccessToken(true);
    expect(mockOauth2.initTokenClient).toHaveBeenCalledTimes(1);
    expect(savedConfig?.scope).toBe(DRIVE_FILE_SCOPE);
  });

  it("uses prompt 'consent' for interactive grants and returns the token", async () => {
    const token = await getAccessToken(true);
    expect(token).toBe("token-abc");
    expect(client.requestAccessToken).toHaveBeenCalledTimes(1);
    expect(lastPrompt).toBe("consent");
  });
});

describe("getAccessToken — token cache", () => {
  it("reuses a cached token within expiry without a new request (Req 3.1)", async () => {
    // Grant a long-lived token interactively.
    const first = await getAccessToken(true);
    expect(first).toBe("token-abc");
    const callsAfterFirst = client.requestAccessToken.mock.calls.length;

    // A subsequent silent call should reuse the cached token (no new request).
    const second = await getAccessToken(false);
    expect(second).toBe("token-abc");
    expect(client.requestAccessToken.mock.calls.length).toBe(callsAfterFirst);
  });

  it("performs a silent refresh with prompt '' when no cached token exists (Req 3.2)", async () => {
    // Fresh module state (resetGisForTests in beforeEach) → no cached token.
    responder = grants("silent-token", 3600);
    const token = await getAccessToken(false);
    expect(token).toBe("silent-token");
    expect(client.requestAccessToken).toHaveBeenCalledTimes(1);
    expect(lastPrompt).toBe("");
  });
});

describe("getAccessToken — timeouts", () => {
  it("rejects after 60s when interactive consent never returns a token (Req 2.8)", async () => {
    vi.useFakeTimers();
    responder = neverResponds;

    const p = getAccessToken(true);
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(CONSENT_TIMEOUT_MS);
    await assertion;
  });

  it("rejects after 30s when a silent refresh never returns a token (Req 3.3)", async () => {
    vi.useFakeTimers();
    responder = neverResponds;

    const p = getAccessToken(false);
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(SILENT_TOKEN_TIMEOUT_MS);
    await assertion;
  });
});

describe("getAccessToken — denial", () => {
  it("rejects when the token callback reports an error", async () => {
    responder = denies("access_denied");
    await expect(getAccessToken(true)).rejects.toThrow();
  });
});

describe("revokeToken", () => {
  it("revokes the cached token and clears it so it is not reused", async () => {
    // Acquire a token first so there is something to revoke.
    await getAccessToken(true);

    await revokeToken();
    expect(mockOauth2.revoke).toHaveBeenCalledTimes(1);
    expect(mockOauth2.revoke.mock.calls[0][0]).toBe("token-abc");

    // Cache cleared: a subsequent silent call must request a new token.
    responder = grants("token-2", 3600);
    const next = await getAccessToken(false);
    expect(next).toBe("token-2");
    expect(client.requestAccessToken).toHaveBeenCalled();
  });

  it("is a no-op when there is no cached token", async () => {
    await revokeToken();
    expect(mockOauth2.revoke).not.toHaveBeenCalled();
  });
});
