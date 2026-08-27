# Deltix-Client

[![CI](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml)
[![Release](https://github.com/SammyBytes/Deltix-Client/actions/workflows/release.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Developer CLI for **Deltix** — Git-style version control for relational database schemas and data.

> Licensed under the **MIT License**. See [`LICENSE`](./LICENSE).

## What this is

Deltix-Client is a lightweight Bun/TypeScript CLI that:
- Provides intuitive terminal commands (`deltix login`, `deltix logout`, `deltix whoami`,
  `deltix push`, `deltix pull`, ...).
- Authenticates against the Deltix-Server REST API to obtain a short-lived (2 minute TTL) gRPC
  transfer ticket.
- Streams data fragments to the server's local staging area over mTLS gRPC and reports transfer
  progress, with heartbeats to keep long-running transfers alive.
- Validates arguments and local configuration before touching the network.

## What this is NOT

- It does **not** decide final permissions — it never assumes access to an Add-on or repository
  without a signed response from the server.
- It does **not** store private keys or corporate secrets — only a session refresh token, on disk
  with restrictive permissions.
- It does **not** write to NAS storage directly — it never touches network volumes; all data
  movement happens exclusively over gRPC to the server.

## Architecture

Modular monolith organized by **bounded contexts** under `src/contexts/*` (no clean/hexagonal
layering). See [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) for the
full set of engineering rules (architecture, security, licensing, testing, logging).

Contexts:
- `session`: `deltix login`/`logout`/`whoami`, local credential storage, JWT refresh handling.
- `dataflow`, `heartbeat`: gRPC Push/Pull client + keep-alive against the Deltix-Server transfer
  engine.
- `binary-manager`, `mysql-embedded`: placeholders reserved for a future roadmap phase.

## Development

Requires [Bun](https://bun.sh) `>=1.4`.

```bash
bun install
bun run lint     # Biome
bun test          # all tiers
bun run test:unit
bun run test:integration
bun run test:smoke
bun audit          # dependency vulnerability scan (also runs in CI)
```

## Installing / distribution

The CLI compiles to a single native binary (`bun build --compile`, no Bun runtime required on
the target machine). Two distribution paths:

- **Binary release** (recommended for interactive/human use): download the binary for your OS/
  arch from the [latest GitHub Release](https://github.com/SammyBytes/Deltix-Client/releases/latest)
  (Linux, macOS, Windows — x64 and arm64).
- **Container image** (for CI/automation running `deltix` from inside a pipeline):
  ```bash
  docker pull ghcr.io/sammybytes/deltix-client:latest
  docker run --rm ghcr.io/sammybytes/deltix-client:latest --help
  ```

Both are published automatically by `.github/workflows/release.yml` on every `vX.Y.Z` tag.

## Security

See [`SECURITY.md`](./SECURITY.md) for the supported version policy, vulnerability reporting
process (private, via GitHub Security Advisories), and this project's security baseline.

## Testing philosophy

TDD is mandatory: write the failing test first, then the minimal implementation, then refactor.
No phase branch merges into `main` without unit, integration, and smoke tests passing.
