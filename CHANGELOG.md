# Changelog

All notable changes to Deltix-Client are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry starts with a **plain-language summary** (what changed, in
everyday words) before any technical detail — written so someone outside
engineering can understand what shipped and why it matters.

## [0.7.24] - 2026-08-31

**In plain terms:** `deltix status` no longer says "not running" when the server is actually alive but its tracking file was deleted, and `deltix start` no longer fails with "Port already in use" in that case.

### Fixed

- **Orphaned `dolt sql-server` (run file deleted while process stayed alive on the port): `deltix status` now probes the port and verifies via the MySQL wire protocol (`SELECT 1` against the expected DB) before reporting "not running", `deltix start` adopts the orphaned server and recreates the run file instead of throwing "Port already in use", and `deltix stop` discovers the PID via `netstat`/`lsof` when the recorded PID is unknown (`-1`).** This covers the remaining repro on 0.7.23 where `status` said "not running" for `hmc-sync` while `Get-NetTCPConnection -LocalPort 3307` still showed the Dolt PID and `deltix start` failed.

## [0.7.23] - 2026-08-31

**In plain terms:** `deltix status`/`start`/`stop` no longer lose track of the local Dolt server when you run them from a different folder.

### Fixed

- **`deltix status` reported "not running" while the `dolt sql-server` was still alive on the port, and a subsequent `deltix start` failed with "Port already in use" instead of reusing it (and `deltix stop` failed with "Not running").** Root cause: run state is keyed by the resolved project (`~/.deltix/run/project-<hash>.json` when run from inside a `deltix init`ed tree, `~/.deltix/run/<repo>.json` otherwise). If `status`/`stop`/`start` was later called from a different cwd (e.g. a script) the resolved identity changed and the lookup missed the file. Now `status`/`stop`/`start` fall back to scanning `~/.deltix/run` for any state file for the same repo when the caller has no project context, while preserving per-project isolation when a project is present (two checkouts of the same repo still get separate servers). `versioning-local` also falls back to scanning for the actual data dir so `deltix status` (which shows `dolt_status`) does not fail when the identity mismatches.

## [0.7.22] - 2026-08-31

**In plain terms:** Dolt now reports `innodb_version` so MySQL health checks that gate on `>= 8.0.28` pass without changes.

### Added

- **Compatibility shim for `SHOW VARIABLES LIKE 'innodb_version'`.** Dolt does not use InnoDB (it uses NBS) and therefore does not expose `innodb_version` at all; callers that do `SHOW VARIABLES LIKE 'innodb_version'` and check `>= 8.0.28` would otherwise see an empty result set and treat Dolt as incompatible, even though it is intentionally a different engine. On `deltix start`, after the server is ready, the client best-effort mirrors `@@version` into `@@innodb_version` via `SET GLOBAL innodb_version = '<version>'` so the check passes while staying in sync with the running Dolt binary. Failures are swallowed — this is purely a convenience for MySQL-oriented health checks that assume InnoDB.

## [0.7.21] - 2026-08-31

**In plain terms:** `deltix status` now runs in ~50ms instead of 6 seconds.

### Fixed

- **`deltix status` was spawning the Dolt binary twice sequentially (~3s each on Windows).** Now it (1) caches the binary path lookup, (2) runs `active_branch()` and `dolt_status` in parallel, and (3) when the local SQL server is running (the common case), queries via the MySQL wire protocol with `mysql2` directly — no process spawn at all. Clean tree goes from 6s → ~50ms; with changes, ~100ms.

## [0.7.20] - 2026-08-31

**In plain terms:** `deltix status` now shows what changed (like `git status`), `deltix diff` works locally without server roundtrip, and `deltix repo list` no longer dumps JSON.

### Added

- **`deltix status` now shows staged vs unstaged tables (Git-like).** After you point your app/ORM to Dolt on `:3307` and run a migration (`npx prisma migrate dev`, `alembic upgrade head`, `php artisan migrate`), `deltix status` reports `On branch main` plus `Changes not staged for commit:` and `Changes to be committed:` by querying `dolt_status` directly. This is the core of the "Dolt as primary DB" workflow — no more `deltix import` after every migration, just `status` → `commit` → `push`.
- **`deltix diff` without server refs shows the working-tree diff.** `deltix diff`, `deltix diff <repo>`, and `deltix diff <repo> <table>` run `dolt diff --stat` locally so you can inspect what the app just did before committing. `deltix diff <repo> <from> <to>` remains the server diff (same as before).

### Fixed

- **`deltix repo list` now renders a readable table.** Previously mapped `repos.map(r => ({ repo: r }))` where `r` is a full `RepoSummary` object, so `formatValue` JSON-stringified the entire row into one column. Now flattens to `{ repo: r.repoId, owner: r.createdBy, role: r.role }`. `deltix repo get` also flattens its output instead of dumping `{ repo: { repoId, doltPath, ... } }` as nested JSON.

## [0.7.19] - 2026-08-31

**In plain terms:** `deltix log` now accepts flags before the repo name
(`deltix log -n 5 hmc-sync` works just like `git log -n 5`).

### Fixed

- **`deltix log -n 5 <repo>` and `deltix log --branch=x <repo>` now work
  regardless of flag position.** A new `splitPositionalsAndFlags` helper
  separates flags (anything starting with `-`) from positional args, so
  `deltix log -n 5 hmc-sync`, `deltix log hmc-sync -n 5`, and
  `deltix log hmc-sync --limit=5` all behave identically. The previous
  destructuring `const [repoArg, ...flags] = args` took the first arg as
  the repo unconditionally, which meant `deltix log -n 5 hmc-sync` treated
  `-n` as the repo name and failed with "Repo not found: -n".

- **Minor lint fix** in `certificate-bootstrap.ts`: `!cert || !cert.raw` →
  `!cert?.raw` (optional chaining, biome suggestion).

