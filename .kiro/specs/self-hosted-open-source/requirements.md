# Requirements Document

## Introduction

This feature converts the existing hosted SaaS (a food and symptom diary PWA running on GCP Cloud Run, with Stripe billing, Firestore, Vertex AI, GCS, and Resend) into a self-hostable open-source project that runs on one ordinary computer.

The target experience: clone the repo, copy `.env.example`, run one command, open a port on the local machine, and optionally reach it from a phone through a tunnel the user sets up themselves. No paid accounts, no cloud project, no API keys required for the default configuration. The AI features run against a local model server by default, so a stock install sends nothing off the machine.

Six things change, in sequence, each leaving the test suite green:

1. Billing is removed and every previously-gated feature is unconditionally available.
2. A persistent local datastore backend replaces the hosted database, with the in-memory backend retained for tests.
3. The AI provider becomes pluggable, defaulting to a local model server.
4. The food illustration pack is served from a local directory instead of a private cloud bucket.
5. Authentication collapses to a single locally-configured account, with the session secret generated on first run.
6. The project is packaged for container-based self-hosting, the cloud infrastructure code is removed, and the documentation and legal pages are rewritten for a self-host audience.

Cross-cutting concerns are treated as first-class requirements: the security posture of a personal health diary that may be reachable from the internet, the access model (LAN plaintext versus tunnelled HTTPS, and the camera behaviour that follows from it), the first-run experience, no-regression of the features that survive, and the correctness properties worth verifying by property-based testing.

Out of scope: multi-user hosting, bundled or managed tunnels, a hosted offering, and any migration path for data from the existing hosted deployment.

## Glossary

- **Origin_Server**: The Node process started from `server/index.js` that serves all HTTP routes — API, App_Shell, Marketing_Pages, and the Food_Pack.
- **Route_Table**: The path definitions in `shared/site.js` from which the Origin_Server, the client router, the service-worker configuration, the multi-page build inputs, and the sitemap all derive their path sets.
- **App_Shell**: The single React document served for every App_Route (`/app`, `/app/logs`, `/app/insights`, `/app/settings`).
- **App_Route**: A path served by the App_Shell: `/app` and anything beneath it.
- **Marketing_Page**: A statically built document registered in the Route_Table's marketing page set.
- **Datastore_Backend**: An implementation of the `server/store.js` method surface, selected at boot by the `DATASTORE_BACKEND` setting. After the conversion that surface is `getUser`, `upsertUser`, `deleteUser`, `rateLimit`, `recordMissingFood`, and `listMissingFoods`; the sign-in code methods (`getCode`, `setCode`, `clearCode`) exist until Requirement 6 removes them, and the counter methods (`incMetric`, `listMetrics`, `touchUser`, `userStats`) exist until Requirement 11 removes them.
- **Event_Store_Backend**: An implementation of the `server/eventStore.js` method surface (`push`, `pull`, `deleteAll`, `countFor`, `getMeta`), selected by the same setting as the Datastore_Backend.
- **Memory_Backend**: The in-process Datastore_Backend and Event_Store_Backend that hold state in JavaScript maps and lose it on process exit.
- **SQLite_Backend**: The new Datastore_Backend and Event_Store_Backend that persist state to a single SQLite database file at the path given by `DB_PATH`.
- **Event_Record**: A cloud-sync record, or its tombstone, stored per account by the Event_Store_Backend.
- **AI_Provider**: A pluggable adapter that accepts a text prompt plus optional inline image data and returns model output, selected at boot by `AI_PROVIDER`.
- **Local_AI_Provider**: The AI_Provider that talks to a model server running on the host or the local network, and is the default.
- **Mock_AI_Provider**: The AI_Provider that returns fixed synthetic output with no network call.
- **Food_Pack**: The set of 3,036 WebP food illustration files, distributed as a release archive rather than committed to the repository.
- **Food_Pack_Directory**: The local directory the Origin_Server reads Food_Pack files from, given by `FOOD_PACK_DIR`.
- **Food_Pack_Fetch_Script**: The repository script that downloads and extracts the Food_Pack into the Food_Pack_Directory.
- **Auth_Service**: The code in `server/auth.js` that mints and verifies a stateless HMAC-SHA256 Session_Token.
- **Session_Token**: The signed bearer credential the Auth_Service issues, valid for 30 days.
- **Session_Secret**: The HMAC key the Auth_Service signs Session_Tokens with, read from `SESSION_SECRET`.
- **Local_Credential**: The single secret an operator configures to sign in, read from `AUTH_PASSWORD`.
- **Setup_Bootstrap**: The first-run routine that generates and persists a Session_Secret when none is configured.
- **Bind_Host**: The network interface the Origin_Server listens on, given by `BIND_HOST` and defaulting to `127.0.0.1`.
- **Loopback_Bind**: A Bind_Host value of `127.0.0.1`, `::1`, or `localhost`.
- **Exposed_Bind**: Any Bind_Host value that is not a Loopback_Bind.
- **Tunnel**: An operator-provided HTTPS reverse proxy or overlay network (for example Tailscale or cloudflared) that fronts the Origin_Server. Not supplied, configured, or managed by this project.
- **Deployment_Bundle**: The `Dockerfile`, `docker-compose.yml`, and `.env.example` that constitute the supported self-host deployment.
- **Quickstart**: The README section that takes an operator from a fresh clone to a working install.
- **Diary_Features**: Meal logging, symptom logging, on-device statistics, food ranking, insights, export, and cloud sync — the feature set that survives the conversion.
- **Cloud_Sync**: The push/pull protocol in `server/sync.js` and `src/cloudSync.ts` that replicates the client's IndexedDB source of truth through the Event_Store_Backend.
- **Service_Worker**: The generated worker script that provides installability and offline caching for the App_Shell.
- **Test_Suite**: The vitest suite invoked by the repository's test script.
- **Repository**: The version-controlled contents of the open-source project, including its dependency manifest.
- **README**: The top-level `README.md` file.
- **Documentation**: The README together with the files under `docs/`.

## Requirements

### Requirement 1: Remove Billing and Ungate Every Feature

**User Story:** As a self-hoster, I want every feature available without payment, so that running the project on my own hardware needs no payment processor account.

#### Acceptance Criteria

