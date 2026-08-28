# Deltix-Client

[![CI](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/actions/workflows/ci.yml)
[![Release](https://github.com/SammyBytes/Deltix-Client/actions/workflows/release.yml/badge.svg)](https://github.com/SammyBytes/Deltix-Client/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Developer CLI for **Deltix** — Git-style version control for relational database schemas and data.

> Licensed under the **MIT License**. See [`LICENSE`](./LICENSE).

## What this is

Deltix-Client is a lightweight Bun/TypeScript CLI that:
- Provides intuitive terminal commands (`deltix login`, `deltix logout`, `deltix whoami`,
  `deltix push`, `deltix pull`, `deltix branch ...`, `deltix merge`, `deltix log`, `deltix diff`,
  `deltix roles ...`, `deltix sync-prefs ...`).
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
- `config`: `deltix configure` interactive connection setup, persisted to `~/.deltix/config.json`.
- `session`: `deltix login`/`logout`/`whoami`, local credential storage, JWT refresh handling.
- `dataflow`, `heartbeat`: gRPC Push/Pull client + keep-alive against the Deltix-Server transfer
  engine.
- `versioning`: Fase 5 REST API parity for repo provisioning, branches, merge, log/diff, roles,
  and sync preferences.
- `binary-manager`, `mysql-embedded`: placeholders reserved for a future roadmap phase.


## CLI usage

### First-time setup

Run `deltix configure` once to set up how the CLI reaches your Deltix-Server (REST URL, gRPC
host/port, and TLS trust options), instead of hand-setting environment variables:

```bash
deltix configure
```

If your server is reached by IP address rather than a hostname (e.g. `10.1.10.129`), the
prompt will ask for a TLS server name override — this avoids the
`ERR_INVALID_ARG_VALUE: The property 'options.servername' ... is not permitted` crash that
occurs because TLS's SNI mechanism doesn't allow IP addresses as server names. Use the same
name the server's certificate was issued for (`localhost` if you generated it with
Deltix-Server's `bun run tls:server-cert` script). Settings are saved to
`~/.deltix/config.json` and act only as *defaults* — any `DELTIX_*` environment variable you
set explicitly always takes precedence.

**Self-signed server certificates**: if `deltix configure` detects an `https://` server URL, it
offers to fetch the server's certificate automatically instead of requiring you to copy a
`.crt` file off the server by hand (`scp`/`ssh cat`, which commonly hits path or `sudo`/TTY
friction). This works the same way SSH handles host keys (Trust-On-First-Use): the CLI connects,
shows the certificate's SHA-256 fingerprint and subject/issuer, and only trusts it after you
explicitly confirm the fingerprint matches what the server operator shared with you (e.g. from
`install.sh`'s summary output). The confirmed certificate is saved to
`~/.deltix/trusted-server.crt` and reused for **both** the REST API and the gRPC transfer engine
— in a typical deployment both present the same certificate, so you only do this once. Decline
the auto-fetch (or answer "no" to the trust prompt) to fall back to entering a `.crt` path
manually.

### Versioning parity with Deltix-Server Fase 5

```bash
deltix branch list <repo>
deltix branch create <repo> <name>
deltix branch checkout <repo> <name>
deltix branch delete <repo> <name>
deltix branch current <repo>
deltix merge <repo> <sourceBranch> [targetBranch]
deltix log <repo> [--branch=name] [--limit=N]
deltix diff <repo> <from> <to>
deltix roles list <repo>
deltix roles grant <repo> <username> <reader|writer|admin>
deltix roles revoke <repo> <username>
deltix sync-prefs get <repo>
deltix sync-prefs set <repo> <schema-only|schema-and-data> [tables...]
deltix sync-prefs dry-run <repo> [tables...]
```

Examples:

```bash
deltix branch create analytics feature/backfill
deltix branch checkout analytics feature/backfill
deltix log analytics --branch=feature/backfill --limit=10
deltix diff analytics main feature/backfill
deltix merge analytics feature/backfill
deltix roles grant analytics bob writer
deltix sync-prefs set analytics schema-only customers orders
deltix sync-prefs dry-run analytics orders
```

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
No phase branch merges into `main` without unit, integration, and smoke tests passing. Fase 5 client parity now covers the server's versioning REST surface for branching, merge, history, repo ACLs, and sync preferences.