---

## [0.7.18] - 2026-08-31

**In plain terms:** the client no longer talks gRPC, and the operator
no longer needs env vars for the things `deltix configure` can ask about
itself.

### Changed

- **`deltix configure` covers everything the operator needs.** The
  wizard now prompts for the local Dolt SQL bind host AND port (default
  `127.0.0.1:3306`) in addition to the server URL and TLS, and
  persists both to `~/.deltix/config.json`. The previously required
  `DELTIX_LOCAL_PORT=...` manual export on every `deltix start` is now
  a one-time wizard answer.
- **Env vars are now CI / automation only.** Every connection-related
  setting (`DELTIX_SERVER_URL`, `DELTIX_HTTP_TLS_CA_PATH`,
  `DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE`, `DELTIX_LOCAL_HOST`,
  `DELTIX_LOCAL_PORT`, `DELTIX_DOLT_BIN_PATH`) has a corresponding
  field in `~/.deltix/config.json` that `deltix configure` writes. Env
  vars still take precedence (for CI), but the human-facing flow is
  now command-driven, not env-driven.

### Removed

- **gRPC transfer pipeline.** The client never used gRPC for data-plane
  traffic — that was a legacy Fase 3 path behind
  `DELTIX_ENABLE_GRPC_TRANSFER`. The client is now REST-only: the entire
  `dataflow/` and `heartbeat/` bounded contexts, the
  `acl/grpc-transfer-client.ts` and `acl/transfer-ticket-api-adapter.ts`
  adapters, the `DELTIX_GRPC_*` and `DELTIX_HEARTBEAT_*` env vars, the
  `grpcHost` / `grpcPort` / `grpcTlsCaPath` / `grpcTlsServerNameOverride`
  fields on `StoredConfig`, the `@grpc/grpc-js` and `@grpc/proto-loader`
  dependencies, and the associated tests are all gone. The
  commit-based REST push/pull path (Fase 5.9) is the only path left,
  which was already the recommended one.

## [0.7.17] - 2026-08-31

**In plain terms:** three small fixes reported by the same operator in one
debug session. The Windows users got a one-liner installer that matches
the bash experience.

### Fixed

- **`deltix diff` crashed with `TypeError: rows.reduce is not a function`**
  on every call. The server returns `{ fromRef, toRef, tables: [...] }`;
  the CLI passed `diff` directly to `printTable`, which then called
  `.reduce()` on an object. Now passes `diff.tables`.
- **`deltix log -n 5` mis-parsed `-n` as the repo name.** The flag
  helper `parseFlagValue` only matched `--name=value`, not the space-
  separated forms (`--name value`, `-n 5`). Rewrote it to accept all
  three; `-n 5` and `--branch main` and `--limit=5` all work now.
  `flagValue` for `--password=` and `--from=` already supported the
  space-separated forms; brought everything into one consistent helper.
  Added 7 unit tests covering all three forms.

### Added

- **Windows installer: `scripts/get-deltix-client.ps1`.** The PowerShell
  equivalent of the bash installer: detects AMD64/ARM64, downloads the
  matching asset, SHA-256-verifies against the GitHub-published digest
  (via `Get-FileHash`), and installs to `$HOME\.local\bin\deltix.exe`
  (or `C:\Program Files\Deltix` with `-System`, which auto-elevates via
  `runas`). Honors the same `VERSION=` and `INSTALL_DIR=` env vars as the
  bash script. The README's Windows section now shows this as the
  recommended path ahead of Scoop, and the script itself ships with full
  PowerShell comment-based help (`Get-Help .\get-deltix-client.ps1`).

## [0.7.16] - 2026-08-31

**In plain terms:** the help text now tells you `[<repo>]` is optional
when you're inside a `deltix init`-ed working tree, and `deltix version`
finally shows the server version (the probe now passes TLS options).

### Fixed

- **`deltix version` reported "server version probe unavailable"** on TLS
  servers with self-signed certs even though `push`, `log`, and every
  data command worked fine. The probe path used a raw `fetch()` without
  passing the CA cert / SNI override that the data API threads through.
  Now uses the same `buildFetchTlsOptions(...)` helper, so the probe
  succeeds against the same TLS server as everything else.

### Changed

- **Help text now shows optionality.** The `deltix` top-level help
  switched `<repo>` to `[<repo>]` for every command that autodetects
  via v0.7.14's `resolveRepo` (repo get, branch list/create/checkout/
  delete/current, merge, diff, roles, sync-prefs). All `[--flag]`
  patterns unified to `[--flag=value|-f value]` so the short forms
  shipped in v0.7.13 are discoverable. New top-level note: "When run
  from a `deltix init`-ed working tree, [<repo>] becomes optional —
  the cwd project wins."

## [0.7.15] - 2026-08-31

**In plain terms:** two small operator-pain reductions reported in one
session.

### Fixed

- **`deltix branch list` printed JSON blobs** for each row
  (`{"name":"feature-test","isCurrent":false}`) because the table printer
  serialised the `{name, isCurrent}` object inline. Now flattens to a
  readable two-column table with a `*` marker on the current branch.
- **`deltix version` claimed the server was `unreachable`** whenever the
  `/status` endpoint timed out or returned non-2xx, even though the data
  endpoints were visibly working. Replaced the alarming wording with a
  quiet "(server version probe unavailable; run any data command to
  confirm connectivity)" so we don't shout server-down when commands
  still work.

## [0.7.14] - 2026-08-31

**In plain terms:** every command that takes a `<repo>` argument now
optionally falls back to the cwd project's `repo =` from `.deltix/config.toml`,
so you only need to type the repo name when you're outside a project
context or want to operate on a different repo than the one bound at
cwd.

### Changed

