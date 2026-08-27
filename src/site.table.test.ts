import { describe, it, expect } from "vitest";
import {
  APP_PREFIX,
  APP_VIEWS,
  DEFAULT_APP_PATH,
  LOGIN_PATH,
  MARKETING_PAGES,
  NOT_FOUND_FILE,
  RESERVED_CONTENT_PREFIX,
  indexablePaths,
  isAppPath,
  isMarketingPath,
  marketingPaths,
} from "../shared/site.js";

describe("Route_Table", () => {
  it("names the v1 page set with a unique path, file, title, and description", () => {
    expect(marketingPaths()).toEqual(["/", "/privacy", "/terms"]);

    const unique = (xs: string[]) => new Set(xs).size === xs.length;
    expect(unique(MARKETING_PAGES.map((p) => p.file))).toBe(true);
    expect(unique(MARKETING_PAGES.map((p) => p.title))).toBe(true);
    expect(unique(MARKETING_PAGES.map((p) => p.description))).toBe(true);
    for (const page of MARKETING_PAGES) {
      expect(page.path.startsWith("/")).toBe(true);
      expect(page.file).toMatch(/^[a-z0-9-]+\.html$/);
      expect(page.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps the marketing, login, and app path classes disjoint", () => {
    for (const path of marketingPaths()) {
      expect(isMarketingPath(path)).toBe(true);
      expect(isAppPath(path)).toBe(false);
    }
    expect(isMarketingPath(LOGIN_PATH)).toBe(false);
    expect(isAppPath(LOGIN_PATH)).toBe(false);

    for (const view of APP_VIEWS) {
      expect(isAppPath(view.path)).toBe(true);
      expect(isMarketingPath(view.path)).toBe(false);
    }
  });

  it("treats only /app and its descendants as app paths", () => {
    expect(isAppPath(APP_PREFIX)).toBe(true);
    expect(isAppPath("/app/anything")).toBe(true);
    expect(isAppPath("/application")).toBe(false);
    expect(isAppPath(RESERVED_CONTENT_PREFIX + "post")).toBe(false);
    expect(isMarketingPath(RESERVED_CONTENT_PREFIX + "post")).toBe(false);
  });

  it("maps /app/settings onto the logs tab plus the settings flow", () => {
    expect(APP_VIEWS.find((v) => v.path === "/app/settings")).toEqual({
      path: "/app/settings",
      tab: "logs",
      flow: "settings",
    });
    expect(APP_VIEWS.filter((v) => v.flow !== null)).toHaveLength(1);
    expect(APP_VIEWS.find((v) => v.path === DEFAULT_APP_PATH)?.tab).toBe("camera");
  });

  it("indexes exactly the marketing paths", () => {
    expect(indexablePaths()).toEqual(marketingPaths());
    expect(NOT_FOUND_FILE).toBe("404.html");
  });
});
