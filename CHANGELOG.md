# Changelog

All notable changes to Deltix-Client are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