- **All data-context commands auto-detect repo from cwd when no arg is
  given.** `deltix merge`, `deltix diff`, `deltix roles`, `deltix branch
  list|create|checkout|delete|current`, `deltix sync-prefs get|set`,
  and `deltix repo get` all use the new `resolveRepo()` helper, which
  mirrors `resolveServerIdentity` (which already powered `push`, `log`,
  and `branch local` via v0.7.11). When you're inside a `deltix init`ed
  working tree, `<repo>` becomes optional. Falls back to the historical
  hard-error UX only when there's no cwd project AND no arg is given.

### Removed

- The internal `requireRepo` / `requireRepoAndName` helpers (which
  hard-errored on missing args) — replaced by the async `resolveRepo` /
  `resolveRepoAndName` that try the cwd project first.

## [0.7.13] - 2026-08-31

**In plain terms:** three small UX bugs from the same session squashed in
one release: branch and merge success messages now show readable key/value
lines instead of JSON blobs, and `deltix log` accepts the short `-b` /
`-n` flags.

### Fixed

- **`deltix branch create/checkout` printed a JSON blob** in the success
  detail (e.g. `branch: {"currentBranch":"main","createdBranch":"foo"}`)
  because the CLI passed the API's typed response straight into the
  key-value printer. Now flattens to `current: main / created: foo`.
- **`deltix merge` printed `merge: {...}`** for the same reason; now
  shows `source / target / commitHash / status` plus a "(fast-forward)"
  note when applicable.
- **`deltix log` only accepted the long form `--branch=name`**.
  Added short forms: `--branch X` / `-b X` and `--limit N` / `-n N`,
  and updated the usage text to show them.

## [0.7.12] - 2026-08-31

**In plain terms:** when you're logged in (`deltix login hemiblade`),
the commits you make and push now show up as authored by `hemiblade`
in `deltix log`, instead of every commit being attributed to a generic
`deltix` identity.

### Changed

- **Commit author now reflects the logged-in user.** `deltix commit`
  and `deltix import` use the session username as the dolt commit
  author, so `deltix log` actually tells you who pushed what. Falls
  back to the historical `deltix` literal for callers without an
  active session (tests, scripts) and the auth flag is sanitised to
  letters/digits/dot/dash/underscore so a maliciously-crafted username
  can't smuggle CLI args into the dolt invocation (OWASP A03).

## [0.7.11] - 2026-08-31

**In plain terms:** every command that takes a repo name (e.g.
`deltix push hmc-sync`, `deltix log foo`) now correctly uses the cwd
project's local working tree, instead of looking for an old-style flat
data dir that almost nobody uses.

### Fixed

- **`deltix push hmc-sync` / `deltix log foo` / etc. failed with
  "No local data directory found"** even though the project was set up
  via `deltix init` and the data was there. `resolveServerIdentity()`
  dropped the project's `projectRoot` when a repo was given explicitly
  on the command line, so the local data dir resolved under the legacy
  `~/.deltix/repos/<repo>` path instead of the project's
  `~/.deltix/projects/<hash>/<repo>` path. Threaded through. Falls back
  to repo-only when there's no project at cwd or the project is bound
  to a different repo.

## [0.7.10] - 2026-08-31

**In plain terms:** your session no longer expires on you mid-flow.
Any command that hits a 401 transparently refreshes the access token and
retries once.

### Added

- **Auto-refresh on 401.** When the server returns 401 (access token
  expired between the CLI minting it and the server validating it), the
  versioning API adapter now calls `session.mintAccessToken()` (refresh
  token exchange), retries the request once with the new token, and only
  surfaces the auth error if the refresh itself fails. Operators no
  longer need to re-`deltix login` every 15 minutes.

## [0.7.9] - 2026-08-31

**In plain terms:** when `deltix import` hits a row that violates a
NOT NULL / type constraint in your source DB, it used to abort the whole
table. Now you can pass `--continue` to skip the bad row and import
everything else.

### Added

- **`deltix import --continue`.** Forwards to `dolt table import
  --continue`: a row that violates a constraint (e.g. NULL in a
  NOT NULL column, type coercion failure) is skipped instead of
  aborting the import. Useful when the source DB has a handful of bad
  rows that you'd rather skip than fix one-by-one before importing.
  Once the import completes, the operator still gets the regular
  `dolt table import` summary telling them how many rows were skipped,
  so they can clean the source at their leisure.

### Fixed

- (`v0.7.8`) `deltix import` JSON columns: see prior release.

## [0.7.8] - 2026-08-31

**In plain terms:** importing a MySQL/MariaDB table that had a JSON column
used to fail with `[object Object]` because the client serialized the
parsed object the wrong way. JSON columns now round-trip correctly.

### Fixed

- **`deltix import` failed on JSON columns with `Invalid JSON text:
  invalid character 'o' looking for beginning of value` / `cause: ...
  ACSSystemSettings: [object Object]`.** mysql2 returns MySQL JSON column
  values as already-parsed JavaScript objects, but `serializeTable()` ran
  them through `String(value)`, which gives the unhelpful `'[object
  Object]'`. Fixed: JSON.stringify object values before CSV-encoding,
  so the document lands in Dolt as the same JSON it had in MySQL.

## [0.7.7] - 2026-08-31

**In plain terms:** v0.7.6 shipped with a bug: `deltix login <username>`
(no password) crashed with `ReferenceError: promptSecret is not defined`
because the import was missing. Fixed.

### Fixed

- **`deltix login <username>` (no password) crashed with
  `ReferenceError: promptSecret is not defined`.** The new masked-prompt
  helper added in v0.7.6 was used in `runLogin` but never added to the
  named-import block at the top of `src/cli/index.ts`. Bun's tree-shaker
  only catches this at runtime, so the unit tests didn't catch it.
  Fixed by adding `promptSecret` to the import list.

## [0.7.6] - 2026-08-31

