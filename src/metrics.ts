/**
 * The two funnel events the Origin_Server cannot see for itself.
 *
 * Everything else worth counting is already a request: a page load, an
 * `/api/auth/*` call, a recognition, an insight. Logging is the exception — it
 * writes to IndexedDB and never reaches the network — and it is the one number
 * that matters once sign-in is deferred, because "did an anonymous visitor
 * actually log something" is the whole question.
 *
 * What is sent: a single event name from the allowlist below. No identifier, no
 * session token, no timestamp, no log content, no food name, no symptom. The
 * server keeps a per-day count per name and nothing else, so a tick cannot be
 * attributed to a person, a device, or a session, and two ticks cannot be known
 * to have come from the same visitor.
 *
 * What that costs: the counts are aggregate, so they support a funnel
 * (visits → first log → sign-up) and cannot support cohort retention for
 * anonymous users. Retention is measured only for accounts, from `lastSeenAt` on
 * the user record, because an account is already an identity. Measuring
 * anonymous retention would need a per-device id, which is exactly the thing
 * this module refuses to create.
 */

import { APP_BUILD } from "./build";

/** The only event names the client will send, mirrored by the server's guard. */
const EVENTS = ["first_log", "log_saved"] as const;

export type MetricEvent = (typeof EVENTS)[number];

/** Set once a device has reported its first log, so `first_log` fires at most once. */
const FIRST_LOG_KEY = "snapgut-first-log-counted";

/**
 * Fire-and-forget. A counter must never fail a save, delay one, or surface an
 * error, so every failure path is swallowed: offline, blocked, private mode, and
 * a server that answers 500 all look the same from here.
 */
export function countEvent(event: MetricEvent): void {
  try {
    void fetch("/api/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `build` is the running build id — not an identifier. It is shared by every
      // client on the same deploy, so it cannot single anyone out, and it is what
      // makes "did that release change the funnel" answerable. The server keeps it
      // as a dimension on the daily count, never as a row.
      body: JSON.stringify({ event, build: APP_BUILD }),
      // The tick outlives the page when a log is the last thing a visitor does.
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let a counter break a log */
  }
}

/**
 * A log was saved. Also reports `first_log` the first time this device saves
 * anything, which is the conversion the deferred sign-in change exists to
 * create.
 *
 * The "have I already reported" flag is a local boolean and is never sent, so it
 * marks nothing about the device that leaves it.
 */
export function countLogSaved(): void {
  countEvent("log_saved");
  try {
    if (localStorage.getItem(FIRST_LOG_KEY) === "1") return;
    localStorage.setItem(FIRST_LOG_KEY, "1");
  } catch {
    // Storage unavailable (private mode, quota). Report the first log anyway —
    // over-counting a first log is a smaller error than never seeing one.
  }
  countEvent("first_log");
}
