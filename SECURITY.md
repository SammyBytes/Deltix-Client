# Security Policy

Deltix-Client is the CLI that authenticates against Deltix-Server and moves data over gRPC.
It handles session tokens locally — treat any report about credential handling seriously.

## Supported versions

Only the latest release/tag is supported with security fixes during the current pilot/pre-1.0
phase.

| Version         | Supported |
| --------------- | --------- |
| `main` (latest) | ✅        |
| Older tags      | ❌        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead:
1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, impact, and reproduction steps in as much detail as possible.

You should expect an initial response within **5 business days**.

## Scope

In scope:
- Session/credential storage (`src/contexts/session`) — token leakage, insecure file
  permissions, credential exposure in logs.
- Authentication flow against Deltix-Server (`deltix login`/`logout`/`whoami`).
- gRPC transport/TLS configuration for data transfer.
- Supply-chain issues in `package.json`/`bun.lock` dependencies.

Out of scope (report upstream instead):
- Vulnerabilities in Bun itself (report to [oven-sh/bun](https://github.com/oven-sh/bun)).
- Vulnerabilities in Deltix-Server itself — report those in the
  [Deltix-Server security tab](https://github.com/SammyBytes/Deltix-Server/security/advisories/new).

## Our security baseline

- The client never stores long-lived secrets or private keys — only a short-lived session
  refresh token, and only on disk with restrictive permissions.
- It never assumes authorization locally; every privileged action is validated server-side.
- Dependency vulnerabilities are checked with `bun audit` in CI on every push/PR, and Dependabot
  keeps dependencies patched automatically (see `.github/dependabot.yml`).