1. WHEN a client requests any path beginning with `/api/billing/`, THE Origin_Server SHALL respond with the not-found outcome defined for unregistered paths.
2. THE Route_Table SHALL contain no entry whose response grants, revokes, or reports a paid entitlement.
3. WHEN the Origin_Server process starts with no payment-processor configuration value present in the environment, THE Origin_Server SHALL reach its ready state and serve a request on every registered route within 60 seconds of process start, emitting no warning or error that references a missing payment-processor configuration value.
4. WHEN a signed-in account calls `POST /api/recognize` with a valid request body at least 100 consecutive times, THE Origin_Server SHALL perform recognition on each of those calls and SHALL omit the `entitlement` field from each of those responses.
5. WHEN a signed-in account calls `POST /api/insights` with a valid request body at least 100 consecutive times, THE Origin_Server SHALL generate insights on each of those calls and SHALL omit the `entitlement` field from each of those responses.
6. WHEN a signed-in account calls `POST /api/recognize`, `POST /api/insights`, or any path beginning with `/api/sync/`, THE Origin_Server SHALL respond with a status code other than 402.
7. THE Origin_Server SHALL omit any entitlement field from every Cloud_Sync push, pull, and delete response, including responses that report an error.
8. THE Datastore_Backend SHALL persist no per-account field recording paid status, paid expiry, complimentary status, payment-processor customer identity, or free-usage count.
9. THE App_Shell SHALL render no upgrade prompt, plan chooser, remaining-quota indicator, or billing-management control.
10. THE Route_Table SHALL contain no pricing page entry, and THE Origin_Server SHALL respond to `/pricing` with the not-found outcome defined for unregistered paths.
11. THE Repository SHALL contain no payment-processor client dependency, plan catalog module, or payment-processor setup script.
12. THE `/terms` Marketing_Page SHALL describe self-hosted use without reference to billing, subscription renewal, or cancellation.
13. THE Test_Suite SHALL complete with zero failing tests, zero skipped tests covering billing, plan, entitlement, or quota behaviour, and no remaining test that asserts billing, plan, entitlement, or quota behaviour.
14. WHEN a signed-in account calls any path beginning with `/api/sync/`, including `DELETE /api/sync/data`, THE Origin_Server SHALL perform the requested sync operation without evaluating any paid, complimentary, or usage-count value, and `DELETE /api/sync/data` SHALL remove that account's stored snapshot so that a subsequent pull reports no stored snapshot.
15. IF a request to `POST /api/recognize`, `POST /api/insights`, or any path beginning with `/api/sync/` carries a body that fails validation or exceeds the accepted request size limit, THEN THE Origin_Server SHALL reject the request with the validation rejection outcome already defined for that route, SHALL return an error identifier that references neither payment, plan, entitlement, nor quota, and SHALL leave stored account data unchanged.
16. WHILE an account is signed in, THE App_Shell SHALL keep every Diary_Feature usable without reading any entitlement, plan, or quota field from any Origin_Server response.

### Requirement 2: Persistent Local Datastore Backend

**User Story:** As a self-hoster, I want my account and sync data stored in a local database file, so that restarting the container does not erase my history.

#### Acceptance Criteria

1. THE Origin_Server SHALL select both the Datastore_Backend implementation and the Event_Store_Backend implementation from the single `DATASTORE_BACKEND` value, accepting a value that names the SQLite_Backend and a value that names the Memory_Backend.
2. THE SQLite_Backend SHALL implement every method of the Datastore_Backend surface and every method of the Event_Store_Backend surface with the same call signature and return shape as the Memory_Backend, SHALL apply each `push` call and each `deleteAll` call as one all-or-nothing unit that leaves the stored state unchanged if it does not complete, and SHALL surface a failed write to its caller as an error rather than as a successful result.
3. THE SQLite_Backend SHALL hold every account record, sign-in rate-limit window, missing-food tally, Event_Record, tombstone, and sync metadata value in the one database file at the path given by `DB_PATH`, together with whatever transient sidecar files the database engine maintains beside that file, and SHALL hold none of those values in any other durable location.
4. WHEN the file at `DB_PATH` does not exist at boot, THE SQLite_Backend SHALL create any missing parent directory of `DB_PATH`, create the file, and create its schema before the Origin_Server accepts its first request.
5. WHEN the Origin_Server restarts with an unchanged `DB_PATH`, THE SQLite_Backend SHALL return, field for field, the same account records, Event_Records, tombstones, missing-food tallies, and sync metadata — including each account's sequence number, its purge epoch, and each record's stored clock-clamped revision time — that were readable before the restart, such that a sync cursor issued before the restart remains valid after it.
6. IF the SQLite_Backend cannot open or create the file at `DB_PATH` at boot, THEN THE Origin_Server SHALL log the failing path, log the underlying error, and exit with a non-zero status before it listens on the Bind_Host.
7. THE Origin_Server SHALL retain the Memory_Backend as a selectable backend that reads and writes no file, so that the Test_Suite runs with no database file present.
8. WHILE `DATASTORE_BACKEND` selects the Memory_Backend and the Bind_Host is an Exposed_Bind, WHEN the Origin_Server starts, THE Origin_Server SHALL log exactly one warning, before accepting its first request, that names the Memory_Backend and states that every stored account, Event_Record, and tombstone is discarded when the process exits.
9. WHERE `DB_PATH` is unset, THE Origin_Server SHALL resolve it to a fixed path inside the single host directory the Deployment_Bundle mounts as a volume.
10. WHERE `DATASTORE_BACKEND` is unset, THE Origin_Server SHALL select the SQLite_Backend.
11. IF `DATASTORE_BACKEND` holds a value that names neither the SQLite_Backend nor the Memory_Backend, THEN THE Origin_Server SHALL log the supplied value, log the accepted values, and exit with a non-zero status before it listens on the Bind_Host.
12. WHEN the SQLite_Backend evaluates `rateLimit`, THE SQLite_Backend SHALL delete every stored rate-limit window whose window ended at least two window durations before the current instant, so that the number of stored windows for one key stays bounded however long the process runs.

### Requirement 3: Datastore Backend Equivalence

**User Story:** As a maintainer, I want the SQLite backend to behave identically to the in-memory backend the tests already rely on, so that switching backends cannot silently change application behaviour.

#### Acceptance Criteria

