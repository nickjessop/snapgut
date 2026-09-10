// @vitest-environment node
//
// Offline behavior of the built Service_Worker.
//
// Validates: Requirements 5.4, 5.5
//
// This runs the real `dist/sw.js` — the worker the build actually ships,
// including its Precache_Manifest and its `NavigationRoute` denylist — inside a
// simulated `ServiceWorkerGlobalScope` (`src/test/serviceWorkerHarness.ts`).
// The worker is installed against a network backed by `dist/`, activated, then
// the network is cut and Navigation_Requests are dispatched at it.
//
// What that proves: the worker's own routing decision for a given navigation,
// taken by Workbox's code rather than by an assertion re-stating the config.
//
// What it does not prove: the browser half of the exchange. A worker that
// declines to respond hands the navigation back to the browser, which then goes
// to the network — that step is the platform's, not the worker's, so here it is
// observed as "the worker called no respondWith". Real-device confirmation of a
// Legacy_Install upgrade stays on the manual checklist.
//
// What changed with the marketing site's removal: `/` used to be on the
// navigation denylist so a fresh landing page was always fetched from the origin.
// It is now the app, so the worker answers it from the precached App_Shell — a
// bare-host launch works offline, which is the point. The two things that must
// stay out of the precache are the food pack (size) and the 404 document (its
// status is the response).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (shared/ is not TypeScript)
import { APP_VIEWS, LOGIN_PATH, NOT_FOUND_FILE, ROOT_PATH } from "../shared/site.js";
// @ts-ignore -- untyped ESM JavaScript (vite/ is not TypeScript)
import { APP_SHELL_DOCUMENT } from "../vite/pwa.js";
import { bootServiceWorker, type ServiceWorkerHarness } from "./test/serviceWorkerHarness";

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");
const swPath = path.join(distDir, "sw.js");

/** Everything the emitted worker's path sets are derived from. */
const CONFIG_SOURCES = ["vite.config.ts", "vite/pwa.js", "shared/site.js"];

/**
 * Build only when the emitted worker is missing or older than the config it is
 * derived from, so the assertions below never run against a stale worker and a
 * normal `npm test` after a build pays nothing.
 */
const buildIfStale = () => {
  const swAge = existsSync(swPath) ? statSync(swPath).mtimeMs : 0;
  const newestSource = Math.max(
    ...CONFIG_SOURCES.map((file) => statSync(path.join(repoRoot, file)).mtimeMs),
  );
  if (swAge > newestSource) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
};

const appRoutes = (APP_VIEWS as readonly { path: string }[]).map((view) => view.path);

let appShell = "";
let offlineWorker: ServiceWorkerHarness;
let onlineWorker: ServiceWorkerHarness;

beforeAll(async () => {
  buildIfStale();
  appShell = readFileSync(path.join(distDir, APP_SHELL_DOCUMENT as string), "utf8");

  // Two controlled clients: one whose device lost the network after install,
  // one still online. The routing decision must not depend on which.
  offlineWorker = await bootServiceWorker(distDir);
  offlineWorker.goOffline();
  onlineWorker = await bootServiceWorker(distDir);
}, 60_000);

describe("the built Service_Worker precaches the App_Shell", () => {
  it("holds the App_Shell after install", () => {
    expect(offlineWorker.precachedUrls()).toContain(`/${APP_SHELL_DOCUMENT}`);
  });

  it("holds no not-found document, whose status is the whole response", () => {
    // Precached, the worker would answer a typo with the 404 body and status 200 —
    // exactly the soft 404 that Requirement 2.5 exists to remove.
    expect(offlineWorker.precachedUrls()).not.toContain(`/${NOT_FOUND_FILE}`);
  });

  it("precaches no food-pack illustration (R5.6)", () => {
    for (const url of offlineWorker.precachedUrls()) {
      expect(url.startsWith("/foods/"), `${url} is in the precache`).toBe(false);
    }
  });
});

describe("a navigation offline resolves to the Navigation_Fallback (R5.5)", () => {
  it.each([
    ROOT_PATH,
    LOGIN_PATH,
    ...appRoutes,
    "/app/logs?filter=today",
    "/app/unknown-subview",
  ])("%s is answered from the precached App_Shell with no network", async (route) => {
    const outcome = await offlineWorker.navigate(route as string);
    expect(outcome.handledByWorker).toBe(true);
    expect(outcome.response?.status).toBe(200);
    expect(outcome.body).toBe(appShell);
  });

  it("answers the bare origin without reaching the network (R5.4)", async () => {
    // The behaviour change: `/` used to be denied so the marketing homepage
    // stayed fresh. It is the app now, so a launch from the bare host works with
    // the network cut.
    const before = offlineWorker.networkLog.length;
    const outcome = await offlineWorker.navigate(ROOT_PATH);
    expect(outcome.body).toBe(appShell);
    expect(offlineWorker.networkLog.slice(before)).toEqual([]);
  });

  it("answers an App_Route without reaching the network", async () => {
    const before = offlineWorker.networkLog.length;
    const outcome = await offlineWorker.navigate("/app/insights");
    expect(outcome.body).toBe(appShell);
    expect(offlineWorker.networkLog.slice(before)).toEqual([]);
  });

  it("answers `/` the same way while online", async () => {
    const outcome = await onlineWorker.navigate(ROOT_PATH);
    expect(outcome.handledByWorker).toBe(true);
    expect(outcome.body).toBe(appShell);
  });
});

describe("the denylist leaves the non-navigation surface to the Origin_Server (R5.2)", () => {
  it.each(["/api/health", "/robots.txt"])(
    "%s is left to the Origin_Server, never answered with the App_Shell",
    async (route) => {
      const outcome = await onlineWorker.navigate(route);
      expect(outcome.handledByWorker).toBe(false);
      expect(outcome.body).not.toBe(appShell);
    },
  );

  it("caches no food-pack entry as a side effect of a navigation", async () => {
    await onlineWorker.navigate(ROOT_PATH);
    for (const url of onlineWorker.precachedUrls()) {
      expect(url.startsWith("/foods/")).toBe(false);
    }
  });
});
