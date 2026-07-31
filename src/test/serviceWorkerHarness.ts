/**
 * Runs the real generated Service_Worker (`dist/sw.js`) inside a simulated
 * `ServiceWorkerGlobalScope`, so a test can install it, activate it, cut the
 * network, and dispatch navigation fetch events at it.
 *
 * The point is that nothing here re-implements Workbox's routing. The worker
 * bundle the build emits — its Precache_Manifest, its `NavigationRoute`, its
 * denylist — is the code under test. This harness only supplies the pieces of
 * the platform Workbox reaches for: `caches`, `fetch`, `clients`,
 * `registration`, and the event plumbing.
 *
 * What it does not simulate: the browser's own decision to go to the network
 * when a worker declines to respond. A worker that calls no `respondWith` for a
 * navigation is the observable signal that the request falls through to the
 * Origin_Server, which is what Requirement 5.4 asks for.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/** Where the worker believes it lives. Scope `/`, matching the built config. */
const ORIGIN = "http://localhost:8080";
const SCOPE = `${ORIGIN}/`;

export const swOrigin = ORIGIN;

/** A single cache, keyed by absolute request URL. */
class FakeCache {
  readonly entries = new Map<string, Response>();

  private key(request: Request | string): string {
    return typeof request === "string" ? new URL(request, SCOPE).href : request.url;
  }

  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(this.key(request), response);
  }

  async match(request: Request | string): Promise<Response | undefined> {
    const hit = this.entries.get(this.key(request));
    return hit ? hit.clone() : undefined;
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async delete(request: Request | string): Promise<boolean> {
    return this.entries.delete(this.key(request));
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }

  async match(
    request: Request | string,
    options?: { cacheName?: string },
  ): Promise<Response | undefined> {
    const names = options?.cacheName ? [options.cacheName] : [...this.caches.keys()];
    for (const name of names) {
      const hit = await this.caches.get(name)?.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** The `install` / `activate` event shape: just `waitUntil`. */
class HarnessExtendableEvent {
  readonly pending: Promise<unknown>[] = [];
  constructor(readonly type: string) {}
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }
}

/**
 * The `fetch` event. Named `FetchEvent` inside the sandbox because Workbox
 * narrows a navigation preload check with `event instanceof FetchEvent`.
 */
class HarnessFetchEvent {
  readonly type = "fetch";
  readonly pending: Promise<unknown>[] = [];
  responded: Promise<Response> | null = null;
  readonly preloadResponse = undefined;

  constructor(readonly request: Request) {}

  respondWith(response: Promise<Response> | Response): void {
    this.responded = Promise.resolve(response);
  }

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }
}

/**
 * A Navigation_Request. Built by hand rather than with `new Request(…)` because
 * `mode: "navigate"` is not settable through the constructor, and `mode` is
 * exactly what Workbox's `NavigationRoute` matches on.
 */
function navigationRequest(path: string): Request {
  const url = new URL(path, SCOPE).href;
  return {
    url,
    method: "GET",
    mode: "navigate",
    destination: "document",
    headers: new Headers({ accept: "text/html" }),
    clone() {
      return this;
    },
  } as unknown as Request;
}

/** `Request`, but relative URLs resolve against the worker's scope. */
class ScopedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, SCOPE).href : input, init);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  json: "application/json",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
};

export type NavigationOutcome = {
  /** Did the worker answer the navigation itself? */
  handledByWorker: boolean;
  /** The worker's response, where it answered. */
  response: Response | null;
  /** The body it answered with, where it answered. */
  body: string | null;
};

export type ServiceWorkerHarness = {
  /** Cut the network: every subsequent `fetch` in the worker rejects. */
  goOffline: () => void;
  /** The Precache_Manifest as URLs, read out of the populated precache. */
  precachedUrls: () => string[];
  /** Dispatch a Navigation_Request at the worker and report what it did. */
  navigate: (path: string) => Promise<NavigationOutcome>;
  /** Requests the worker sent to the network, in order. */
  networkLog: string[];
};