1. FOR ALL generated sequences of 1 to 200 Datastore_Backend calls — each call drawn uniformly from the methods the Datastore_Backend surface holds at the stage the property runs, with account identifiers drawn from a pool of at most 4 distinct normalised identities, food slugs from a pool of at most 8, and `listMissingFoods` limits drawn from `{undefined, 0, 1, 7, 200, 10000}` — THE SQLite_Backend SHALL resolve each call to a value equal, under the equality relation of criterion 10, to the value the Memory_Backend resolves for the call in the same position of the same sequence, both backends having been constructed empty immediately before the sequence runs. `rateLimit` is excluded from this criterion and is governed by criterion 6.
2. FOR ALL generated sequences of 1 to 200 Event_Store_Backend calls — `push` with 1 to 200 generated Event_Records, `pull` with a cursor drawn from `{null, the empty string, the cursor returned by the previous pull, a cursor returned before the most recent deleteAll, a token that does not match the cursor syntax}` and a limit drawn from `{undefined, 0, 1, 7, 500, 501, 10000}`, `deleteAll`, `countFor`, and `getMeta`, each for an account drawn from a pool of at most 4 distinct normalised identities, and every call receiving the same injected `now`, which starts at a fixed constant and advances between calls by a value drawn from `{0, 1, 1000, 86400000, 15552000000}` milliseconds — THE SQLite_Backend SHALL resolve each call to a value equal, under the equality relation of criterion 10, to the value the Memory_Backend resolves for the call in the same position of the same sequence, including the sequence number, purge epoch, and last tombstone sweep instant that `getMeta` reports.
3. FOR ALL generated Event_Record sets of 1 to 200 records covering at most 24 distinct ids pushed for one account with an injected `now`, pulling with a null cursor and a limit of 500 SHALL return exactly one record per distinct pushed id, and each returned record SHALL equal, under the equality relation of criterion 10, the stored-normalised form of the merge-winning pushed record for that id: photo bytes removed, sequence and clamp-provenance fields removed, `deleted` present only when true, every content field removed when the record is a tombstone, and an integer `updatedAt` more than 86,400,000 ms beyond the injected `now` replaced by that `now`.
4. FOR ALL generated pull sequences of 2 to 20 pulls for one account in which each pull presents the cursor the previous pull returned and no `push`, `deleteAll`, or clock advance intervenes, THE Event_Store_Backend SHALL return page record-id sets that are pairwise disjoint, SHALL return at most `min(500, max(1, truncate(limit)))` records per page, SHALL report `hasMore` as true on every page except the last, and the concatenation of the pages SHALL equal the ascending-sequence ordering of every record stored for that account.
5. FOR ALL generated sequences of 1 to 50 `push` calls for one account with no intervening `deleteAll`, THE Event_Store_Backend `getMeta` sequence number SHALL be non-decreasing across successive calls, SHALL increase by exactly the stored count each push reports, and SHALL equal the highest sequence that push reports whenever that count is greater than zero; and IF a `deleteAll` intervenes, THEN `getMeta` SHALL report the sequence number as 0 and the purge epoch as one greater than before that call.
6. FOR ALL rate-limit keys drawn from a pool of at most 8, all limits N in 1 to 1,000, and all window lengths in 1,000 to 3,600,000 ms, THE Datastore_Backend `rateLimit` method SHALL return true for the first N calls whose instant falls in one window bucket `floor(now / windowMs)`, SHALL return false for every further call in that bucket, SHALL return true again for the first call in the next bucket, and SHALL let no call for one key change the count of any other key. FOR ALL such sequences confined to a single bucket, THE SQLite_Backend SHALL return the same value as the Memory_Backend for every call; across a bucket boundary the Memory_Backend's sliding window and the fixed window specified here differ, and this criterion rather than criterion 1 defines the required behaviour.
7. FOR ALL accounts and all generated states reached by 0 to 200 prior Event_Store_Backend calls, calling `deleteAll` a second time SHALL leave `countFor` at 0, SHALL leave a pull from a null cursor returning zero records with the cursor-invalid signal absent, and SHALL leave `getMeta` reporting the sequence number as 0; the second call SHALL report 0 records deleted, and SHALL report a purge epoch one greater than the first call reported, so every cursor issued before either call SHALL cause the next pull to report the cursor-invalid signal and return zero records.
8. FOR ALL account identifiers built from a pool of at most 4 base addresses by adding 0 to 3 leading and 0 to 3 trailing characters drawn from `{space, tab, newline, carriage return, form feed, vertical tab}` and by permuting letter case, THE Datastore_Backend and THE Event_Store_Backend SHALL address one account for all identifiers with the same trimmed lower-cased form, and SHALL address distinct accounts for identifiers whose trimmed lower-cased forms differ by any other character, including a differing dot or plus-tag.
9. FOR ALL generated Event_Records carrying 0 to 5 unrecognised top-level fields whose names are 1 to 40 characters outside the known field set and whose values are JSON scalars, arrays, and objects nested to a depth of at most 4, whose ids are 1 to 1,500 UTF-8 bytes containing no `/`, are neither `.` nor `..`, and do not match `^__.*__$`, and whose `createdAt` and `updatedAt` are drawn from integers in 0 to 2^53−1 together with `null`, a fractional number, a numeric string, and NaN, the record read back through the SQLite_Backend SHALL equal, under the equality relation of criterion 10, the stored-normalised form defined in criterion 3, and each unrecognised field value SHALL round-trip such that its key-sorted JSON text is identical to the key-sorted JSON text of the written value, preserving string content code unit for code unit and distinguishing an absent field from one whose value is `null`.
10. THE Test_Suite SHALL compare backend results under one equality relation: values are equal when their key-sorted JSON forms are equal, treating a property whose value is `undefined` as absent, treating an absent field and a `null` field as unequal, and treating array order as significant; values are compared at the instant a call resolves, so the live object references the Memory_Backend returns from `getUser` and `upsertUser` are compared by content and not by identity; a field a backend derives from its own clock because the method takes no `now` argument — `createdAt` from `upsertUser` and the last-seen instant from `recordMissingFood` — is equal when both values are integers within 5,000 ms of each other; a list whose sort keys tie is compared after breaking ties by slug for `listMissingFoods`, so insertion order under equal sort keys is not compared; and any per-row expiry value a backend keeps for its own housekeeping is excluded from comparison. THE Event_Store_Backend SHALL return no sequence field and no clamp-provenance field on any pulled record on either backend.
11. IF a generated call causes the Memory_Backend to reject it by throwing, THEN THE SQLite_Backend SHALL reject the same call by throwing, and IF a generated call causes the SQLite_Backend to reject it by throwing, THEN THE Memory_Backend SHALL reject the same call by throwing; in either case the rejecting backend SHALL leave every value readable through the surface unchanged from immediately before the call.
12. THE Test_Suite SHALL execute each property in this requirement over at least 200 generated cases with shrinking enabled, SHALL declare a per-property timeout of 30,000 ms, SHALL create the SQLite database file in a temporary directory unique to the property run and remove that directory when the property finishes, and IF a property fails, THEN THE Test_Suite SHALL report the shrunk counterexample and the seed that produced it.

### Requirement 4: Pluggable AI Provider with Local Default

**User Story:** As a self-hoster, I want meal recognition and insights to run against a model server I choose, so that the default install works fully offline with no cloud account.

#### Acceptance Criteria

