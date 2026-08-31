# Deltix-Client

[![CI](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml)
[![Release](https://github.com/SammyBytes/Deltix-Client/actions/workflows/release.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Git-style version control for relational databases — from your terminal.
Deltix-Client is a single-binary CLI that runs a local [Dolt](https://github.com/dolthub/dolt)
engine and syncs commits with a [Deltix-Server](https://github.com/SammyBytes/Deltix-Server)
control plane.

MIT licensed. See [`LICENSE`](./LICENSE).

> **v0.7.16** — see [CHANGELOG.md](./CHANGELOG.md) for the full release history
> (v0.7.1 → v0.7.16). Highlights since the prior README: masked secret prompts,
> `--continue` for safe data imports, auto-refresh of access tokens, per-project
> repo autodetect from cwd, and many small operator-pain DX wins.

---

## Install

Fastest path — a single command that downloads the right binary for your
OS/arch, verifies its SHA-256, and installs to `~/.local/bin` (Linux/macOS,
including Arch):

```bash
curl -fsSL https://raw.githubusercontent.com/SammyBytes/Deltix-Client/main/scripts/get-deltix-client.sh | bash
```

Windows (Scoop bucket ships in this repo):

```powershell
scoop bucket add deltix https://github.com/SammyBytes/deltix-bucket
scoop install deltix
```

Or grab the binary for your platform directly from the
[latest release](https://github.com/SammyBytes/Deltix-Client/releases/latest)
(Linux/macOS/Windows, x64 and arm64), put it on your `PATH`, and you're done —
no Bun runtime needed.

```bash
chmod +x deltix-linux-x64 && sudo mv deltix-linux-x64 /usr/local/bin/deltix
deltix version
```

The first time a command needs Dolt, the client downloads and SHA-256-verifies
a pinned official Dolt binary into `~/.deltix/bin/` — you never install a
database server yourself.

See [`packaging/README.md`](./packaging/README.md) for the distribution
options (installer, Scoop, and the deferred winget/AUR/Homebrew routes).

---

## Quick start

The everyday loop mirrors Git. Everything runs inside a project folder that
holds a `.deltix/config.toml` (like `.git`).

```bash
deltix configure                 # point at your Deltix-Server (once)
deltix login                     # masked password prompt (no plaintext in history)
                                # alt:   deltix login <user> --password=<pass>   (scripts)

# Work on an existing repo:
deltix clone analytics           # fetch the full history into ./analytics
cd analytics && deltix start     # run the local Dolt engine (MySQL on 127.0.0.1:3306)
# ...change your data via any MySQL client...
deltix commit "add customers"    # snapshot locally — author is the logged-in user
deltix push                      # send commits to the server
deltix pull                      # bring the server's commits back (merge if needed)
```

Or start a brand-new repo from an existing MySQL/MariaDB:

```bash
cd ~                          # or wherever you want the project
deltix init analytics            # bind this folder to repo "analytics"

# Adopt an existing DB into Deltix in one command:
deltix import analytics \
  --from "mysql://reader@127.0.0.1:3306/myapp" \
  --blobs base64 --continue        # --continue skips rows that violate constraints

deltix push                      # first push ships the imported data
```

> `--continue` is the safety net for source DBs with a few bad rows
> (NOT NULL violations, type coercion failures from permissive `sql_mode=''`,
> etc.) — the import skips them and finishes, instead of aborting the whole
> table on the first one.
>
> Use `--no-commit` to preview without committing, `--schema-only` to
> adopt structure without data, and `--blobs skip` if you don't need BLOB
> columns for the initial import.

---

## Commands

> Inside a `deltix init`-ed working tree, `<repo>` and `[<repo>]` arguments
> become **optional** — the cwd project's `repo = ...` line wins. The cli
> shells below show the explicit forms for clarity.

### Setup & auth
| Command | What it does |
|---|---|
| `deltix configure` | One-time connection setup (server URL, TLS). Saved to `~/.deltix/config.json`. |
| `deltix login <user>` | Authenticate; masked password prompt by default. Falls back to `--password=<value>` or `$DELTIX_LOGIN_PASSWORD` for scripts. |
| `deltix logout` / `deltix whoami` | End / show the active session. |
| `deltix version` | Client version + (when /status is reachable) server version. |

### Import & export
| Command | What it does |
|---|---|
| `deltix import <repo> --from <dsn>` | Adopt an existing MySQL/MariaDB into Dolt. `dsn` is `mysql://user@host:port/db`. Supports `--schema-only`, `--data-only` (default both), `--blobs error|base64|skip`, `--continue` (skip bad rows), `--table <t>` (only some tables). When the DSN omits the password, the CLI prompts for it with the input hidden. |
| `deltix clone <repo>` | Create `./<repo>`, bind it, and pull the full history. |

### Local workflow (git-like)
| Command | What it does |
|---|---|
| `deltix init <repo>` | Bind the current folder to a repo (creates `.deltix/` + local Dolt repo). |
| `deltix start [<repo>]` | Start the local Dolt SQL server (loopback). Fails fast with a clear error if the configured port is busy. The chosen port is persisted into `~/.deltix/config.json` after the first explicit `DELTIX_LOCAL_PORT=…` so subsequent commands don't need it. |
| `deltix stop [<repo>]` / `deltix status [<repo>]` | Stop / inspect the local engine. |
| `deltix commit <message> [tables...]` | Snapshot the working tree. Author is the logged-in user (sanitised, no shell injection). |
| `deltix push [<repo>]` | Send your unpushed commits to the server. The access token is auto-refreshed on 401, so an idle session does not force a re-login. |
| `deltix pull [<repo>]` | Fetch + merge the server's commits into your branch. |
| `deltix pull --abort` | Undo an in-progress conflicted merge. |
| `deltix fetch [<repo>]` | Update `origin/*` refs without touching your branch. |
| `deltix branch local [<repo>]` | List local vs remote-tracking branches. |

### Server / versioning
| Command | What it does |
|---|---|
| `deltix repo create <repo>` / `list` / `get [<repo>]` | Provision and inspect repositories. |
| `deltix branch list\|current [<repo>]` | List branches / get the current branch name on the server. |
| `deltix branch create\|checkout\|delete [<repo>] <name>` | Manage server branches. |
| `deltix merge [<repo>] <source> [target]` | Merge branches on the server. |
| `deltix log [<repo>]` | Commit history. `-b <name>` and `-n <count>` short flags supported. |
| `deltix diff [<repo>] <from> <to>` | Row/schema diff between two refs. |
| `deltix roles list\|grant\|revoke [<repo>] [user] [role]` | Per-repo access control (`reader`/`writer`/`admin`). |
| `deltix sync-prefs get\|set\|dry-run [<repo>] ...` | Choose which tables version, with FK-closure preview. |

---

## How syncing works

- **Push** sends commits (not loose files): the client reads the commits on your
  branch that aren't on `origin/<branch>`, exports each changed table's schema
  (DDL) and rows (CSV), and posts them to the server, which recreates them as
  real Dolt commits with the original message, author, and timestamp.
  Row loads use `dolt table import -r` against a per-table temp CSV file
  (one subprocess per table instead of per row), which lets Dolt's own
  CSV parser handle type coercion — empty strings in `DATETIME` /
  `NUMERIC` columns land as `NULL`, the historical default MySQL
  behaviour you'd want anyway.
- **Pull** is the mirror: it downloads the commits you're missing and applies
  them locally, fast-forwarding when clean or running a real `dolt merge` when
  you and the server have diverged (conflicts are reported per table).
- **Permissions** are enforced by the server, never the client: you need
  `writer`/`admin` on a repo to push, and creating a new repo requires the
  `canCreateRepos` permission. A global admin (`isGlobalAdmin=true`) gets
  implicit `admin` on every repo so they don't have to grant themselves
  access after provisioning from a different account.
- **Sessions** are sliding-window: 15-minute access token, 7-day refresh
  token. The CLI refreshes the access token transparently on 401, so an
  active operator stays logged in for a week without prompting. Inactivity
  boot is at 7 days.
- **TLS is always on.** `deltix configure` can fetch and pin the server's
  self-signed certificate (trust-on-first-use) for both the REST and gRPC
  endpoints; connecting over a bare IP works without disabling verification.
  The `/status` probe used by `deltix version` threads the same CA
  options through, so the probe succeeds whenever data calls do.

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
| `DELTIX_LOCAL_HOST` / `DELTIX_LOCAL_PORT` | `127.0.0.1` / `3306` | Local Dolt SQL server. After the first explicit `DELTIX_LOCAL_PORT`, the value is persisted and you no longer need to export it. |
| `DELTIX_HOME` | `~/.deltix` | Root for local state + Dolt binary. |
| `DELTIX_DOLT_VERSION` / `DELTIX_DOLT_BIN_PATH` | `2.3.1` / — | Pinned Dolt version / preinstalled binary. |
| `DELTIX_IMPORT_URL` | — | Optional default for `deltix import --from`. |
| `DELTIX_LOGIN_PASSWORD` | — | Password for non-interactive `deltix login`. The CLI warns when this is used. |

---

## Architecture

A modular monolith organized by **bounded contexts** under `src/contexts/*`
(no hexagonal layering). Process spawning is isolated in `src/acl/dolt-exec.ts`
(argv arrays only — never a shell string); the binary is always resolved through
`binary-manager` and integrity-checked.

| Context | Responsibility |
|---|---|
| `config` | `deltix configure` + persisted connection settings, including the auto-persisted `localPort`. |
| `session` | Login, auto-refresh, masked-password prompts, local credential storage (0600). |
| `local-project` | The `.deltix/config.toml` binding; per-checkout state; the `resolveRepo`/`resolveServerIdentity` autodetect chain used by every data command. |
| `binary-manager` | Resolve/download/verify the pinned Dolt binary. |
| `mysql-embedded` | Local `dolt sql-server` lifecycle (`start`/`stop`/`status`) with log-file redirect (no SIGPIPE), fail-fast on port collisions. |
| `import` | `deltix import` end-to-end: parse DSN, mask password, push masked prompt, schema-only / data-only, `--continue`, blob policies, JSON-column serialisation. |
| `versioning-local` | Local Dolt operations: commit, push export, pull apply, merge, branches, `origin/*` tracking. Commits are tagged with the logged-in user (sanitised). |
| `versioning` | REST parity with the server: repos, branches, merge, log/diff, roles, sync-prefs, push/pull-commits. |
| `dataflow`, `heartbeat` | Legacy gRPC transfer (behind the feature flag). |

Full engineering rules (architecture, security, testing, logging) live in
[`.github/copilot-instructions.md`](./.github/copilot-instructions.md).

---

## Security

- **Argv arrays only** for every subprocess (Dolt, mysql, everything).
  No `shell: true`, no string interpolation, ever. Input fields that flow
  into `--author` or Dolt config are sanitised to `[A-Za-z0-9_.-]` to
  prevent CLI flag injection.
- **Server-trusted TLS only.** The client trusts the configured CA / SNI
  override via `buildFetchTlsOptions(...)`; never via the global
  `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Local credentials are 0600** at `~/.deltix/credentials.json`, never
  shared, never logged. Refresh tokens are rotated server-side on every
  `/refresh` call.
- **Secret prompts are masked** for both `deltix login` and `deltix import`
  by default (TTY raw-mode + `*` per keystroke). Passing secrets on the
  command line is permitted but triggers an explicit warning so the
  operator knows the secret just hit shell history / `ps`.

See [`SECURITY.md`](./SECURITY.md) for the supported-version policy and how to
report vulnerabilities privately.
