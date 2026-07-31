import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { initTheme } from "./theme";
import "./styles.css";

initTheme();

// The App_Shell is the only document that registers the Service_Worker. The
// plugin's automatic injection is off (`injectRegister: null` in
// vite.config.ts), because it would put the registration shim into every HTML
// document the build emits, marketing pages included — and those must load
// nothing from the app's output (Requirements 7.7, 11.3).
//
// `autoUpdate` behavior is unchanged: the generated worker takes control
// immediately and this reloads the page once a newer one activates.
registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