**In plain terms:** `deltix login` no longer needs your password on the
command line. By default it prompts for it with the input hidden; if you
do pass it as an argument (backward compatible) it warns you that the
secret just landed in your shell history.

### Changed

- **`deltix login` defaults to a masked password prompt.** Precedence:
  1. `--password=<value>` (no warning — explicit opt-in)
  2. positional `<password>` (logs a one-line "now in your shell history" warning)
  3. `DELTIX_LOGIN_PASSWORD` env var (logs a "visible to other processes" warning)
  4. interactive TTY prompt, masked (the safe default).
  Empty password or non-TTY without an env var now errors with a clear message instead of returning an empty credential.

## [0.7.5] - 2026-08-31

**In plain terms:** two UX/security wins for `deltix import`. The CLI now
prompts for your database password with the input hidden (never echoed),
and asks interactively whether you want schema+data or schema only — with
a sensible default, no flag to remember.

### Added

- **`deltix import` prompts for the DB password with masked input.** When
  the `--from` DSN has a user but no password (e.g.
  `mysql://root@127.0.0.1/db`), the CLI now asks for it via a masked
  TTY prompt — no more pasting the secret in plaintext, no more entries
  in shell history or `ps`. The password stays out of the DSN string.
  Falls back to a non-masked warning if stdin isn't a TTY (CI/piped).
- **Interactive "schema + data?" prompt.** When you don't pass
  `--schema-only` AND the terminal is interactive, the CLI asks once
  with the default "schema + data". In scripts / CI it stays silent and
  defaults to schema + data, so the command stays batchable.

## [0.7.4] - 2026-08-31

**In plain terms:** the validation loop is now fully green.
`deltix log` (with or without a repo argument) prints the commit history as
a clean table, no more "rows.reduce is not a function" crash.

### Fixed

- **`deltix log` crashed every time with `rows.reduce is not a function`.**
  The server returns `{ log: { commits: [...], limit } }`; the client was
  passing the wrapper object to the table printer instead of the array
  inside. Now it prints the commit history correctly.
- **`deltix log` (no repo argument) printed a usage error** even from
  inside an initialised working tree, while `deltix push` already
  auto-resolves the repo from the cwd. `log` now does the same.

### Tests

- 133 unit tests pass; lint clean.

## [0.7.3] - 2026-08-31

**In plain terms:** you no longer have to type `DELTIX_LOCAL_PORT=3307`
in front of every command. After the first `deltix start` with the port
you want, the client remembers it.

### Fixed

- **`deltix start` now remembers the port.** When you have to set
  `DELTIX_LOCAL_PORT` (because your system already runs MariaDB on 3306),
  `deltix start` saves it to `~/.deltix/config.json` so every following
  command (commit, log, push, start, stop, status...) picks it up
  automatically. Only persists when you set the env var explicitly - the
  default port is never silently written, so sharing the config across
  hosts (dotfiles) stays safe.

### Tests

- 133 unit tests pass (4 new).

## [0.7.2] - 2026-08-31

**In plain terms:** another bug found while trying the local engine for real
on a fresh machine: right after `deltix start` reported success, the local
Dolt would die the moment you tried to connect to it ("Lost connection at
handshake"). The engine was not broken - it was being killed by the operating
system because the way `deltix start` launched it filled up an invisible
buffer. The fix makes `deltix start` write the server output to a log file
(the way shells normally do), which removes that pressure and gives
operators a post-mortem log to inspect.

### Fixed

- `deltix start` then mysql-connect immediately: `Lost connection at
  handshake`. The local Dolt was killed by SIGPIPE a moment after
  `deltix start` reported ready. Root cause: `spawnBackgroundProcess` wrapped
  the child stdout in a Node pipe that nothing was draining (we only exposed
  stderr); the ~64 KiB buffer filled, Dolt got SIGPIPE on its next periodic
  stdout write, and the listener closed mid-handshake. Fix: redirect both
  stdout and stderr to `<DELTIX_HOME>/run/<repo>.sql-server.log` (opened with
  O_APPEND) and pre-create the run/ directory before spawn.

### Tests

- 129 unit tests pass (1 new: log path wired up and run/ pre-created).

## [0.7.1] - 2026-08-30

**In plain terms:** two fixes found while installing Deltix on a machine that
already runs MySQL/MariaDB. Starting the local engine on a port someone else
was using used to look like it worked but wasn't — now it tells you straight
away and points you to a free port. And the local database is now named after
your repo (so you can `USE demo`), instead of an unreadable code.

### Fixed

- **`deltix start` falsely reported success when the port was already taken.**
  If another MySQL/Dolt server held `DELTIX_LOCAL_PORT` (e.g. a system MariaDB
  on 3306), Dolt died trying to bind but the readiness check saw the *other*
  server's listener and returned "started" — leaving a stale run-state and a
  dead PID, and a confusing "Access denied" when you then connected. Now a
  pre-flight probe fails fast with a clear "port in use — set
  DELTIX_LOCAL_PORT" message before spawning anything.
- **Opaque local database name.** The local Dolt database was named after the
  per-checkout hash (the data-dir basename), so creating tables meant
  `USE <16-hex>`. The data dir now nests the repo under the hash
  (`projects/<hash>/<repo>`), so Dolt names the database after your repo.

### Tests

- 128 unit tests pass (2 new: port-conflict fail-fast, friendly db name).

## [0.7.0] - 2026-08-29

**In plain terms:** you can now bring a database you already have into Deltix.
`deltix import` connects to an existing MySQL/MariaDB database, takes a clean
snapshot of its current tables and data, and turns it into the starting commit
of a Deltix repository — so you keep working exactly as before, just versioned.
If a table holds binary data, Deltix tells you instead of silently corrupting
it, and lets you choose how to handle those columns.

### Added

- **`deltix import <repo> --from <mysql://dsn>` (ADR 0001).** Adopts an existing
  MySQL/MariaDB database into the local Deltix repo: reads a consistent snapshot
  (read-only, `REPEATABLE READ` + `CONSISTENT SNAPSHOT`), recreates every table
  from its real DDL (preserving primary keys and types), bulk-loads rows with
  `dolt table import -r`, orders tables by foreign-key dependencies, and makes
  an initial commit. Reuses the existing `{name, schema, data}` commit contract,
  so adopted data flows through normal `push`/`pull` unchanged.
  - Flags: `--table` (subset), `--schema-only`, `--no-commit`, and
    `--blobs error|base64|skip` (default `error` — aborts and names the offending
    columns rather than corrupting them; `base64` round-trips binary via
    `FROM_BASE64`).
  - The connection string can also come from `DELTIX_IMPORT_URL`, and the
    password is redacted in all logs and errors.
  - New `SourceAdapter` abstraction; MySQL/MariaDB is the first implementation
    (via the pure-JS `mysql2` driver, bundled into the single binary). Postgres
    and `csv://` are planned as additional adapters.

### Tests

- 126 unit tests pass (13 new: DSN parse/redact, RFC-4180 CSV with NULLs and
  base64 blobs, topological FK ordering) plus a MySQL-gated integration test.
  Validated end-to-end against a real MariaDB source and a real Dolt target:
  tables, quoted commas, NULLs, dates, primary keys, FK order, and exact binary
  round-trip under all three `--blobs` policies.

## [0.6.1] - 2026-08-29

**In plain terms:** fixes `deltix init` on Windows. The first Windows build
couldn't find its database engine because it looked in a broken relative
folder and only knew how to fetch the Linux/macOS version. Now it resolves the
correct absolute path and downloads the right Dolt for your platform. (The
native `pull`/`fetch`/`clone` work from 0.6.0 is unchanged; this release simply
ships that plus the Windows fix, which had landed after 0.6.0 was cut.)

### Fixed

- **`deltix init` failed on Windows with `Executable not found in $PATH:
  ".deltix\bin\dolt-2.3.1\bin\dolt"`.** Two root causes in `binary-manager`:
  `defaultHomeDir()` used `process.env.HOME` (undefined on Windows, which uses
  `USERPROFILE`), producing a *relative* install path — now uses
  `os.homedir()` (absolute). And only darwin/linux `.tar.gz` releases were
  handled — added `win32`: `dolt-windows-<arch>.zip`, extracted via
  `tar -xf` (bsdtar on Windows 10+), binary resolved as `dolt.exe`.
- **`deltix init` no longer hard-fails if Dolt can't be resolved yet** (e.g. a
  first-run download needs network): it still binds the project and warns that
  `deltix start` will initialize the engine. `deltix start` now also ensures the
  local Dolt repo exists (idempotent) before serving it.

