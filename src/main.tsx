import React from "react";
import ReactDOM from "react-dom/client";
import { registerServiceWorker } from "./swUpdate";
import App from "./App";
import { initTheme } from "./theme";
import { startAppHeightSync } from "./appHeight";
import "./styles.css";

initTheme();

// Before first render, so the frame is never laid out at the wrong height and then
// corrected — a visible jump on a cold launch. Runs for the life of the document, so
// the returned teardown is not needed.
startAppHeightSync();

// The App_Shell is the only document that registers the Service_Worker. The
// plugin's automatic injection is off (`injectRegister: null` in
// vite.config.ts), because it would put the registration shim into every HTML
// document the build emits — which includes the standalone `404.html`, and that
// one must load nothing from the app's output (Requirements 7.7, 11.3).
//
// Updates still apply on their own, with no prompt and no approval — but the reload
// waits for a moment when nothing unsaved is open, because a captured photo lives
// only in memory. See src/swUpdate.ts.
registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