/**
 * Boot the built worker: load `dist/sw.js`, run its `install` and `activate`
 * handlers against a network backed by `dist/`, and hand back a controlled
 * client's-eye view of it.
 */
export async function bootServiceWorker(distDir: string): Promise<ServiceWorkerHarness> {
  const swSource = readFileSync(join(distDir, "sw.js"), "utf8");

  let offline = false;
  const networkLog: string[] = [];
  const cacheStorage = new FakeCacheStorage();

  const listeners = new Map<string, ((event: unknown) => void)[]>();

  const harnessFetch = async (input: Request | string): Promise<Response> => {
    const raw = typeof input === "string" ? input : input.url;
    const url = new URL(raw, SCOPE);
    networkLog.push(url.pathname);
    if (offline) throw new TypeError("Failed to fetch");
    // The precache cache key carries ?__WB_REVISION__; the file on disk does not.
    const file = join(distDir, decodeURIComponent(url.pathname).replace(/^\//, ""));
    try {
      const body = readFileSync(file);
      const ext = url.pathname.split(".").pop() ?? "";
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };

  const sandbox: Record<string, unknown> = {
    location: new URL(`${SCOPE}sw.js`),
    registration: { scope: SCOPE, waiting: null, active: null },
    clients: { claim: async () => undefined, matchAll: async () => [] },
    caches: cacheStorage,
    fetch: harnessFetch,
    skipWaiting: async () => undefined,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    removeEventListener: () => undefined,
    // A worker resolves a relative request URL against its own location;
    // Node's `Request` requires an absolute one. Workbox constructs
    // `new Request("/app/index.html")` when it binds the Navigation_Fallback
    // handler, so the base has to be supplied here.
    Request: ScopedRequest,
    Response,
    Headers,
    URL,
    URLSearchParams,
    AbortController,
    TextEncoder,
    TextDecoder,
    FetchEvent: HarnessFetchEvent,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    performance,
    // The worker is an AMD bundle that pulls in the Workbox chunk by URL.
    importScripts: (...urls: string[]) => {
      for (const url of urls) {
        const file = join(distDir, new URL(url, SCOPE).pathname.replace(/^\//, ""));
        vm.runInContext(readFileSync(file, "utf8"), context, { filename: url });
      }
    },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext("globalThis.self = globalThis;", context);
  vm.runInContext(swSource, context, { filename: `${SCOPE}sw.js` });

  // The AMD shim resolves the Workbox chunk through a promise, so the worker's
  // listeners are not registered synchronously.
  for (let i = 0; i < 50 && !listeners.has("fetch"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!listeners.has("fetch")) {
    throw new Error("the built service worker registered no fetch listener");
  }

  const dispatchLifecycle = async (type: "install" | "activate") => {
    const event = new HarnessExtendableEvent(type);
    for (const listener of listeners.get(type) ?? []) listener(event);
    await Promise.all(event.pending);
  };

  await dispatchLifecycle("install");
  await dispatchLifecycle("activate");

  const precacheName = [...cacheStorage.caches.keys()].find((name) =>
    name.includes("precache"),
  );
  if (!precacheName) throw new Error("the built service worker precached nothing");
  const precache = cacheStorage.caches.get(precacheName)!;

  return {
    goOffline: () => {
      offline = true;
    },
    precachedUrls: () =>
      [...precache.entries.keys()].map((url) => new URL(url).pathname),
    networkLog,
    navigate: async (path: string) => {
      const event = new HarnessFetchEvent(navigationRequest(path));
      for (const listener of listeners.get("fetch") ?? []) listener(event);
      if (!event.responded) return { handledByWorker: false, response: null, body: null };
      const response = await event.responded;
      return { handledByWorker: true, response, body: await response.text() };
    },
  };
}