### Tests

- 113 unit tests pass; build + lint clean. (Windows Dolt download can't be
  exercised from the Linux CI runner; path/format logic follows Dolt's official
  release layout.)

## [0.6.0] - 2026-08-29

**In plain terms:** the CLI now completes the Git loop on your side. You can
**clone** a repository onto your machine, **pull** the server's latest changes
(merging them with anything you did locally, and telling you clearly if there's
a conflict to resolve), **fetch** to just update what you know about the server
without changing your work, and see your **local vs remote branches** like in
Git. Under the hood, `deltix push` was fixed so it actually works on a fresh
folder (it now creates the local database engine and remembers what you've
already sent). The old way of pulling a single file is kept only behind an
opt-in switch for now, so it can be retired safely.

### Added

- **`deltix pull [<repo>]` — native commit-based pull (Fase 5.9).** Downloads
  the commits the server has that you don't and applies them to your local
  branch, recreating tables from their schema so primary keys survive.
  Fast-forwards when you have nothing to send; when you and the server have
  diverged it runs a real `dolt merge`. On conflicts it prints a per-table
  report and leaves the repo mid-merge; `deltix pull --abort` undoes it.
- **`deltix fetch [<repo>]` (Fase 5.9).** Updates your `origin/<branch>`
  remote-tracking refs from the server without touching your working branch —
  exactly like `git fetch`. Backed by the server's new streaming `pull-commits`
  endpoint (NDJSON).
- **`deltix clone <repo>` (Fase 5.9).** Creates `./<repo>`, binds it, and pulls
  the full server history in one step — the `git clone` equivalent.
- **`deltix branch local [<repo>]` (Fase 5.9).** Lists Local vs
  Remote-tracking (`origin/*`) branches, like `git branch -a`.
- **`DELTIX_ENABLE_GRPC_TRANSFER` feature flag (Fase 5.9, transitional).** When
  on **and** a destination file is passed, `deltix pull <repo> <file>` falls
  back to the legacy whole-file gRPC transfer. Off by default; kept only until
  the native pull is confirmed, then removed.

### Fixed

