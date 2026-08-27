# Changelog

All notable changes to Deltix-Client are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry starts with a **plain-language summary** (what changed, in
everyday words) before any technical detail — written so someone outside
engineering can understand what shipped and why it matters.

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