1. WHEN the Origin_Server boots, THE Origin_Server SHALL select exactly one AI_Provider from the value of `AI_PROVIDER` before it accepts its first request, and SHALL use that same AI_Provider for every AI request for the lifetime of the process.
2. THE Origin_Server SHALL support a Local_AI_Provider that calls a model server at an operator-configured base URL and, where that model server exposes a JSON-only output mode, requests that mode.
3. THE Origin_Server SHALL support an AI_Provider that calls an OpenAI-compatible chat completions endpoint at an operator-configured base URL and, where that endpoint exposes a JSON-only output mode, requests that mode.
4. THE Origin_Server SHALL support an AI_Provider that calls a hosted Gemini endpoint using an operator-supplied API key.
5. THE Origin_Server SHALL support a Mock_AI_Provider that opens no network connection and returns, within 1,000 ms of the request, synthetic output in the same shape the selected AI_Provider would return: for recognition, a non-empty dish name and between 1 and 10 ingredients each carrying a confidence value of `confident` or `maybe`; for insights, a non-empty headline and a non-empty body.
6. WHERE `AI_PROVIDER` is unset, empty, or contains only whitespace, THE Origin_Server SHALL select the Local_AI_Provider.
7. THE Origin_Server SHALL send the existing recognition prompt and the existing insight prompts to the selected AI_Provider character-for-character unmodified, and SHALL select the insufficient-data insight prompt whenever the requested focus value is not one of the defined focus values.
8. THE selected AI_Provider SHALL accept, as part of a recognition request, a base64-encoded image of MIME type `image/jpeg`, `image/png`, or `image/webp`, sized within the existing request body size cap named in Requirement 7.7, and SHALL treat the image as `image/jpeg` when no MIME type is supplied.
9. IF the selected AI_Provider returns recognition output that is not the expected JSON shape, THEN THE Origin_Server SHALL return a recognition result carrying the existing default dish name and an empty ingredient list, SHALL still apply the local food-dictionary annotation to that result, and SHALL surface no error to the caller.
10. IF the selected AI_Provider is unreachable, THEN THE Origin_Server SHALL return for that request an error response distinguishable from a validation failure and from a successful result, SHALL persist no part of the requested meal or insight, SHALL log the provider name and the failure reason, and SHALL continue serving every other route.
11. THE Origin_Server SHALL require no GCP project, GCP location, or GCP application default credentials for any AI_Provider other than the hosted Gemini one.
12. THE Repository SHALL contain no dependency on the Vertex AI client library and no test that asserts a model name beginning with `publishers/google`.
13. WHEN an AI_Provider request is made, THE Origin_Server SHALL restrict what it logs for that request to the provider name, the request kind, the outcome, and the elapsed duration, and SHALL log no image bytes, no prompt text, and no diary content.
14. IF `AI_PROVIDER` holds a value that names no supported AI_Provider, or the AI_Provider selected requires a base URL or an API key that is unset, empty, or whitespace-only, THEN THE Origin_Server SHALL log the name of the setting at fault together with the supported `AI_PROVIDER` values, and SHALL exit with a non-zero status before it begins listening.
15. THE Origin_Server SHALL bound each AI_Provider request by the timeout in milliseconds given by `AI_TIMEOUT_MS`, defaulting to 120,000 ms when that setting is unset, empty, or whitespace-only, SHALL make exactly one attempt per request with no retry, and SHALL treat a request that exceeds the timeout as an unreachable AI_Provider per criterion 10.
16. IF the selected AI_Provider returns insight output that is not the expected JSON shape, THEN THE Origin_Server SHALL return the existing fallback insight headline with the returned text as the insight body, and SHALL surface no error to the caller.

### Requirement 5: Local Food Illustration Pack

**User Story:** As a self-hoster, I want food illustrations served from a local directory, so that no private cloud bucket or cloud credential is needed and a skipped download degrades gracefully.

#### Acceptance Criteria

1. WHEN a request for `/foods/:file` arrives and the requested file exists as a regular file directly in the Food_Pack_Directory, THE Origin_Server SHALL respond with the file bytes, a WebP content type, and a cache directive marking the response publicly cacheable for at least 31,536,000 seconds and immutable.
2. IF the requested file name exceeds 128 characters or does not match the pattern `^[a-z0-9-]+\.webp$`, THEN THE Origin_Server SHALL respond 404 with no cache directive, read no file, and perform no Food_Pack_Directory lookup. Responding 404 rather than 400 on a pattern miss is deliberate and unchanged: the App_Shell probes several slug variants per food and treats only 404 as "no illustration", an existing test asserts that `/foods/not a slug.webp` yields 404 with no cache-control header, and the no-regression rule of Requirement 12 points the same way.
3. IF the requested file does not exist in the Food_Pack_Directory, THEN THE Origin_Server SHALL respond 404.
4. THE Origin_Server SHALL serve a `/foods/:file` response only from a regular file located directly in the Food_Pack_Directory, SHALL follow no symbolic link that resolves outside the Food_Pack_Directory, and SHALL treat path separators, parent-directory segments, null bytes, and percent-encoded forms of any of these in the requested file name as pattern misses handled by criterion 2.
5. WHEN the Origin_Server starts and the Food_Pack_Directory is absent, empty, or present but unreadable, THE Origin_Server SHALL complete startup, report ready, answer every `/foods/:file` request with 404, and serve every other route with its normal response.
6. WHILE the Food_Pack_Directory is absent, empty, or present but unreadable, THE App_Shell SHALL render its existing letter-avatar placeholder for every food, SHALL display no broken-image indicator, and SHALL issue at most one request per slug candidate per session.
7. THE Repository SHALL provide a Food_Pack_Fetch_Script that downloads the Food_Pack archive from a published release, verifies the downloaded archive against the checksum published with that release, and extracts the archive into the Food_Pack_Directory only after the checksum matches.
8. WHEN the Food_Pack_Fetch_Script completes successfully, THE Food_Pack_Directory SHALL contain the 3,036 WebP files of the published pack.
9. IF the download exceeds 600 seconds in total, or transfers no bytes for 60 consecutive seconds, or the archive checksum does not match the published checksum, or extraction fails, THEN THE Food_Pack_Fetch_Script SHALL report which of these steps failed, leave the Food_Pack_Directory contents unchanged from before the run, and exit with a non-zero status.
10. THE Repository SHALL exclude the Food_Pack image files from version control.
11. THE Repository SHALL contain no dependency on the Google Cloud Storage client library, and no cloud storage credential or bucket setting.
12. THE Quickstart SHALL state that the Food_Pack download is optional and describe the placeholder behaviour that follows from skipping it.
13. IF the requested file exists in the Food_Pack_Directory but cannot be read, THEN THE Origin_Server SHALL respond 404 with no cache directive as in criterion 3, log a reason for the failed read without logging file bytes, and continue serving every other route.
14. WHEN the Food_Pack_Fetch_Script is re-run and the Food_Pack_Directory already holds pack files, THE Food_Pack_Fetch_Script SHALL download only the pack files that are absent, leave every present pack file unchanged, and exit with a zero status.
15. WHERE the missing-food tally is retained, WHEN a `/foods/:file` request is answered 404, THE Origin_Server SHALL record no missing-food tally entry for that request and SHALL complete the not-found response regardless of the tally outcome.

