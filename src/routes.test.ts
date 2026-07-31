// @vitest-environment node
//
// The pure route layer. Node environment on purpose: the module must work with
// no `window` and no `location` at all.
//
// Validates: Requirements 3.4, 4.1, 16.1, 16.4

import { describe, expect, it } from "vitest";
import { APP_VIEWS, DEFAULT_APP_PATH, LOGIN_PATH } from "../shared/site.js";
import { formatRoute, mayEnterApp, parseRoute, sanitizeNext } from "./routes";

describe("parseRoute", () => {
  it("resolves every Addressable_View in the Route_Table", () => {
    for (const view of APP_VIEWS) {
      expect(parseRoute(view.path, "")).toEqual({
        kind: "app",
        tab: view.tab,
        flow: view.flow,
      });
    }
  });

  it("gives settings a URL while keeping its internal representation", () => {
    expect(parseRoute("/app/settings", "")).toEqual({
      kind: "app",
      tab: "logs",
      flow: "settings",
    });
  });

  it("reads the login route with and without a next parameter", () => {
    expect(parseRoute(LOGIN_PATH, "")).toEqual({ kind: "login", next: null });
    expect(parseRoute(LOGIN_PATH, "?next=%2Fapp%2Flogs")).toEqual({
      kind: "login",
      next: "/app/logs",
    });
  });

  it("sanitizes a hostile next parameter as it parses", () => {
    expect(parseRoute(LOGIN_PATH, "?next=https%3A%2F%2Fevil.com")).toEqual({
      kind: "login",
      next: DEFAULT_APP_PATH,
    });
  });

  it("returns null for a path that names no app view", () => {
    for (const path of ["/", "/pricing", "/privacy", "/blog/post", "/apple", "", "/app/nope"]) {
      expect(parseRoute(path, "")).toBeNull();
    }
  });

  it("normalizes a single trailing slash", () => {
    expect(parseRoute("/app/logs/", "")).toEqual(parseRoute("/app/logs", ""));
  });
});

describe("formatRoute", () => {
  it("addresses each view by its Route_Table path", () => {
    for (const view of APP_VIEWS) {
      expect(formatRoute({ kind: "app", tab: view.tab, flow: view.flow })).toBe(view.path);
    }
  });

  it("encodes a next parameter into the login URL", () => {
    expect(formatRoute({ kind: "login", next: null })).toBe(LOGIN_PATH);
    expect(formatRoute({ kind: "login", next: "/app/insights" })).toBe(
      `${LOGIN_PATH}?next=%2Fapp%2Finsights`
    );
  });
});

describe("sanitizeNext", () => {
  it("keeps a known App_Route", () => {
    expect(sanitizeNext("/app")).toBe("/app");
    expect(sanitizeNext("/app/logs")).toBe("/app/logs");
    expect(sanitizeNext("/app/settings")).toBe("/app/settings");
  });

  it("collapses anything that could leave the app to the default", () => {
    for (const raw of [
      null,
      "",
      "//evil.com",
      "https://evil.com",
      "http:/app",
      "/\\evil.com",
      "/app\\evil.com",
      "/app//evil.com",
      "/app/../..",
      "/app/%2f%2fevil.com",
      "%2Fapp",
      "javascript:alert(1)",
      "/pricing",
      "/appstore",
      "/app/logs?x=1",
      "/app/logs#frag",
      "/app/unknown",
      " /app",
    ]) {
      expect(sanitizeNext(raw)).toBe(DEFAULT_APP_PATH);
    }
  });
});

describe("mayEnterApp", () => {
  it("is exactly the session predicate", () => {
    expect(mayEnterApp(true)).toBe(true);
    expect(mayEnterApp(false)).toBe(false);
  });
});
