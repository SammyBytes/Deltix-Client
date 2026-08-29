# Context: mysql-embedded

Lifecycle of a local **Dolt SQL server** (`dolt sql-server`) bound to
loopback — one process per local repo checkout — so a developer works against
a real MySQL-compatible Deltix database engine locally, with **zero
dependency on a pre-installed MySQL service** on the host.

## Commands

- `deltix start [repo]` — resolve a Dolt binary (via `binary-manager`), spawn
  `dolt sql-server --data-dir ~/.deltix/repos/<repo>` as a detached background
  process on `127.0.0.1:<port>`, wait for the port to accept connections, and
  record the run state.
- `deltix stop [repo]` — terminate the recorded PID and clear the run state.
- `deltix status [repo]` — report whether the recorded process is alive and
  its port is accepting connections (cleans up stale state for dead PIDs).

## Configuration

- `DELTIX_LOCAL_HOST` (default `127.0.0.1`) and `DELTIX_LOCAL_PORT` (default
  `3306`) — override when the host already runs a real MySQL service.
- `DELTIX_HOME` (default `~/.deltix`) — root for local state:
  - `~/.deltix/repos/<repo>/` — Dolt data directory (the `--data-dir`).
  - `~/.deltix/run/<repo>.json` — run state (PID, port, data dir, start time).
- `deltix configure` can persist `localPort` / `localDoltBinPath`.

## Integrity / ACL

- The Dolt binary is always resolved through the `binary-manager` context
  (hash-verified official artifact) — never guessed.
- All process spawning / shell-out lives in `src/acl/dolt-exec.ts`
  (`spawnBackgroundProcess`, `runDoltCommand`, ...).
- Only `index.ts` from this folder may be imported by other contexts.
