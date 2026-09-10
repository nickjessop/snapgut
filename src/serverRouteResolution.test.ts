// @vitest-environment node
//
// Sanity checks on the Origin_Server's route resolver: one outcome per path
// class from the design's resolution table.
//
// The exhaustive route and header suite (including the end-to-end drive through
// `app.fetch`) lives in `src/serverRoutes.test.ts`; this file covers the resolver
// as a pure function.
//
// _Requirements: 2.3, 2.4, 2.5, 2.6_

import { describe, expect, it } from "vitest";
// @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
import { OUTCOME, redirectTargetFor, resolveRoute } from "../server/routes.js";
import { LOGIN_PATH, ROOT_PATH } from "../shared/site.js";

/** A Build_Output stand-in: exactly one real file, so no fs access is needed. */
const fileExists = (p: string) => p === "/assets/app-abc123.js";
const resolve = (p: string) => resolveRoute(p, { fileExists });

describe("server route resolution", () => {
  it("answers the origin root, the Login_Route, and every App_Route with the one App_Shell", () => {
    const shells = [ROOT_PATH, LOGIN_PATH, "/app", "/app/logs", "/app/insights/deep/link"].map(
      resolve
    );
    for (const outcome of shells) {
      expect(outcome.kind).toBe(OUTCOME.APP_SHELL);
      expect(outcome.status).toBe(200);
    }
    expect(new Set(shells.map((o) => o.file)).size).toBe(1);
  });

  it("answers a real Build_Output file with the static outcome", () => {
    expect(resolve("/assets/app-abc123.js").kind).toBe(OUTCOME.STATIC);
  });

  it("answers an unknown path with the not-found document, never the App_Shell", () => {
    for (const path of ["/nope", "/blog/first-post", "/privacy", "/terms", "/sitemap.xml", "/api/does-not-exist"]) {
      const outcome = resolve(path);
      expect(outcome.kind).toBe(OUTCOME.NOT_FOUND);
      expect(outcome.status).toBe(404);
    }
  });

  it("301s a trailing slash on the Login_Route, the only path that redirects", () => {
    const outcome = resolve(`${LOGIN_PATH}/`);
    expect(outcome.kind).toBe(OUTCOME.REDIRECT);
    expect(outcome.status).toBe(301);
    expect(outcome.location).toBe(LOGIN_PATH);
  });

  it("leaves the root and unknown trailing slashes alone", () => {
    // `/` is the app, not a redirect — a 301 to `/app` could not be served
    // offline by the Service_Worker. `/nonsense/` is a single 404 rather than a
    // 301 to another 404 (Requirement 2.5).
    expect(redirectTargetFor(ROOT_PATH)).toBeNull();
    expect(resolve(ROOT_PATH).kind).toBe(OUTCOME.APP_SHELL);
    expect(resolve("/nonsense/").kind).toBe(OUTCOME.NOT_FOUND);
    // An App_Route with a trailing slash keeps its 200.
    expect(resolve("/app/").kind).toBe(OUTCOME.APP_SHELL);
  });
});
