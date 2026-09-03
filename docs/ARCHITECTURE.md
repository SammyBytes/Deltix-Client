# Architecture — Deltix-Client

> One paragraph: Deltix-Client is a CLI that versions MySQL databases with Dolt. Daily flow is `deltix status → commit → push` against `dolt sql-server` on `:3307` (MySQL wire). No local DB of its own — state lives in filesystem (`~/.deltix/`) and in Dolt. Everything else is detail.

## Layers — high cohesion, low coupling

```
cli/        → parsing + delegation, no logic (thin layer)
  ↓
ports/      → interfaces (what I need, not how)
  ↓
core/       → pure functions, no I/O (parse, validate, map)
adapters/   → one impl per port (how)
contexts/   → stateful orchestration, uses ports (never adapters directly)
```

**Rule:** `contexts/` depends on `ports/`, never on `adapters/` or `mysql2`/`runDoltCommand`. Change `DoltMysql ↔ DoltCli` without touching `contexts/`.

## Ports (abstractions)

- `DoltSqlPort` — `query<T>(sql)`, `exec(sql)`, `call(proc, args)`. Two adapters: `DoltMysqlAdapter` (wire `mysql2` to `:3307`, fast) and `DoltCliAdapter` (`dolt sql -q`, fallback).
- `LocalRepoPort` — `getStatus()`, `listBranches()`, `createBranch()`, `checkout()`, `mergeBranches()`. Lives in `contexts/versioning-local`, talks via `DoltSqlPort`.
- `ServerPort` — `pushCommits()`, `pullCommits()`, `listBranches()` remote. Adapter `RestAdapter` (today `VersioningApiAdapter`).

If you later need `bun:sqlite` for cache, add `SqliteAdapter implements DoltSqlPort` — no `context` changes.

## Bounded contexts — one idea each

| Context | Single responsibility | State |
|---|---|---|
| `config` | `~/.deltix/config.json` + env vars | file |
| `local-project` | `.deltix/config.toml` binding | file |
| `binary-manager` | `dolt` binary pinned `2.3.1` | file + cache |
| `mysql-embedded` | `dolt sql-server` lifecycle (`:3307`) | process + `~/.deltix/run/*.json` |
| `versioning-local` | `dolt_status`, branches, commit, diff local | Dolt repo |
| `versioning` | REST parity with server | HTTP |
| `session` | JWT login/refresh | file 0600 |
| `import` | MySQL → Dolt bulk load | transient |

No context reads another context's state. If it needs it, it asks a `Port`.

## Daily flow (no repeated `import`)

```
# setup once
deltix init repo && deltix start        # :3307
# .env: DATABASE_URL=mysql://root@127.0.0.1:3307/repo
deltix import --from mysql://...:3306/db # optional, once

# daily — 100% deltix
deltix status              # via LocalRepoPort → DoltSqlPort (wire 50ms)
deltix diff                # dolt diff --stat local
deltix branch create <b>   # LocalRepoPort
deltix checkout <b>        # stop → dolt checkout → start (global)
deltix commit -m "msg"     # dolt add -A + commit
deltix merge <src>         # LocalRepoPort
deltix push / pull         # ServerPort
```

## Conventions

- `kebab-case` files, `PascalCase` ports, `camelCase` functions.
- One bounded context = `src/contexts/<name>/` with `*.service.ts` + `*.port.ts` + `*.errors.ts` + `*.test.ts`.
- `core/` is pure functions only, zero `import` from `contexts/` or `adapters/`.
- Tests mock `Port`, not `Adapter`.
- `Biome` + `strict:true` + `noUnused`.

## Why no local DB (Turso / bun:sqlite)

Not needed. The client stores no tables — Dolt is the DB. Adding `libsql` brings native bindings that break `bun build --compile` cross-OS with no benefit. If offline cache is ever needed, it will be `BunSQLiteAdapter implements DoltSqlPort`, not Turso.
