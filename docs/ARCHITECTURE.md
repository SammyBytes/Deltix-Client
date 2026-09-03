# Arquitectura — Deltix-Client

> Un párrafo: Deltix-Client es un CLI que versiona bases MySQL con Dolt. El flujo diario es `deltix status → commit → push` contra `dolt sql-server` en `:3307` (wire MySQL). No hay DB local propia — el estado vive en filesystem (`~/.deltix/`) y en Dolt. Todo lo demás es detalle.

## Capas — alta cohesión, bajo acoplamiento

```
cli/        → parsing + delegación, sin lógica (capa fina)
  ↓
ports/      → interfaces (qué necesito, no cómo)
  ↓
core/       → funciones puras, sin I/O (parse, validate, map)
adapters/   → una implementación por puerto (cómo)
contexts/   → orquestación con estado, usa puertos (no adapters directo)
```

**Regla:** `contexts/` depende de `ports/`, nunca de `adapters/` ni de `mysql2`/`runDoltCommand` directo. Así cambias `DoltMysql ↔ DoltCli` sin tocar `contexts/`.

## Puertos (abstracciones)

- `DoltSqlPort` — `query<T>(sql)`, `exec(sql)`, `call(proc, args)`. Dos adapters: `DoltMysqlAdapter` (wire `mysql2` a `:3307`, rápido) y `DoltCliAdapter` (`dolt sql -q`, fallback).
- `LocalRepoPort` — `getStatus()`, `listBranches()`, `createBranch()`, `checkout()`, `mergeBranches()`. Vive en `contexts/versioning-local`, pero habla vía `DoltSqlPort`.
- `ServerPort` — `pushCommits()`, `pullCommits()`, `listBranches()` remoto. Adapter `RestAdapter` (hoy `VersioningApiAdapter`).

Si mañana querés `bun:sqlite` para cache, sería un `SqliteAdapter implements DoltSqlPort` — ningún `context` cambia.

## Bounded contexts — cada uno cabe en una idea

| Contexto | Responsabilidad única | Estado |
|---|---|---|
| `config` | `~/.deltix/config.json` + env vars | file |
| `local-project` | `.deltix/config.toml` binding | file |
| `binary-manager` | `dolt` binario pinned `2.3.1` | file + cache |
| `mysql-embedded` | `dolt sql-server` lifecycle (`:3307`) | process + `~/.deltix/run/*.json` |
| `versioning-local` | `dolt_status`, branches, commit, diff local | Dolt repo |
| `versioning` | REST parity con server | HTTP |
| `session` | JWT login/refresh | file 0600 |
| `import` | MySQL → Dolt bulk load | transient |

Un contexto no lee el estado de otro. Si lo necesita, pide un `Port`.

## Flujo diario (sin `import` repetido)

```
# setup una vez
deltix init repo && deltix start        # :3307
# .env: DATABASE_URL=mysql://root@127.0.0.1:3307/repo
deltix import --from mysql://...:3306/db # opcional, una vez

# diario — 100% deltix
deltix status              # via LocalRepoPort → DoltSqlPort (wire 50ms)
deltix diff                # dolt diff --stat local
deltix branch create <b>   # LocalRepoPort
deltix checkout <b>        # stop → dolt checkout → start (global, no per-conexión)
deltix commit -m "msg"     # dolt add -A + commit
deltix merge <src>         # LocalRepoPort
deltix push / pull         # ServerPort
```

## Convenciones — para no perderse

- `kebab-case` archivos, `PascalCase` ports, `camelCase` funciones.
- Un bounded context = `src/contexts/<name>/` con `*.service.ts` + `*.port.ts` + `*.errors.ts` + `*.test.ts`.
- `core/` solo funciones puras, 0 `import` a `contexts/` o `adapters/`.
- Tests mockean `Port`, no `Adapter`.
- `Biome` + `strict:true` + `noUnused`.

## Por qué no hay DB local (Turso / bun:sqlite)

No se necesita. El client no guarda tablas — Dolt es la DB. Añadir `libsql` traería bindings nativos que rompen `bun build --compile` cross-OS sin beneficio. Si algún día hace falta cache offline, será `BunSQLiteAdapter implements DoltSqlPort`, no Turso.
