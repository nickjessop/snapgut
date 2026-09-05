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

## Understanding the code

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Request path, boot phases, module layout, datastore and AI boundaries, the shared route table, client offline design, test strategy |

## Domain background

These describe the health concepts the app models. They are written for contributors changing
the analysis code, not for end users.

| Document | What it covers |
| --- | --- |
| [fodmap-program.md](fodmap-program.md) | The FODMAP elimination and reintroduction structure the app follows |
| [intuitive-eating.md](intuitive-eating.md) | The intuitive-eating framing the app's language and nudges are held to |

## Elsewhere in the repo

- [CONTRIBUTING.md](../CONTRIBUTING.md) — development setup and how changes are proposed.
- [SECURITY.md](../SECURITY.md) — how to report a vulnerability.
- [CHANGELOG.md](../CHANGELOG.md) — release history.
- [LICENSE](../LICENSE) — AGPL-3.0-or-later.
