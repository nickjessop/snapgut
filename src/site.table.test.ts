import { describe, it, expect } from "vitest";
import {
  APP_PREFIX,
  APP_VIEWS,
  DEFAULT_APP_PATH,
  LOGIN_PATH,
  NOT_FOUND_FILE,
  ROOT_PATH,
  isAppPath,
} from "../shared/site.js";

describe("Route_Table", () => {
  it("keeps the root, login, and app path classes distinct", () => {
    // `/` is answered with the App_Shell, but it is not an App_Route: the client
    // router treats it as an alias and canonicalises it to DEFAULT_APP_PATH, and
    // `sanitizeNext` must never accept it as a `next` target.
    expect(isAppPath(ROOT_PATH)).toBe(false);
    expect(isAppPath(LOGIN_PATH)).toBe(false);
    expect(ROOT_PATH).not.toBe(LOGIN_PATH);

    for (const view of APP_VIEWS) {
      expect(isAppPath(view.path)).toBe(true);
      expect(view.path).not.toBe(ROOT_PATH);
      expect(view.path).not.toBe(LOGIN_PATH);
    }
  });

  it("treats only /app and its descendants as app paths", () => {
    expect(isAppPath(APP_PREFIX)).toBe(true);
    expect(isAppPath("/app/anything")).toBe(true);
    expect(isAppPath("/application")).toBe(false);
    expect(isAppPath("/blog/post")).toBe(false);
  });

  it("names every Addressable_View by a unique path under the app prefix", () => {
    const paths = APP_VIEWS.map((v) => v.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.startsWith(APP_PREFIX)).toBe(true);
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

  it("names the default view and the not-found document", () => {
    expect(APP_VIEWS.some((v) => v.path === DEFAULT_APP_PATH)).toBe(true);
    expect(NOT_FOUND_FILE).toBe("404.html");
  });
});
