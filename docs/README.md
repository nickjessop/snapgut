# Documentation

Reference documentation for running and developing SnapGut, a self-hosted food and symptom
diary. The root [README](../README.md) is the quickstart; everything here goes deeper.

## Start here

If you are setting up an instance for the first time, read in this order:

1. [Root README](../README.md) — clone, `.env`, `docker compose up`, first sign-in.
2. [configuration.md](configuration.md) — every environment variable, its default, and which
   values stop the server from booting.
3. [deployment.md](deployment.md) — reverse proxy, TLS, systemd, tunnels.

Then, as needed: [ai-providers.md](ai-providers.md) to get meal recognition working, and
[operations.md](operations.md) once the instance is live.

## Operating an instance

| Document | What it covers |
| --- | --- |
| [configuration.md](configuration.md) | Every environment variable the server reads, with defaults, valid values, and boot-failure conditions |
| [ai-providers.md](ai-providers.md) | Choosing and wiring an AI provider: Ollama, LiteLLM, OpenAI-compatible gateways, hosted APIs, and the mock provider |
| [deployment.md](deployment.md) | Docker Compose, running under systemd, Caddy/nginx/Traefik reverse proxies, TLS, tunnels, and resource expectations |
| [operations.md](operations.md) | Boot summary, health checks, logs, backup and verified restore, secret rotation, moving an install, upgrades, SQLite troubleshooting, uninstall |
| [datastore.md](datastore.md) | SQLite schema: tables, indexes, PRAGMAs, cursors, tombstone sweep, migrations |
| [cloud-sync.md](cloud-sync.md) | The sync protocol: endpoints, limits, what is stored where, export, and the three deletion paths |
| [food-pack.md](food-pack.md) | The optional food illustration pack: fetching and verifying it, the slug convention, what you get without it, provenance, and its unresolved licensing |
| [privacy.md](privacy.md) | What stays in the browser, what the server's SQLite file holds, what leaves the machine for the AI provider, sync, export formats, and the three deletion paths |
| [terms.md](terms.md) | What the app claims and does not claim, the not-a-medical-device framing, and the operator's responsibilities for a self-hosted instance |

## Understanding the code

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Request path, boot phases, module layout, datastore and AI boundaries, the shared route table, client offline design, test strategy |

## Domain background

These describe the health concepts the app models. They are written for contributors changing
the analysis code, not for end users.

| Document | What it covers |
| --- | --- |
| [fodmap-program.md](fodmap-program.md) | Trigger groups and ingredient tagging as the app implements them, the low-FODMAP protocol for context, and which parts of it are deliberately not built |
| [intuitive-eating.md](intuitive-eating.md) | Why the app will not call a food a trigger: the evidence gates, the language rules, and where the scoring code still works against them |

## Elsewhere in the repo

- [CONTRIBUTING.md](../CONTRIBUTING.md) — development setup and how changes are proposed.
- [SECURITY.md](../SECURITY.md) — how to report a vulnerability.
- [CHANGELOG.md](../CHANGELOG.md) — release history.
- [LICENSE](../LICENSE) — AGPL-3.0-or-later.