- **`deltix push` was non-functional on a fresh checkout (Fase 5.9).** Three
  latent bugs, none caught because the commit-push path had no end-to-end test:
  the client never ran `dolt init` (so the local repo/branch didn't exist),
  `dolt log` has no `--reverse`/`--format` flags (the old range query always
  failed), and `origin/main` was never created or advanced. Now `deltix init`
  creates the local Dolt repo, unpushed commits are enumerated via the
  `dolt_log` table, and `origin/<branch>` is advanced after each push so a
  second push only sends new work.

### Changed

- **`deltix pull` no longer takes a file path** (breaking, by design): it is now
  commit-based by default. The legacy file behavior is available only behind
  `DELTIX_ENABLE_GRPC_TRANSFER`.

### Tests

- 113 unit tests pass. New: `origin/*` tracking + full-history push (real-Dolt
  validated), fast-forward and divergent merge (conflict + abort), local/remote
  branch listing; plus a real-server round-trip integration test
  (clone → push → pull → conflict) that runs in CI where both repos are present.

## [0.5.0] - 2026-08-29

**In plain terms:** the CLI became a complete local workflow, the same shape
you know from Git. It now manages its own copy of the Dolt database engine
(downloaded and verified automatically), runs a local database server with
`deltix start`, and — new in this release — you can **bind a folder to a
repository** (`deltix init`), **save snapshots of your data**
(`deltix commit`), and **send those snapshots to the company server**
(`deltix push`), all from inside your project folder. Pushing now sends real
commits with exactly the tables you chose — no more uploading loose files. If
you don't have permission to create a repository, the push is politely
refused and your work stays safely on your machine.

### Added

- **`deltix push` — commit-based sync over REST (Fase 4b).** Resolves the
  project from the current folder (no file argument), reads the commits on
  `main` that aren't on `origin/main`, exports each commit's changed table data
  via Dolt temporal queries (`SELECT * FROM <table> AS OF <hash>` — no
  checkout needed), and posts them to the server's
  `POST /repos/:repoId/push-commits` endpoint. "Already up to date" is a
  success, not an error. **Pull is unchanged**: it still streams over gRPC.
- **`deltix commit <message> [tables...]` (Fase 3b).** Stages and commits the
  local Dolt working tree — either named tables (allow-list) or everything —
  and prints the new commit hash.
- **`deltix init <repo>` + `.deltix/config.toml` (Fase 3a).** Binds a working
  directory to a Deltix repo, like `.git` does. `start` / `stop` / `status` /
  `commit` / `push` resolve the repo from the current folder, and local state
  is keyed per checkout (SHA-256 of the project root), so two clones of the
  same repo never collide.
- **`binary-manager` context.** `BinaryManager#ensureInstalled()` resolves a
  Dolt binary following, in order: `DELTIX_DOLT_BIN_PATH`, a matching `dolt` on
  `PATH`, an already-installed copy under `~/.deltix/bin/dolt-<version>` that
  passes its recorded SHA-256, or a fresh download of the official release
  tarball over HTTPS (extracted with `tar`, then hash-recorded for future
  re-verification).
- **`src/acl/dolt-exec.ts`.** The one place that shells out to external
  executables (`dolt`, `tar`, `which`), always passing an argv array (never a
  concatenated shell string) so no dynamic value can be interpreted as a
  shell metacharacter. Exposes `runCommand`, `runDoltCommand`,
  `runDoltOrThrow`, `whichBinary`, and `DoltExecError`.
- **Dolt version pinning.** `DELTIX_DOLT_VERSION` (default `2.3.1`, matching
  Deltix-Server) and `DELTIX_HOME` env vars; new `src/shared/env.ts` fields.
- **`mysql-embedded` context + `deltix start` / `stop` / `status`.** Managed
  lifecycle of a local **Dolt SQL server** (`dolt sql-server`) bound to
  loopback — one process per local repo checkout — giving you a real,
  MySQL-compatible Deltix database engine locally with **zero dependency on a
  pre-installed MySQL service**. `start` resolves a verified Dolt binary,
  launches the server on `127.0.0.1:<port>`, waits for it to accept
  connections, and records the run state; `status` reports whether it's alive;
  `stop` shuts it down. State lives under `~/.deltix/repos/<repo>` (data) and
  `~/.deltix/run/<repo>.json` (run state).
- **`DELTIX_LOCAL_HOST` / `DELTIX_LOCAL_PORT`** env vars (default
  `127.0.0.1:3306`) and persisted `localPort` / `localDoltBinPath` `configure`
  fields, so you can avoid colliding with a host MySQL service.
- **`spawnBackgroundProcess`** ACL helper in `src/acl/dolt-exec.ts` for
  launching the long-running Dolt server (same argv-array, no-shell-string
  contract as every other external executable call).
- **CI Dolt install step**: the GitHub Actions workflow now installs the pinned
  Dolt binary so the `mysql-embedded` integration suite runs a real spawn →
  status → stop lifecycle in CI (skipped locally when no Dolt is present).

### Security

- Only an **unmodified official Dolt release artifact** is ever used — never
  compiled, patched, or altered locally — and its on-disk SHA-256 is
  re-verified before every run, so a tampered or corrupted binary is refused
  and reinstalled instead of trusted.
- **Push is scoped to the project (Fase 4b).** `deltix push` only operates
  inside a folder initialized with `deltix init` (the `.deltix/config.toml`
  binding), and the server independently enforces that the authenticated user
  holds `writer`/`admin` on that exact repo — there is no global or
  cross-repo push path.

### Tests

- 107 unit tests pass; build + lint clean. New: `getUnpushedCommits()`
  data-dir guard, `pushCommits()` token-minting and delegation, per-project
  state isolation, commit allow-list staging, and TOML config round-trips.
  End-to-end commit flow verified locally against real Dolt 2.3.x
  (init → start → commit → inspect `dolt_log`).

## [0.4.3] - 2026-08-29

**In plain terms:** `deltix push`/`pull` could fail with a confusing
"Could not parse target name" error if the gRPC host had an accidental
trailing/embedded space or newline (e.g. stray whitespace in a
`DELTIX_GRPC_HOST` env var or pasted config value). The host is now cleaned
of whitespace before connecting, so a stray character never breaks a
transfer.

### Fixed

- **`deltix push`/`pull` throwing `Could not parse target name "host\n\n:port"`.**
  grpc-js rejects a channel target containing whitespace. A script or shell
  session with a `DELTIX_GRPC_HOST` env var left over with a trailing newline
  (which wins over the persisted config) produced exactly that broken target.
  The host is now normalized (all whitespace stripped) before the channel is
  created, and an all-empty host is rejected with a clear message.

## [0.4.2] - 2026-08-28

**In plain terms:** connecting a client to a server that is only reachable by
its IP address (no hostname) used to trip over the TLS certificate check: the
client setup asked for a "server name override" but gave no clue what to type,
and if you put the IP address itself the transfer failed at the handshake. Now
`deltix configure` reads the name the server's own certificate is issued for,
suggests it automatically, and just needs you to press Enter — no guessing,
and it works against any company's server out of the box.

### Changed

- **`deltix configure` now suggests the server-name override automatically.**
  When the gRPC host is a bare IP, the certificate is fetched first (when the
  server uses a self-signed cert) and the DNS-style names present in its
  Subject Alternative Name are used as the default override for the TLS
  server-name prompt — instead of a hard-coded `localhost` default that almost
  never matched. IP-address SANs are correctly excluded (TLS clients cannot
  verify an IP as a server name), and the fetched certificate's SAN is surfaced
  to the operator. If the certificate has no usable DNS name, the prompt still
  falls back to `localhost` so the flow never blocks.

### Added

- `acl/certificate-bootstrap.ts` now exposes the certificate's DNS-style
  Subject Alternative Names via `FetchedCertificate.dnsNames`, parsed from the
  raw TLS peer certificate, so `configure` can derive the correct override
  instead of requiring the operator to know it in advance.

### Tests

- Extended `tests/unit/acl/certificate-bootstrap.test.ts`: asserts `dnsNames`
  surfaces the real `DNS:` SAN entries and excludes IP-only SANs (so an IP
  server with an auto-named `DNS:` SAN resolves to the right default). Full
  unit suite and lint remain green.

## [0.4.1] - 2026-08-28

**In plain terms:** running `deltix configure` on Windows used to crash with
a "broken pipe" error as soon as it started asking for your server address, so
you could never finish setting up the client interactively on that machine.
The interactive prompts are now built directly on a stable keyboard-input
mechanism (instead of the one that was crashing), so `deltix configure` works
on Windows, macOS and Linux. It also no longer hangs forever if the prompts
are invoked without a keyboard attached (for example from a script or CI) —
it simply keeps the defaults instead.

### Fixed

- **`deltix configure` crashed on Windows with `EPIPE: broken pipe`**: the
  interactive prompts used `consola.prompt`, whose implementation writes
  through a layer that can have its output stream closed mid-prompt on
  Windows consoles / Bun single-file executables, surfacing as an unhandled
  `EPIPE`. `promptText`/`promptConfirm` now read input directly via
  `node:readline` over `process.stdin`/`process.stdout` with explicit `error`
  handlers on both streams, which is stable across total terminals.
- **Prompts could hang forever when stdin isn't a terminal**: if `configure`
  was run with piped/closed stdin (e.g. unattended/CI), `readline` never
  received a line and the prompt blocked indefinitely. `rawPrompt` now
  resolves with an empty answer when stdin is not a TTY, so callers fall back
  to their default — matching the "press Enter to keep the default"
  behaviour without hanging.

### Tests

- Verified the compiled CLI: with stdin closed, `configure` completes using
  defaults instead of hanging; the full unit suite (71) and the whole test
  run (87) pass with lint clean after the change.

## [0.4.0] - 2026-08-28

**In plain terms:** logging in and pushing/pulling against a server with a
self-signed HTTPS certificate (the default for a fresh `install.sh` setup)
used to require the insecure, process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0`
workaround for login — and even then, pushes/pulls still failed at the gRPC
layer with `DEPTH_ZERO_SELF_SIGNED_CERT`, because that env var has no effect
on the gRPC client. On top of that, there was no way to get the server's
certificate onto the client machine except manually copying the file, which
routinely broke on wrong paths and `sudo` needing a terminal. Both problems
are fixed: every network call (REST and gRPC) now has a real way to trust a
specific certificate, and `deltix configure` can fetch that certificate for
you and ask you to confirm it, the same way SSH asks you to confirm a new
host key.

### Fixed

- **HTTP calls now support a trusted CA certificate.** `AuthApiAdapter`,
  `TransferTicketApiAdapter`, and `VersioningApiAdapter` previously used a
  bare `fetch()` with no TLS configuration at all, so a self-signed server
  certificate made every REST call (login, push/pull ticket issuance, repo/
  branch/merge/log/diff/roles/sync-prefs) fail with
  `TypeError: self signed certificate`. They now accept a CA cert path and
  optional TLS server name override, passed through Bun's native
  `fetch(url, { tls })` option — trusting only this specific certificate,
  for only Deltix's own HTTP calls, instead of disabling TLS validation
  process-wide.

### Added

- **Automatic certificate bootstrap in `deltix configure`.** When the
  configured server URL is `https://`, `configure` now offers to fetch the
  server's certificate directly (a raw TLS handshake, the same approach
  `openssl s_client`/browsers use to show you a cert before you decide to
  trust it) instead of requiring a manual `scp`/`ssh cat` off the server.
  The fingerprint, subject, issuer, and expiry are shown for explicit
  confirmation — nothing is trusted automatically — before being saved to
  `~/.deltix/trusted-server.crt` and reused for both HTTP and gRPC (both
  normally share one certificate in a standard install). Declining falls
  back to the previous manual CA-path prompt.
