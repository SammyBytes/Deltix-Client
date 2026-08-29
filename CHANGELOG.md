# Changelog

All notable changes to Deltix-Client are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry starts with a **plain-language summary** (what changed, in
everyday words) before any technical detail — written so someone outside
engineering can understand what shipped and why it matters.

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