### Requirement 6: Single-User Authentication

**User Story:** As a self-hoster, I want to sign in with one locally-configured credential, so that using my own diary needs no email provider and no mail round-trip.

#### Acceptance Criteria

1. WHEN a sign-in request arrives carrying a credential of 1 to 256 characters that matches the Local_Credential, THE Origin_Server SHALL issue a Session_Token for the single configured account.
2. IF a sign-in request carries a credential of 1 to 256 characters that does not match the Local_Credential, THEN THE Origin_Server SHALL respond 401 with an error indication stating only that sign-in failed, and SHALL issue no Session_Token.
3. THE Origin_Server SHALL compare a submitted credential against the Local_Credential such that the comparison duration is independent of the submitted credential's contents and independent of its length.
4. IF a sign-in request is the twenty-first or later request from one originating address within a 60-second window, THEN THE Origin_Server SHALL reject the request with a rate-limit error indication and SHALL perform no comparison against the Local_Credential, using the existing per-address rate-limit budget for authentication routes.
5. WHEN the Auth_Service issues a Session_Token, THE Auth_Service SHALL sign it with HMAC-SHA256 and SHALL carry in it an expiry instant 30 days after issue.
6. FOR ALL account identifiers, verifying a Session_Token that the Auth_Service signed SHALL yield that same identifier (round-trip property).
7. IF a request carries a Session_Token whose payload has been altered, whose signature has been altered, whose signature length differs from the length HMAC-SHA256 produces, or whose expiry instant has passed, THEN THE Auth_Service SHALL reject the token and THE Origin_Server SHALL treat the request as unauthenticated.
8. THE Origin_Server SHALL expose no route that requests, sends, or verifies an emailed sign-in code.
9. THE Datastore_Backend SHALL persist no sign-in code records.
10. THE Repository SHALL contain no transactional email dependency and no email delivery module.
11. THE Datastore_Backend SHALL continue to key accounts by identifier and THE Event_Store_Backend SHALL continue to isolate Event_Records per account identifier, so that supporting more than one account remains possible without a data reshape.
12. IF a sign-in request omits the credential, carries an empty credential, or carries a credential longer than 256 characters, THEN THE Origin_Server SHALL respond with the same status and the same error indication it returns for a credential that does not match, and SHALL issue no Session_Token.
13. THE Origin_Server SHALL identify the single configured account by one operator-configured identifier of 1 to 254 characters after trimming surrounding whitespace and lower-casing it, SHALL use that normalised identifier as the Session_Token subject, and SHALL report that identifier as the signed-in account in the existing session-identity response shape.
14. IF the Local_Credential is unset, empty, or shorter than 12 characters, THEN THE Origin_Server SHALL reject every sign-in request with the same status and error indication it returns for a credential that does not match, and SHALL treat no submitted value as a match.
15. WHILE no Session_Token is held, THE App_Shell SHALL permit meal logging and SHALL present a sign-in prompt that collects the Local_Credential only, with no email field and no sign-in code field.
16. THE Origin_Server SHALL include in no response any substring of the Local_Credential, the length of the Local_Credential, or any value derived from the Local_Credential.

### Requirement 7: Security Posture of a Reachable Health Diary

**User Story:** As a self-hoster exposing a personal health diary beyond my own machine, I want the server to refuse unsafe configurations outright, so that I cannot accidentally publish my diary with a default secret.

#### Acceptance Criteria