- **`DELTIX_HTTP_TLS_CA_PATH`/`DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE`** env
  vars, mirroring the existing `DELTIX_GRPC_TLS_*` ones for the HTTP side.
  Both fall back to their gRPC counterparts when not set explicitly, since
  a standard deployment presents the same certificate on both ports.

87/87 tests (11 new), lint clean, 0 vulnerabilities (`bun audit`). Verified
end-to-end against a real self-signed HTTPS test server: certificate fetch,
confirmation, and a subsequent HTTPS call succeed with
`NODE_TLS_REJECT_UNAUTHORIZED` left at its secure default.

## [0.3.0] - 2026-08-27

**In plain terms:** connecting to a server on a non-default machine used to
require knowing which environment variables to set — including one that's
easy to miss and causes a confusing crash (`servername ... IP address ...
not permitted`) if your server is reached by IP rather than a name. There's
now a guided setup command that asks the right questions and remembers your
answers.

### Added

- **`deltix configure`**: a new interactive command that prompts for the
  server's REST URL, gRPC host/port, and (when needed) TLS trust settings,
  and saves them to `~/.deltix/config.json`. When the gRPC host looks like
  an IP address, it explains why a TLS server name override is required and
  prompts for it directly — this is the exact fix for the
  `ERR_INVALID_ARG_VALUE`/SNI-on-IP-address crash reported in production.
  Explicit environment variables still always take precedence over this
  saved configuration.

