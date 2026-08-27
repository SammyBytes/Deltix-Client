# Copilot Instructions — Deltix-Client

Deltix-Client is the **Developer CLI** for Deltix, a Git-style version-control system for
relational database schemas and data. This file is the authoritative engineering contract for
any human or AI agent (including GitHub Copilot) writing code in this repository. When in doubt,
prefer the rule stated here over a generic "best practice" you might otherwise apply.

Licensed under the **MIT License** — open source, optimized for maximum adoption. See
[`LICENSE`](../LICENSE).

---

## 1. Product guardrails (non-negotiable)

1. **The client never decides final permissions.** It never assumes access to an Add-on or
   repository without a signed response from Deltix-Server. Any "can I do X" decision is
   resolved server-side; the client only presents the server's answer.
2. **The client never stores private keys, license keys, or corporate secrets.** It may persist
   a refresh token (`~/.deltix/credentials.json`) for its own session — nothing else
   security-sensitive lives on disk unencrypted-by-default without explicit justification.
3. **The client never writes to the NAS or any network storage volume directly.** All data
   movement happens exclusively over the gRPC contract with Deltix-Server.
4. **Dolt is a black-box binary.** The `binary-manager` context downloads and hash-verifies
   official precompiled Dolt binaries into `~/.deltix/bin/`; it never builds Dolt from source.
5. **No dependency on a pre-installed MySQL service.** The `mysql-embedded` context manages a
   local `dolt sql-server` process instead.
6. **Ephemeral gRPC tickets are short-lived and renewed by heartbeat (sliding window)** — the
   client's `heartbeat` context is responsible for keeping a transfer session alive, not for
   requesting a longer fixed TTL.

## 2. Architecture: modular monolith, NOT clean/hexagonal architecture

- Modular monolith organized by **bounded contexts** under `src/contexts/*` (`session`,
  `binary-manager`, `mysql-embedded`, `dataflow`, `heartbeat`, ...). No ports/adapters layering,
  no use-case/interactor classes, no repository-pattern abstractions unless a context genuinely
  needs to swap an implementation.
- **Each context exposes exactly one public surface: its `index.ts` barrel.** Nothing outside a
  context may import `contexts/<name>/<anything-else>`. This is the ACL boundary.
- **Cross-context or cross-system integration goes through `src/acl/`** — e.g., an adapter that
  talks to the Deltix-Server REST/gRPC API, or shells out to the `dolt`/binary-managed
  executable. Business logic never lives in an ACL adapter.
- **`src/shared/`** holds only truly cross-cutting, context-agnostic code (env validation,
  logger factory). Context-specific helpers stay inside their context.
- **`src/cli/`** is presentation only: parses arguments/flags and calls into a context's public
  API. No business logic in command handlers.
- No dependency cycles between contexts.

## 3. What NOT to do

- No speculative abstractions, no generic `Repository<T>`/`Service<T>` base classes, no DI
  container for a CLI this size.
- No business logic inside command handlers (`src/cli/*`) — parse input, call the context,
  format output. Nothing else.
- No line-by-line comments explaining obvious code. Comment only the *why* when non-obvious
  (a workaround, a security decision). Prefer clear naming over comments.
- No hardcoded secrets/keys/URLs. Configuration comes from validated env vars or config files,
  never inline literals in source.
- No premature performance optimization, but also no needlessly blocking/synchronous I/O
  during large transfers (see §6).
- No adding a dependency "just in case." Every dependency must pass the vetting process in §7.

## 4. Security — OWASP Top 10 (2021) & OWASP ASVS

Even as a client, this CLI must be held to the same discipline as the server it talks to:

- **A01 Broken Access Control**: never cache or assume a permission decision locally beyond a
  short-lived signed ticket's validity; always let the server be the final authority.
- **A02 Cryptographic Failures**: verify binary hashes (Dolt downloads) using a strong,
  well-known algorithm (e.g. SHA-256) via `node:crypto` (Bun-compatible) — never trust an
  unverified download.
- **A03 Injection**: when shelling out to `dolt` or `git`, always pass arguments as an argv
  array — never build a shell command string via concatenation with user/repo-derived input.
- **A04 Insecure Design**: fail closed — if a signature/hash/handshake step is inconclusive,
  abort the operation with a clear error rather than proceeding.
- **A05 Security Misconfiguration**: validate all config/env at startup (`src/shared/env.ts`);
  never ship a default that silently disables a security check.
- **A06 Vulnerable and Outdated Components**: see §7.
- **A07 Identification and Authentication Failures**: store the refresh token with restrictive
  file permissions; never log it; support explicit `logout` that revokes/clears it locally.
- **A08 Software and Data Integrity Failures**: verify the Dolt binary's hash/signature before
  execution; never run a downloaded artifact you haven't verified.