1. WHEN the Origin_Server starts with no `SESSION_SECRET` configured, THE Setup_Bootstrap SHALL generate a Session_Secret of at least 32 bytes drawn from a cryptographic random source, persist it in the volume-mounted data directory with owner-only read permission, and log the location it was written to without logging the Session_Secret value.
2. WHEN the Origin_Server restarts after the Setup_Bootstrap has run, THE Auth_Service SHALL use the persisted Session_Secret, and previously issued Session_Tokens SHALL remain valid.
3. THE Origin_Server SHALL derive its Session_Secret such that two fresh installs hold different Session_Secret values, and IF a Session_Token is signed with any Session_Secret value present in the Repository, the Documentation, or `.env.example`, THEN THE Auth_Service SHALL fail verification of that Session_Token.
4. IF the Bind_Host is an Exposed_Bind and no Local_Credential is configured, where "no Local_Credential configured" means the value is unset, whitespace-only, shorter than 12 characters, or equal to the `.env.example` placeholder, THEN THE Origin_Server SHALL log an error indicating which setting is missing or invalid and exit with a non-zero status before accepting any connection on the configured port.
5. THE Origin_Server SHALL default the Bind_Host to `127.0.0.1`.
6. WHERE an operator sets `BIND_HOST` to an Exposed_Bind, THE Origin_Server SHALL listen on that interface and SHALL log a warning at startup indicating that the diary is reachable beyond the local machine and that transport encryption is not provided by the Origin_Server itself.
7. THE Origin_Server SHALL send `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a referrer policy header, a permissions policy header that permits camera access for the same origin, and a content security policy header selected per route class on every response, and SHALL reject a request body exceeding the configured request body limit with a payload-too-large failure without processing the body.
8. THE Origin_Server SHALL write neither the Session_Secret, the Local_Credential, nor any Session_Token to its logs.
9. WHERE `TRUSTED_PROXY` is unset, THE Origin_Server SHALL derive the rate-limit address from the rightmost proxy-assigned forwarding entry when forwarding data is present, SHALL use a single fixed shared rate-limit key when no forwarding data is present, as with direct local access, and SHALL not fail the request in either case.
10. THE Documentation SHALL state which `TRUSTED_PROXY` value corresponds to a Tunnel that rewrites forwarding headers, SHALL state that an incorrect value results in either one shared rate-limit bucket for every client or a client-forgeable rate-limit bucket, and SHALL recommend enabling the Tunnel's own authentication layer as defence in depth.
11. THE `/privacy` Marketing_Page SHALL describe the self-hosted data flows: what stays in the browser, that the Session_Token is held in browser storage until it expires, what the operator's own server stores, and what leaves the machine for the configured AI_Provider.
12. THE Origin_Server SHALL enforce an 8 MB request body limit on API routes, a sign-in rate limit of 20 requests per 60 seconds per address, a sync rate limit of 120 requests per 60 seconds per address, and a sync rate limit of 60 requests per 60 seconds per account.
13. IF a request did not arrive over HTTPS and its forwarding data does not declare HTTPS, THEN THE Origin_Server SHALL omit the `Strict-Transport-Security` header from the response.
14. IF a configured `SESSION_SECRET` is shorter than 32 characters, or a persisted Session_Secret is unreadable or shorter than 32 bytes, THEN THE Origin_Server SHALL log an error indicating the invalid Session_Secret and exit with a non-zero status before listening.

### Requirement 8: Access from a Phone

**User Story:** As a self-hoster, I want to reach my diary from my phone through a tunnel I set up, so that I can log meals away from the host machine.

#### Acceptance Criteria

1. THE Origin_Server SHALL serve the App_Shell, the Marketing_Pages, and every API route on the single port given by `PORT`, accepting any integer from 1 to 65535 and listening on 8080 when `PORT` is unset, and SHALL open no second listening port.
2. WHEN the Origin_Server is reached through a Tunnel that terminates TLS and forwards to the configured port at a host name and port the build did not know, THE Origin_Server SHALL serve every document, redirect, asset reference, API reference, PWA manifest entry, and Service_Worker precache entry as a path relative to the serving origin, so that no served response carries a host name other than the one the request arrived at.
3. THE Origin_Server SHALL start and serve every route with no Tunnel-related configuration value present in the environment, and THE Repository SHALL contain no Tunnel client dependency, bundled Tunnel binary, or Tunnel lifecycle script.
4. WHILE the App_Shell runs in a context that is not a secure context, or a camera-stream request has been refused, THE App_Shell SHALL render no live camera preview and SHALL offer photo capture through the platform file-picker fallback and the photo-library picker, each reachable as a labelled control in the same view rather than as an error state that blocks logging.
5. THE Documentation SHALL state that live camera capture, installation, and offline caching each require a secure context, that plain HTTP access over a local network address therefore yields the file-picker fallback with no installation and no offline caching, and that these outcomes are expected behaviour rather than a fault.
6. THE Documentation SHALL describe at least one worked Tunnel setup end to end, from the operator installing their chosen Tunnel to loading the App_Shell at an HTTPS origin, and SHALL state that this setup restores live camera capture, installation, and offline caching.
7. WHEN two devices signed into the same account have each completed one push and have then pulled repeatedly, each pull following the cursor returned by the previous pull, until a pull returns no further records, THE Cloud_Sync protocol SHALL leave both devices holding the same set of Event_Records and the same set of tombstones, with equal persisted fields for every record present on both.
8. WHILE the App_Shell runs in a context that is not a secure context, THE App_Shell SHALL register no Service_Worker and SHALL keep meal logging, symptom logging, on-device statistics, food ranking, insights, export, and Cloud_Sync usable with no error indication attributable to the absent Service_Worker.
9. WHEN the App_Shell is loaded over HTTPS through a Tunnel at any host name and port, THE App_Shell SHALL register its Service_Worker successfully and SHALL present a manifest whose start URL and scope resolve to the App_Shell path under the serving origin.
10. THE Marketing_Pages' canonical URLs, their social-preview URLs, the generated sitemap, and the generated robots file SHALL take their origin from an operator-configured public origin setting, and WHERE that setting is unset, THE Origin_Server SHALL derive the origin from the host and scheme of the incoming request as reported by proxy-assigned forwarding data.

### Requirement 9: Packaging and First Run

**User Story:** As a self-hoster, I want one command to get a working install, so that I can try the project without reading the source.

#### Acceptance Criteria

1. THE Deployment_Bundle SHALL define one service that builds the client, starts the Origin_Server as a non-root container user, publishes the configured port, and builds and runs on both ARM and x86-64 hosts.
2. THE Deployment_Bundle SHALL mount one host directory at a single container path, and both the `DB_PATH` default and the `FOOD_PACK_DIR` default SHALL resolve inside that container path.
3. WHEN an operator runs the documented single startup command in a fresh clone with the example configuration copied unchanged, THE Origin_Server SHALL become ready to serve every route other than the recognition and insight routes within 60 seconds of container start, excluding image build time, and without further edits to any configuration value.
4. THE `.env.example` file SHALL list every setting the Origin_Server reads, each with a comment stating its purpose and its default.
5. THE `.env.example` file SHALL contain no real secret value, no placeholder that would function as a secret if left unchanged, and SHALL list the `SESSION_SECRET` and `AUTH_PASSWORD` settings with empty values.
6. WHEN the container is stopped and started again against the same mounted host directory, including when the image is rebuilt between the stop and the start, THE Origin_Server SHALL serve the same accounts, Event_Records, tombstones, sync metadata, and missing-food tallies that were readable before the stop.
7. THE Origin_Server SHALL expose a health route that requires no Session_Token, returns a response within 2 seconds of the request, reports a not-ready outcome while the selected Datastore_Backend is not yet open, and reports a ready outcome distinguishable from the not-ready outcome only after the selected Datastore_Backend is open.
8. WHEN the Origin_Server starts, THE Origin_Server SHALL log the selected Datastore_Backend, the selected AI_Provider, the Bind_Host, the port, and whether the Food_Pack_Directory holds any files.
9. THE Repository SHALL contain no infrastructure-as-code template, no hosted-service deployment manifest, no deploy script, and no continuous-deployment pipeline definition targeting the previously hosted deployment, and THE Repository's dependency manifest SHALL declare no dependency or script that deploys to it.
10. THE Repository SHALL contain a top-level LICENSE file, and THE README SHALL name a license identical to the license the LICENSE file declares and to the license the Repository's dependency manifest declares.
11. WHILE the example configuration is copied unchanged and no model server is reachable at the Local_AI_Provider base URL, THE Origin_Server SHALL serve every route other than the recognition and insight routes with the outcome it serves when a model server is reachable, and SHALL handle the recognition and insight routes as Requirement 4 specifies for an unreachable AI_Provider.
12. IF the mounted host directory is not both readable and writable by the container user, THEN THE Origin_Server SHALL log the failing path, log the underlying error, and exit with a non-zero status before listening.
13. WHEN the Origin_Server completes a first run in which the Setup_Bootstrap generated a Session_Secret, THE Origin_Server SHALL report the path the Session_Secret was written to and name the setting that supplies the Local_Credential, writing neither the Session_Secret value nor the Local_Credential value.

### Requirement 10: Documentation for a Self-Host Audience

**User Story:** As someone evaluating the project, I want the README to explain what it is and how to run it, so that I can decide in a few minutes.

#### Acceptance Criteria

1. THE README SHALL open, before any other section, with a description that names the project as a self-hosted food and symptom diary, states that it runs on hardware the operator controls, and states that the default configuration sends no diary data off that hardware.
2. THE README SHALL contain a Quickstart of exactly five numbered steps in this order: clone the Repository, copy the example configuration, optionally run the Food_Pack_Fetch_Script, start the service, open the published port; and each step whose action is a command SHALL present that command as a single copyable command block.
3. THE README SHALL state, as host prerequisites, the minimum Node version matching the version declared in the Repository dependency manifest, the container runtime the Deployment_Bundle requires, and the free disk space the extracted Food_Pack requires expressed as a numeric figure with its unit.
4. THE README SHALL contain numbered steps for reaching the install from a phone through a Tunnel, and SHALL state that live camera capture requires a secure context, that plain HTTP access over a local network address therefore falls back to the platform file picker, and that this fallback is expected behaviour.
5. THE README SHALL contain one entry per AI_Provider — Local_AI_Provider, OpenAI-compatible, hosted Gemini, and Mock_AI_Provider — each entry stating the `AI_PROVIDER` value that selects it, whether an API key is required, and whether request data leaves the host machine; and SHALL state that the Local_AI_Provider is selected when `AI_PROVIDER` is unset.
6. THE README SHALL state the default location of the SQLite database file and the host directory the Deployment_Bundle mounts it under, and SHALL contain a numbered backup procedure and a numbered restore procedure, each stating whether the Origin_Server must be stopped before its first step.
7. THE Documentation SHALL contain no instruction, and THE Quickstart SHALL contain no step, that requires a GCP project, a payment-processor account, a transactional email account, or any credential issued by a third party.
8. THE Repository SHALL contain no documentation file and no section of a retained documentation file that describes a removed capability — spreadsheet sync, billing, emailed sign-in codes, or the previously hosted cloud infrastructure — and no internal commercial document, including competitor analysis, market positioning, pre-launch fix lists, and internal research notes.
9. THE README SHALL contain a disclaimer section stating that the project is not a medical device, that its recognition and insight output is not medical advice or a diagnosis, and that a qualified health professional should be consulted before changing diet or treatment.
10. THE README SHALL contain a troubleshooting section with one entry for each of these four conditions — the configured model server is unreachable, the configured port is already in use, the mounted data directory is not writable, and camera capture is unavailable over plain HTTP — each entry stating the symptom the operator observes and the corrective action to take.
11. THE README SHALL contain an upgrade section with numbered steps for moving an existing install from one released version to a newer one, instructing the operator to back up the database file before the first step, and stating whether schema changes are applied automatically when the Origin_Server boots or require an operator action.

### Requirement 11: Removal of Hosted-Service Integrations

**User Story:** As a maintainer, I want integrations that only make sense for a hosted multi-tenant service removed, so that the open-source project has no inert or unusable configuration surface.

#### Acceptance Criteria

1. THE App_Shell SHALL present no spreadsheet sync destination entry, no connect or authorize control for one, and no spreadsheet-identifier field on any settings surface, and THE Repository SHALL contain no spreadsheet sync module, no third-party spreadsheet or file-storage API client code, and no build-time or runtime setting holding a third-party OAuth client identifier for it.
2. WHEN the operator activates export, THE App_Shell SHALL produce one file containing every meal entry, symptom entry, and attached photo held in local storage on that device, and SHALL issue no network request while producing it.
3. THE Origin_Server SHALL respond to every path that previously reported aggregate telemetry across accounts, ingested a client-reported usage event, or reported logged foods lacking an illustration with the not-found outcome defined for unregistered paths, and SHALL read no stored counter while doing so.
4. THE App_Shell SHALL send no page-view, funnel, first-log, or log-saved event to the Origin_Server or to any other destination.
5. WHEN the Origin_Server is started with no cloud-provider credential, cloud project, cloud region, or administrative access token present in the environment, THE Origin_Server SHALL reach its ready health state within 30 seconds and serve every Route_Table path, logging no missing-configuration warning and no error.
6. THE Test_Suite SHALL pass with zero failing tests, and no test in the Test_Suite SHALL import a removed spreadsheet sync or telemetry module or assert spreadsheet sync, usage-counter, or aggregate-reporting behaviour.
7. WHEN the Origin_Server serves a Marketing_Page request, an App_Shell request, a login-page request, a recognition request, an insight request, or a session-identity request, THE Origin_Server SHALL increment no usage counter and SHALL write no per-account last-seen or usage-count value.
8. THE Datastore_Backend surface SHALL exclude per-day usage-counter read and write methods, aggregate account-statistics methods, and the per-account last-seen write method, and no persisted account record SHALL carry a last-seen day or other retention-analytics field.
9. WHEN the App_Shell restores persisted sync settings that contain values written by the removed spreadsheet sync destination, THE App_Shell SHALL ignore those values, present Cloud_Sync as an independently toggleable destination reflecting only its own persisted enable state and failure history, and surface no error to the operator.

### Requirement 12: No Regression of Surviving Features

**User Story:** As an existing user of the app, I want the diary itself to work exactly as before, so that the conversion costs me no functionality.

#### Acceptance Criteria

1. THE App_Shell SHALL retain meal logging, symptom logging, on-device statistics, food ranking, insights, and export, and for identical stored diary data SHALL produce the same observable output for each of those features as it produced before the conversion, with no entitlement value, paid-status value, or remaining-quota value reaching any view.
2. WHILE no Session_Token is held, THE App_Shell SHALL render the App_Route that was requested without redirecting to the login route, SHALL save meal and symptom logs to on-device storage, and SHALL offer sign-in rather than a payment prompt at every AI call site.
3. WHEN a request arrives for a path registered in the Route_Table, THE Origin_Server SHALL resolve it to the same one of five outcomes it resolves today — a Marketing_Page document, the App_Shell document, a static file from the build output, a trailing-slash redirect answered with status 301 to the same path without the trailing slash for a Marketing_Page path or the login path, or the not-found outcome — with the removed pricing page resolving to the not-found outcome.
4. IF a request path belongs to no Route_Table class, THEN THE Origin_Server SHALL respond with status 404, the not-found document, an HTML content type with a UTF-8 charset, and a body that is not the App_Shell document.
5. THE Origin_Server SHALL keep the per-class response header set it applies today: no-store caching on API routes and on the not-found response, no-cache on the App_Shell and on the Service_Worker and web manifest, a bounded shared-cache directive with must-revalidate on Marketing_Pages, a one-year immutable directive on content-hashed build assets, a one-hour directive on crawler files and other unhashed static files, no cache directive of its own on the trailing-slash redirect, the separate immutable long-lived directive set by the Food_Pack path handler itself, a noindex robots header on API routes, on the App_Shell (login route and App_Routes included) and on the not-found response, an explicit HTML content type on the Marketing_Page, App_Shell and not-found documents together with the existing declared types for the crawler files and the web manifest, and a content-security-policy on every response in which only a Marketing_Page carries the hash sources of its own structured-data blocks.
6. THE Cloud_Sync push and pull protocol SHALL keep its request shape, response shape, cursor semantics, tombstone semantics, per-request body cap of 1 MiB, per-push cap of 200 Event_Records, per-record cap of 16 KiB serialized, per-account stored cap of 100,000 Event_Records including tombstones, its existing fixed rejection-reason vocabulary for a request that exceeds any of those caps or fails validation, and its all-or-nothing push in which a rejected push stores no Event_Record — minus the removed entitlement field.
7. THE Origin_Server SHALL apply the pre-handler middleware chain on Cloud_Sync routes in its existing order — redacted request logging, declared body-size check, per-address rate limit, Session_Token verification, per-account rate limit — with only the entitlement gate removed, and SHALL read no request body and access no stored Event_Record until every step in that chain has passed; the transport-scheme check that precedes this chain today is governed by Requirements 7 and 8 rather than by this criterion, because it may change.
8. WHEN the Origin_Server logs a Cloud_Sync request or a deletion request, THE Origin_Server SHALL emit one line per response carrying only the request method, the request path without its query string, the response status, the count of Event_Records handled, the authenticated account identifier, a fixed reason label, and — for a caught throw — the error's class name, and SHALL carry no Event_Record content, note text, request body, query parameter, Session_Token, credential, or thrown-error message.
9. WHEN an account requests deletion of the account itself, THE Origin_Server SHALL delete that account's Event_Records, tombstones, and sync metadata before deleting the account record, and SHALL complete the whole deletion within 30 seconds of accepting the request.
10. WHEN an account requests deletion of its cloud copy without deleting the account, THE Origin_Server SHALL delete that account's Event_Records, tombstones, and sync metadata within 30 seconds, SHALL retain the account record and leave already-issued Session_Tokens valid, and SHALL advance the purge generation so that a later pull presenting a cursor issued before the deletion is answered with the cursor-invalid signal and no Event_Records.
11. IF a deletion of an account's stored Event_Records does not finish within 30 seconds or the Event_Store_Backend reports a failure, THEN THE Origin_Server SHALL respond with an error status and a fixed incomplete-deletion reason rather than a success, SHALL leave the account record present and its session valid so the client can repeat the identical request, and SHALL make a repeat of that request able to complete, with a deletion against an already-empty account succeeding and leaving the same state as a first successful deletion.
12. THE recognition and insight responses SHALL keep the field shapes the App_Shell parses today.
13. WHEN work on any requirement in this document is complete, THE Test_Suite SHALL report zero failing tests, zero tests newly skipped relative to the pre-conversion suite, and no removed test other than those the billing exclusions of Requirement 1.13 and the removed-integration exclusions of Requirement 11.6 permit.

### Requirement 13: Staged Conversion

**User Story:** As a maintainer, I want the conversion done in reviewable stages, so that a regression is attributable to one small change rather than to one large diff.

#### Acceptance Criteria

1. THE billing removal SHALL be performed as two separate changes: first making the entitlement check return an unconditional grant, then deleting the branches that are unreachable as a result.
2. WHEN the entitlement check is changed to return an unconditional grant, THE same change SHALL delete or rewrite every test assertion that expects a not-entitled, quota-exhausted, or payment-required outcome, so that no such assertion remains to fail.
3. THE Test_Suite SHALL pass in full at the completion of the first billing-removal change, before any unreachable billing branch is deleted, and again at the completion of each of the six stages named in the Introduction, where passing in full means every test file in the suite is executed, every test reports success, and no test is skipped, marked pending, or excluded from the run.
4. THE conversion SHALL complete the six stages named in the Introduction in their numbered order, such that the persistent Datastore_Backend lands before the Deployment_Bundle mounts a host directory as a volume, and the generated Session_Secret lands before the Documentation describes first-run behaviour.
5. THE conversion SHALL deliver each of the six stages as one reviewable change set whose diff is limited to the files that stage's requirements concern, with no unrelated refactor, formatting-only edit, or dependency change included.
6. WHILE a stage is in progress, THE Origin_Server SHALL start from the example configuration copied unchanged and report ready within 30 seconds of the documented startup command.
7. IF at the completion of a stage the Test_Suite does not pass in full, or the Origin_Server does not report ready within 30 seconds of the documented startup command, THEN the conversion SHALL halt at that stage, and no work on a later stage SHALL begin until that stage's change set is either corrected or reverted.
8. WHILE stage 5 or stage 6 has not landed, THE Repository SHALL remain non-public, because intermediate states carry a Session_Secret an outside party could forge and retain the cloud infrastructure code.

## Open Decisions

These need a call before or during design. Each has a default noted, but none is settled.

1. **Firestore backend**: retain it as a third selectable Datastore_Backend, or delete it with the rest of the GCP surface. Default: delete, since keeping it means keeping the client library and a code path nobody self-hosting will exercise.
2. **License**: AGPL-3.0 versus MIT. AGPL keeps hosted forks open; MIT maximises adoption and keeps the door open for the owner's own hosted offering. Affects Requirement 9.10.
3. **Branding**: whether the open-source repository ships the existing name and `brand/` assets, ships unbranded with a neutral name, or ships the code under a permissive license with the brand assets under separate terms. Affects the Marketing_Pages, the generated icons, and the OG images.
4. **Missing-food tally**: whether `recordMissingFood` and `listMissingFoods` survive. They exist to tell the pack maintainer which illustrations to draw next; for a single self-hoster they are dead weight. Default: keep the write path, drop the read route. Requirement 5.15 and Requirement 11.3 are written to hold either way.
5. **Metrics counters**: resolved in favour of removal by Requirements 11.7 and 11.8, which also remove the per-account last-seen field. Recorded here because it was an open question and because removal shrinks the SQLite schema; reopen it only if some local-only usage view turns out to be wanted.
6. **Infrastructure code**: delete `infra/` from history-forward, or move it to a separate private repository first. Affects Requirement 9.9 only in method, not in outcome.
7. **SQLite driver**: the built-in `node:sqlite` module, which raises the minimum Node version, versus `better-sqlite3`, which adds a native build step to the container image. Affects Requirement 10.3.
8. **Local model default**: which specific local multimodal model the documentation recommends. The behaviour when no model server is reachable is settled by Requirements 4.10 and 9.11 — the AI routes report an error rather than silently falling back to the Mock_AI_Provider — but the recommended model is still open.
9. **Credential at rest**: whether the Local_Credential is compared against a plaintext environment value or against a stored hash of it. Requirement 6.3 states only the observable timing property, so either satisfies it. A hash costs a first-run hashing step and a way to set it; plaintext in the environment is simpler and is already how the operator supplies every other secret.
10. **Retained documentation**: Requirement 10.8 states which documents must go. Still open is which of the remaining `docs/` files are kept and maintained as public documentation — the configuration reference, the datastore schema notes, the cloud-sync protocol notes, and the two domain methodology references are the candidates — and whether a contributor-facing architecture overview and a CONTRIBUTING file are added.
11. **Unit of review**: whether each of the six stages is one commit or one pull request. Requirement 13.5 fixes it at one reviewable change set per stage without choosing between the two.
