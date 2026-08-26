# Deltix-Client

Developer CLI for **Deltix** — Git-style version control for relational database schemas and data.

> Licensed under the **MIT License**. See [`LICENSE`](./LICENSE).

## What this is

Deltix-Client is a lightweight Bun/TypeScript CLI that:
- Provides intuitive terminal commands (`deltix push`, `deltix auth login`, `deltix status`, ...).
- Authenticates against the Deltix-Server REST API to obtain a short-lived (2 minute TTL) gRPC ticket.
- Streams data fragments to the server's local staging area and reports transfer progress.
- Validates arguments and local `.toml` configuration files before touching the network.

## What this is NOT

- It does **not** decide final permissions — it never assumes access to an Add-on or repository
  without a signed response from the server.
- It does **not** store private keys or corporate secrets — only a refresh token locally.
- It does **not** write to NAS storage directly — it never touches network volumes; all data
  movement happens exclusively over gRPC to the server.

## Architecture

Modular monolith organized by **bounded contexts** under `src/contexts/*` (no clean/hexagonal
layering). See [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) for the
full set of engineering rules (architecture, security, licensing, testing, logging).

Current contexts: `session` (implemented, Fase 2 — `deltix login`/`deltix logout`/`deltix whoami`),
`binary-manager`, `mysql-embedded`, `dataflow`, `heartbeat` (placeholders until their roadmap
phase lands).

## Development

Requires [Bun](https://bun.sh) `>=1.3`.

```bash
bun install
bun run lint     # Biome
bun test          # all tiers
bun run test:unit
bun run test:integration
bun run test:smoke
```

## Testing philosophy

TDD is mandatory: write the failing test first, then the minimal implementation, then refactor.
No phase branch merges into `main` without unit, integration, and smoke tests passing.
