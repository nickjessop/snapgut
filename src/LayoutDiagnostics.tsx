import { useEffect, useState } from "react";

/**
 * The numbers behind how the app is sized, revealed by tapping the build id.
 *
 * This exists because of a bug that could not be reproduced anywhere it could be
 * inspected. An installed iOS app showed a band below the tab bar; an emulator
 * reports a zero safe-area inset, so the condition simply does not occur in a
 * browser. Reasoning about the box model got the fix close but not confirmed, and the
 * next step needed measurements from the device itself.
 *
 * Four things worth reading together, because which one is wrong tells you where the
 * fault is:
 *
 *  - **viewport** against **screen**: if the visual viewport is shorter than the
 *    screen, the web view itself is inset and `viewport-fit=cover` is not applying.
 *  - **insets**: what the platform reports for the notch and home indicator. Zero on
 *    a device that plainly has both means `env()` is not resolving.
 *  - **app**: the rendered height of the app container. Short of the viewport is the
 *    symptom the user sees.
 *  - **tab bottom**: where the tab bar's lower edge actually lands. Equal to the
 *    viewport height means there is no gap, whatever anything else says.
 */
export default function LayoutDiagnostics() {
  const [rows, setRows] = useState<[string, string][]>([]);

  // Paint the markers described in styles.css while this panel is open. Opt-in, so
  // nobody else ever sees them, and removed on unmount.
  useEffect(() => {
    document.documentElement.classList.add("layout-debug");
    return () => document.documentElement.classList.remove("layout-debug");
  }, []);

  useEffect(() => {
    function read() {
      const probe = document.createElement("div");
      // `env()` is only readable through a computed style, so it needs an element.
      probe.style.cssText =
        "position:fixed;top:0;left:0;width:0;height:0;" +
        "padding-top:env(safe-area-inset-top,0px);" +
        "padding-bottom:env(safe-area-inset-bottom,0px);" +
        "padding-left:env(safe-area-inset-left,0px);";
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const insets = {
        top: cs.paddingTop,
        bottom: cs.paddingBottom,
        left: cs.paddingLeft,
      };
      probe.remove();

      const app = document.querySelector(".app")?.getBoundingClientRect();
      const tab = document.querySelector(".tabbar")?.getBoundingClientRect();
      const standalone =
        window.matchMedia?.("(display-mode: standalone)").matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true;

      const measured =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--app-height")
          .trim() || "not set";

      setRows([
        ["viewport", `${window.innerHeight}px (visual ${Math.round(window.visualViewport?.height ?? 0)})`],
        // What src/appHeight.ts wrote. If this matches "viewport" and "app height"
        // matches both, the frame is the full web view and any remaining band is
        // outside the document entirely.
        ["measured --app-height", measured],
        // The decisive comparison. `clientHeight` is the CSS layout viewport, the one
        // `inset: 0`, `100vh`, and `100dvh` all resolve against. If it is short of
        // `innerHeight`, the web view is taller than the box model believes and that
        // difference is the band.
        ["css viewport", `${document.documentElement.clientHeight}px`],
        ["screen", `${window.screen.height}px · dpr ${window.devicePixelRatio}`],
        // The one line that named the bug. A non-zero deficit is screen space the web
        // view was never given, so no CSS can reach it; when it equals the top inset,
        // the status-bar style is what to look at, not the stylesheet.
        [
          "screen − viewport",
          `${window.screen.height - window.innerHeight}px${
            window.screen.height - window.innerHeight > 0 ? " ← unreachable" : ""
          }`,
        ],
        ["safe top / bottom", `${insets.top} / ${insets.bottom}`],
        ["app height", app ? `${Math.round(app.height)}px` : "—"],
        ["app bottom", app ? `${Math.round(app.bottom)}px` : "—"],
        ["tab bar bottom", tab ? `${Math.round(tab.bottom)}px` : "not rendered here"],
        ["doc scroll height", `${document.documentElement.scrollHeight}px`],
        ["standalone", standalone ? "yes" : "no"],
      ]);
    }

    read();
    // Re-read on rotation and on the viewport changes iOS makes as bars come and go.
    window.addEventListener("resize", read);
    window.visualViewport?.addEventListener("resize", read);
    return () => {
      window.removeEventListener("resize", read);
      window.visualViewport?.removeEventListener("resize", read);
    };
  }, []);

  return (
    <div className="diagnostics">
      <div className="diag-title">Layout</div>
      {rows.map(([label, value]) => (
        <div className="diag-row" key={label}>
          <span className="diag-label">{label}</span>
          <span className="diag-value">{value}</span>
        </div>
      ))}
      <p className="diag-note">
        Three markers are now painted at the bottom of the screen. Screenshot the
        bottom edge and the answer is in the colours:
      </p>
      <ul className="diag-legend">
        <li>
          <b style={{ color: "#ffe100" }}>yellow</b> — where the app frame ends
        </li>
        <li>
          <b style={{ color: "#00b8d4" }}>cyan</b> — where the CSS viewport ends
        </li>
        <li>
          <b style={{ color: "#e0e" }}>magenta</b> — anything the app does not cover
        </li>
      </ul>
      <p className="diag-note">
        Magenta showing means the frame is short. Yellow and cyan landing at different
        heights means the web view and the box model disagree. Both at the physical
        bottom edge with no magenta means the layout is right and the space is padding
        inside the app.
      </p>
    </div>
  );
}
