# Deltix-Client

[![CI](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml)
[![Release](https://github.com/SammyBytes/Deltix-Client/actions/workflows/release.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Git-style version control for relational databases — from your terminal.
Deltix-Client is a single-binary CLI that runs a local [Dolt](https://github.com/dolthub/dolt)
engine and syncs commits with a [Deltix-Server](https://github.com/SammyBytes/Deltix-Server)
control plane.

MIT licensed. See [`LICENSE`](./LICENSE).

---

## Install

Grab the binary for your platform from the
[latest release](https://github.com/SammyBytes/Deltix-Client/releases/latest)
(Linux/macOS/Windows, x64 and arm64), put it on your `PATH`, and you're done —
no Bun runtime needed.

```bash
chmod +x deltix-linux-x64 && sudo mv deltix-linux-x64 /usr/local/bin/deltix
deltix version
```

For CI/automation, there's also a container image:

```bash
docker pull ghcr.io/sammybytes/deltix-client:latest
```

The first time a command needs Dolt, the client downloads and SHA-256-verifies
a pinned official Dolt binary into `~/.deltix/bin/` — you never install a
database server yourself.

---

## Quick start

The everyday loop mirrors Git. Everything runs inside a project folder that
holds a `.deltix/config.toml` (like `.git`).

```bash
deltix configure                 # point at your Deltix-Server (once)
deltix login <user> <password>   # authenticate

# Work on an existing repo:
deltix clone analytics           # fetch the full history into ./analytics
cd analytics && deltix start     # run the local Dolt engine (MySQL on 127.0.0.1:3306)
# ...change your data via any MySQL client...
deltix commit "add customers"    # snapshot locally
deltix push                      # send commits to the server
deltix pull                      # bring the server's commits back (merge if needed)
```

Or start a brand-new repo from a folder you already have:

```bash
cd my-project
deltix init analytics            # bind this folder to repo "analytics" + create local Dolt repo
deltix start                     # start the local engine
# ...create tables / data via MySQL on 127.0.0.1:3306...
deltix commit "seed data"
deltix push                      # first push auto-creates the repo on the server (if you have permission)
```

---

## Commands

### Setup & auth
| Command | What it does |
|---|---|
| `deltix configure` | One-time connection setup (server URL, TLS). Saved to `~/.deltix/config.json`. |
| `deltix login <user> <pass>` | Authenticate; stores a refresh token. |
| `deltix logout` / `deltix whoami` | End / show the active session. |
| `deltix version` | Client (and reachable server) version. |

### Local workflow (git-like)
| Command | What it does |
|---|---|
| `deltix clone <repo>` | Create `./<repo>`, bind it, and pull the full history. |
| `deltix init <repo>` | Bind the current folder to a repo (creates `.deltix/` + local Dolt repo). |
| `deltix start [<repo>]` | Start the local Dolt SQL server (loopback). |
| `deltix stop [<repo>]` / `deltix status [<repo>]` | Stop / inspect the local engine. |
| `deltix commit <message> [tables...]` | Snapshot the working tree (optionally only named tables). |
| `deltix push [<repo>]` | Send your unpushed commits to the server. |
| `deltix pull [<repo>]` | Fetch + merge the server's commits into your branch. |
| `deltix pull --abort` | Undo an in-progress conflicted merge. |
| `deltix fetch [<repo>]` | Update `origin/*` refs without touching your branch. |
| `deltix branch local [<repo>]` | List local vs remote-tracking branches. |

### Server / versioning
| Command | What it does |
|---|---|
| `deltix repo create <repo>` / `list` / `get <repo>` | Provision and inspect repositories. |
| `deltix branch list <repo>` | List branches on the server. |
| `deltix branch create/checkout/delete <repo> <name>` | Manage server branches. |
| `deltix merge <repo> <source> [target]` | Merge branches on the server. |
| `deltix log <repo> [--branch=] [--limit=]` | Commit history. |
| `deltix diff <repo> <from> <to>` | Row/schema diff between two refs. |
| `deltix roles list/grant/revoke <repo> [user] [role]` | Per-repo access control (`reader`/`writer`/`admin`). |
| `deltix sync-prefs get/set/dry-run <repo> ...` | Choose which tables version, with FK-closure preview. |

---

## How syncing works

- **Push** sends commits (not loose files): the client reads the commits on your
  branch that aren't on `origin/<branch>`, exports each changed table's schema
  (DDL) and rows (CSV), and posts them to the server, which recreates them as
  real Dolt commits with the original message and author.
- **Pull** is the mirror: it downloads the commits you're missing and applies
  them locally, fast-forwarding when clean or running a real `dolt merge` when
  you and the server have diverged (conflicts are reported per table).
- **Permissions** are enforced by the server, never the client: you need
  `writer`/`admin` on a repo to push, and creating a new repo requires the
  `canCreateRepos` permission (a global admin can grant it). Without it, a push
  to an unknown repo is rejected and your work stays safely local.
- **TLS is always on.** `deltix configure` can fetch and pin the server's
  self-signed certificate (trust-on-first-use) for both the REST and gRPC
  endpoints; connecting over a bare IP works without disabling verification.

> The legacy whole-file gRPC transfer is retained only behind
> `DELTIX_ENABLE_GRPC_TRANSFER=1` for rollback while the commit-based path is
> confirmed, and is slated for removal.

---

## Configuration

`deltix configure` writes defaults to `~/.deltix/config.json`. Any of these
environment variables override it:

| Variable | Default | Purpose |
|---|---|---|
| `DELTIX_SERVER_URL` | `http://127.0.0.1:9090` | REST control plane. |
| `DELTIX_GRPC_HOST` / `DELTIX_GRPC_PORT` | `127.0.0.1` / `50051` | Transfer engine (pull/legacy). |
| `DELTIX_HTTP_TLS_CA_PATH` / `DELTIX_GRPC_TLS_CA_PATH` | — | CA to trust a self-signed server. |
| `DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE` / `DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE` | — | SNI name when connecting by IP. |
| `DELTIX_LOCAL_HOST` / `DELTIX_LOCAL_PORT` | `127.0.0.1` / `3306` | Local Dolt SQL server. |
| `DELTIX_HOME` | `~/.deltix` | Root for local state + Dolt binary. |
| `DELTIX_DOLT_VERSION` / `DELTIX_DOLT_BIN_PATH` | `2.3.1` / — | Pinned Dolt version / preinstalled binary. |

---

## Architecture

A modular monolith organized by **bounded contexts** under `src/contexts/*`
(no hexagonal layering). Process spawning is isolated in `src/acl/dolt-exec.ts`
(argv arrays only — never a shell string); the binary is always resolved through
`binary-manager` and integrity-checked.

| Context | Responsibility |
|---|---|
| `config` | `deltix configure` + persisted connection settings. |
| `session` | Login/refresh, local credential storage. |
| `local-project` | The `.deltix/config.toml` binding; per-checkout state. |
| `binary-manager` | Resolve/download/verify the pinned Dolt binary. |
| `mysql-embedded` | Local `dolt sql-server` lifecycle (`start`/`stop`/`status`). |
| `versioning-local` | Local Dolt operations: commit, push export, pull apply, merge, branches, `origin/*` tracking. |
| `versioning` | REST parity with the server: repos, branches, merge, log/diff, roles, sync-prefs, push/pull-commits. |
| `dataflow`, `heartbeat` | Legacy gRPC transfer (behind the feature flag). |

Full engineering rules (architecture, security, testing, logging) live in
[`.github/copilot-instructions.md`](./.github/copilot-instructions.md).

---

## Development

Requires [Bun](https://bun.sh) `>=1.4`.

```bash
bun install
bun run lint          # Biome
bun run test:unit
bun run test:integration
bun run test:smoke
bun build ./src/cli/index.ts --compile --outfile dist/deltix
```

TDD is mandatory: failing test first, minimal implementation, refactor. No
branch merges to `main` without unit + integration + smoke passing.

## Security

See [`SECURITY.md`](./SECURITY.md) for the supported-version policy and how to
report vulnerabilities privately.
