# Privacy

SnapGut is self-hosted software. Your diary lives on hardware you control — your
computer, your server, your rules. This page spells out exactly what that means.

> This was the `/privacy` page of the marketing site. That site has moved to its
> own repository and `/` now serves the app, so the substance lives here instead.
> It describes the software as it actually behaves; when the behaviour changes,
> this page changes with it.

## The short version

- Your meals, symptoms, and photos live in your browser's own storage on your device.
- The server stores the local account record and any sync data in a SQLite file on your machine.
- AI recognition requests go to a model server you configure — local by default, so nothing leaves your network.
- No cloud analytics, no third-party tracking, no advertising, no cookies beyond a session token.
- You can export everything and delete everything at any time.

## What stays in your browser

The app keeps your timeline in your browser's own on-device database. That is the
source of truth: everything you see in the app is read from there, and every
statistic is calculated there.

- Meals — the dish name, the ingredients and how confident the recognition was, and any note you write.
- Meal photos, as image files. Photos are only ever stored on your device.
- Symptoms and their severities, Bristol stool scores, and stress and sleep check-ins.
- Your session token and your settings.

Deleting the app's data in your browser, or removing the app from your device,
removes all of it. Browser storage can be evicted when a device runs short of
space, so keep a backup wherever you like — the export below is how.

## What the server stores

Your server — the one you run on your own hardware — stores data in a single
SQLite file. That file contains:

- **The local account record.** One row: an identifying email address and the
  timestamp it was first written. The address is not something anyone types into
  the app — it is the `AUTH_EMAIL` value in the operator's own configuration,
  defaulting to `admin@localhost`, and it exists so sync data has a key to hang
  off. Sign-in is a single shared password (`AUTH_PASSWORD`), so there is one
  local credential rather than a directory of user accounts.
- **Sync data.** If you turn on cloud sync between devices, your meal entries and
  symptom entries are stored so other devices can pull them, along with a small
  bookkeeping row (a sequence number and a sweep timestamp). Photos are not
  included and stay on-device.
- **Rate-limit counters.** Short-lived entries that make brute-force attempts
  expensive. They expire automatically.
- **Missing-illustration counters.** When the food pack has no picture for an
  ingredient, the server increments a count against that ingredient's name so
  the pack can be improved. It is a food name and a number — no meal, no note,
  no photo, and nothing that identifies who logged it.

The session token is held in your browser's storage until it expires. No data
leaves the SQLite file unless you configure sync to another device.

## What is transmitted to recognise a meal

This is the one place data may leave your machine, so it is worth being precise
about.

When you snap a meal, the photo is sent from your browser to your server, which
passes it to the configured AI provider to identify the dish and its ingredients.
By default that provider is a local model server running on the same machine or
local network — so the photo stays within hardware you control.

If you configure a remote AI provider (such as OpenAI or Gemini), the photo is
sent to that provider's API. In every case, the photo is not stored on the server
and is not written to any log file.

The AI insight feature works from a summary your device calculates first — counts
and associations, not your raw entries. Your notes and photos are not sent to
generate an insight.

Everything else the app does, including all of the pattern analysis and the food
ranking, runs in your browser and needs no network at all.

## Cloud sync between your devices

The default is local-only: no sync, no copies, nothing to opt out of. You can
turn on sync in Settings to keep two devices in step.

When sync is on, your entries — meals and ingredients, symptoms and severities,
Bristol scores, stress and sleep values, and any note text — travel through your
own server so they can reach your other devices. Meal photos are not synced and
stay on-device. The app shows you this before the first upload and will not start
syncing without your acknowledgement.

## Exporting everything

Export needs no network and is always available. From Settings:

- **Backup** writes a single JSON file with your whole timeline, photos included,
  which you can save wherever you keep files. The same screen restores from one.
- **Export as CSV** writes a spreadsheet of your timeline: date and time, entry
  type, dish, confident and possible ingredients, symptoms, Bristol score,
  stress, sleep, and your note.

## Deleting everything

Three things can be deleted, and you control each of them directly:

- **The server-side sync copy.** Settings has a *Delete cloud copy* control that
  erases everything the server holds from your sync data. Your on-device log is
  untouched.
- **The account.** Deleting the account removes the sync data first and then the
  account record itself.
- **The data on your device.** Delete individual entries in the app, or clear the
  site's data in your browser to remove the whole local store, photos and all.

## Who else is involved

With the default configuration — a local AI model server — nobody else is
involved. Your data stays on your hardware.

If you configure a remote AI provider, that provider receives meal photos for
recognition and summary text for insights. No other data is sent to any third
party.

The app loads no third-party scripts, embeds nothing from another domain, and
sets no tracking cookies. There is no analytics product, no advertising network,
and no SDK collecting anything in the background.

## Related

- [Terms](terms.md) — what the app does and does not claim, and your
  responsibilities as the operator.
- [Configuration](configuration.md) — every environment variable, including the
  AI provider and the authentication credential named above.
- [Cloud sync](cloud-sync.md) — what travels, when, and how deletion works.
- [Datastore](datastore.md) — the SQLite schema behind "what the server stores".
