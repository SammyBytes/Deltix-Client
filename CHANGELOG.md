# Changelog

All notable changes to Deltix-Client are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry starts with a **plain-language summary** (what changed, in
everyday words) before any technical detail — written so someone outside
engineering can understand what shipped and why it matters.

## [Unreleased]

**In plain terms:** the CLI now manages its own local copy of the Dolt
database-engine binary, downloading and verifying it automatically into your
home folder the first time it's needed. This is the foundation for running a
local Deltix repo (`deltix start`) and, later in the same roadmap, committing
and pushing your data straight from your machine.

### Added

- **`binary-manager` context.** First known-good step of the
  `mysql-embedded` roadmap. `BinaryManager#ensureInstalled()` resolves a Dolt
  binary following, in order: `DELTIX_DOLT_BIN_PATH`, a matching `dolt` on
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

### Security

- Only an **unmodified official Dolt release artifact** is ever used — never
  compiled, patched, or altered locally — and its on-disk SHA-256 is
  re-verified before every run, so a tampered or corrupted binary is refused
  and reinstalled instead of trusted.

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
