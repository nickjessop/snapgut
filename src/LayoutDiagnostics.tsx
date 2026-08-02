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

      setRows([
        ["viewport", `${window.innerHeight}px (visual ${Math.round(window.visualViewport?.height ?? 0)})`],
        ["screen", `${window.screen.height}px · dpr ${window.devicePixelRatio}`],
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
        A gap at the bottom means “tab bar bottom” is less than “viewport”. Send these
        numbers along with a screenshot.
      </p>
    </div>
  );
}
