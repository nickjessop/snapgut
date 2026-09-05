import { useEffect, useState } from "react";
import { CloseIcon } from "./icons";
import InstallSteps from "./InstallSteps";
import {
  canInstall,
  isDismissed,
  isIOS,
  promptInstall,
  setDismissed,
  subscribeInstall,
} from "./installPrompt";

/**
 * The Home Screen nudge: a floating bar above the tab bar, on whatever screen the user
 * is on, until they dismiss it once.
 *
 * This replaces a modal sheet that was gated on having saved a couple of logs. The
 * sheet had to be earned because interrupting someone with a dialog needs justifying; a
 * bar that sits quietly above the nav does not, so it shows from the start and simply
 * stays until answered. One dismissal is final and remembered — there is no snooze,
 * because a nudge that comes back is a nudge that gets ignored on purpose. Afterwards
 * the offer lives in Settings, which is where someone who changes their mind will look.
 *
 * Identical on both platforms. Only the action differs: Chromium gets its native
 * prompt, iOS gets the Share-sheet steps, and if the native prompt declines to appear
 * the steps are the fallback rather than a dead button.
 */
export default function InstallToast() {
  const [gone, setGone] = useState(() => isDismissed());
  const [steps, setSteps] = useState(false);
  // Availability arrives asynchronously on Chromium, so this re-reads on notification
  // rather than deciding once at mount.
  const [available, setAvailable] = useState(() => canInstall());

  useEffect(() => subscribeInstall(() => setAvailable(canInstall())), []);

  if (gone || !available) return null;

  function dismiss() {
    setDismissed();
    setGone(true);
  }

  async function add() {
    if (isIOS() || !(await promptInstall())) {
      // Nothing to fire, or the browser refused to show it. Show the manual route
      // instead of leaving a button that appears to do nothing.
      setSteps(true);
      return;
    }
    // Chromium's own dialog is now up and owns the outcome; either answer is an answer.
    dismiss();
  }

  return (
    <>
      <div className="install-toast" role="region" aria-label="Add SnapGut to your Home Screen">
        <div className="install-toast-copy">
          <strong>Add SnapGut to your Home Screen</strong>
          <span>Opens straight to the camera, and keeps your log from being cleared.</span>
        </div>
        <button className="install-toast-add" onClick={add}>
          Add
        </button>
        <button className="install-toast-x" onClick={dismiss} aria-label="Dismiss">
          <CloseIcon size={16} />
        </button>
      </div>

      {steps && <InstallSteps onClose={() => setSteps(false)} onDone={dismiss} />}
    </>
  );
}