- **A09 Security Logging and Monitoring Failures**: log auth/transfer failures with actionable
  context, but never log tokens, secrets, or full file contents.
- **A10 Server-Side Request Forgery**: not typically applicable client-side, but any URL the
  CLI fetches (e.g. binary download mirrors) must come from a trusted, pinned source — never
  from arbitrary user input without validation.

## 5. Privacy-by-design

- Data minimization: only persist what's needed to operate (refresh token, local config) —
  no telemetry/usage analytics without explicit, documented opt-in.
- No PII in logs.
- Restrictive file permissions for `~/.deltix/credentials.json` and any cached binaries/config.
- Encrypt/transmit over TLS for any network call introduced in later phases.

## 6. Performance

- Avoid blocking I/O in the interactive command path; prefer Bun's async APIs.
- Stream large data transfers (Fase 3 `dataflow`) instead of buffering entire payloads.
- Keep the CLI startup path (`src/cli/index.ts`) lightweight — developers run it constantly.

## 7. Dependency management — mandatory vulnerability vetting

Same process as Deltix-Server:

1. Check the exact version against OSV.dev/GitHub Advisory Database before adding it.
2. Pin the exact version in `package.json` (no `^`/`~`).
3. Record the check in the introducing commit/PR.
4. Run `bun audit` (and `bun audit --fix` where applicable) before merging.

Currently vetted dependencies (0 known vulnerabilities as of introduction):

| Package | Exact version | Purpose |
|---|---|---|
| `zod` | `4.4.3` | Runtime validation of env vars/config at boot |
| `pino` | `10.3.1` | Structured logging |
| `pino-pretty` (dev) | `13.1.3` | Human-readable logs in local development |
| `@biomejs/biome` (dev) | `2.5.10` | Lint + format |

## 8. Logging (Pino)

- Use `createLogger(contextName)` from `src/shared/logger.ts` — never instantiate Pino
  directly, never use `console.log` in application code.
- One child logger per bounded context.
- Configurable via env, validated by `src/shared/env.ts`: `LOG_LEVEL`
  (`trace|debug|info|warn|error|fatal`, default `info`) and `LOG_PRETTY` (default `true` for
  this CLI, since its primary consumer is a human terminal — set `false` to emit JSON, e.g.
  when wrapped by another tool).
- Redaction is automatic for known sensitive field names (token, password, license/signature
  fields) — extend the redact list in `src/shared/logger.ts` rather than renaming a field to
  dodge it.

## 9. Bun-specific conventions

- Target Bun `>=1.3`, developed against Bun 1.4.0.
- Use `bun:test` for all tests. Use `Bun.file`/`Bun.$` over Node's `fs`/`child_process` where a
  Bun-native API exists.
- Final packaging uses `bun build --compile` to produce single native binaries for
  Windows/Linux (Fase 5) — keep `src/cli/index.ts` side-effect-light so it stays
  compile-friendly.

## 10. Testing — TDD is mandatory, three tiers

- Red-green-refactor: failing test first, minimal implementation, then refactor.
- Three tiers, all `bun:test`:
  - `tests/unit/**`: fast, no network, no real subprocess/binary calls.
  - `tests/integration/**`: exercises real collaborators where it matters (e.g., a real
    downloaded/staged binary, a real local `dolt sql-server` process in later phases).
  - `tests/smoke/**`: runs the actual CLI end-to-end and asserts observable behavior/exit codes.
- A phase branch does not merge into `main` unless all three tiers are green, plus
  `bun run lint` and `bun audit` report no new issues.

## 11. Licensing hygiene

- This repository is MIT. **Never copy code from Deltix-Server (BSL 1.1) or vice versa** — the
  only integration point between the two is the network contract (REST/gRPC), never shared
  source files or a shared package.
- Any third-party code included here must have a license compatible with MIT redistribution.

## 12. Branching model

- **Trunk-based.** `main` always holds a working, tested state.
- One branch per roadmap phase, merged into `main` only when its full test suite is green.
- Roadmap: (1) Cryptography & Licensing is server-only — this repo starts contributing from
  (2) REST Control Plane & Auth (session login/logout) → (3) Ephemeral Tickets & gRPC data flow
  + heartbeat → (4)/(5) follow the server's Add-on/packaging phases as needed on the client side.

## 13. CHANGELOG conventions

- Every release entry starts with a short **"In plain terms:"** summary in everyday language —
  written so someone with no engineering background can understand what changed and why it
  matters, before any technical detail follows.
- Keep the plain-language summary to 2-4 sentences, no jargon, no code identifiers.
- Technical detail still follows below it, under the normal Keep a Changelog sections
  (`### Added`/`### Fixed`/etc.) — the plain summary supplements the technical detail, it never
  replaces it.