## [0.2.4] - 2026-08-27

**In plain terms:** added a simple way to check "what version am I
running?" — type `deltix version` and it shows both the CLI's version and
the server's version side by side.

### Added

- `deltix version` (aliases `--version`, `-v`): prints the client's own
  version/commit, then best-effort queries the connected Deltix-Server's
  `GET /status` for its version/commit/environment. Never fails the command
  just because the server happens to be unreachable — the client's own
  version is still reported, with an "unreachable" note for the server.

### Tests

- Added unit coverage for `getClientBuildInfo()`.
- Extended the CLI session smoke test to cover `deltix version` against a
  real running server and against an unreachable one.

## [0.2.3] - 2026-08-27

### Changed

- **Command output is now human-readable instead of raw JSON log lines.**
  Every CLI command previously routed its result through the Pino
  structured logger, so a normal `deltix repo list` or `deltix log` printed
  a raw `{"level":30,...}` JSON blob — technically correct but unusable for
  a human typing commands interactively. Added `src/cli/output.ts` (built on
  `consola`) with `printSuccess`/`printInfo`/`printError`/`printKeyValues`/
  `printTable` helpers, and refactored all 12 CLI subcommands in
  `src/cli/index.ts` to use it. Structured Pino logging (`shared/logger.ts`)
  is unchanged and still available for any future diagnostic-only logging
  need — this is purely a presentation-layer change with no effect on the
  session/versioning/dataflow contexts or their public APIs.
- Lists (`repo list`, `branch list`, `roles list`) now render as plain
  aligned tables; single-record results (`repo get`, `sync-prefs get`)
  render as `key: value` lines; success/failure now use clear
  color-coded prefixes instead of a JSON `msg` field.

### Fixed

- **`sync-prefs dry-run` ignored the previously saved sync-preference
  mode**, always forcing `schema_and_data` even when the repo had an
  explicit `schema_only` preference stored — risking an unexpected
  full-data dry-run preview against a repo intentionally configured for
  schema-only sync. The command now reads the stored preference first and
  only falls back to `schema_and_data` when nothing has been saved yet.

## [0.2.2] - 2026-08-27

### Fixed

- **Critical: `push`/`pull` crashed with `ENOENT ... proto/transfer.proto` in the
  compiled binary release.** The gRPC transfer client resolved the `.proto`
  file via a source-tree-relative path (`join(import.meta.dir, '..', '..',
  'proto', 'transfer.proto')`). `bun build --compile` only embeds JS/TS module
  code automatically — it does not bundle arbitrary asset files referenced
  this way — so the path only ever resolved when running via `bun run` from
  inside the repository, and always failed when the compiled binary was run
  from anywhere else (exactly what pilot users hit on Windows, e.g.
  `B:/proto/transfer.proto`). Fixed by switching to Bun's
  `import PROTO_PATH from '../../proto/transfer.proto' with { type: 'file' }`
  syntax, which embeds the file into the binary at compile time and resolves
  to a real path at runtime (including inside the compiled binary's virtual
  filesystem). Added a regression smoke test that compiles a real binary and
  runs a full login/push/pull round-trip from a clean directory with no
  `proto/` folder on disk, to prevent this class of bug from silently
  regressing again.

## [0.2.1] - 2026-08-27


### Fixed

- **Critical: compiled binary crash on default settings.** `pino`'s
  `transport: { target: 'pino-pretty' }` resolves the target module by string
  in a worker thread at runtime, which fails inside a `bun build --compile`
  binary (no `node_modules` on disk to resolve against) — the CLI crashed
  immediately with `"unable to determine transport target for pino-pretty"`
  unless `LOG_PRETTY=false` was set. Fixed by passing a `pino-pretty` stream
  directly to `pino()` instead of using `transport`; `pino-pretty` moved from
  `devDependencies` to a real runtime `dependency`.

### Added

- `deltix repo create|list|get` CLI commands — previously the `versioning`
  service supported repo provisioning but no CLI command exposed it, so a
  user could never actually provision a repo from the client (a prerequisite
  for push/pull to work at all).

## [0.2.0] - 2026-08-27

### Added

- New `versioning` bounded context and ACL adapter providing CLI parity with
  Deltix-Server's Fase 5 REST API:
  - `deltix branch list|create|checkout|delete|current <repo>`
  - `deltix merge <repo> <sourceBranch> [targetBranch]`
  - `deltix log <repo> [--branch=name] [--limit=N]`
  - `deltix diff <repo> <from> <to>`
  - `deltix roles list|grant|revoke <repo> ...`
  - `deltix sync-prefs get|set|dry-run <repo> ...`
- Integration and smoke tests that boot a real Deltix-Server subprocess and
  exercise the new CLI commands end-to-end.

### Changed

- Dependabot-managed CI action version bumps (`docker/*`,
  `actions/upload-artifact`).

## [0.1.0] - Fase 1-4

- Initial scaffolding, session CLI (`login`/`logout`/`whoami`), gRPC transfer
  client (push/pull), heartbeat/keep-alive, embedded MySQL and binary-manager
  contexts.
