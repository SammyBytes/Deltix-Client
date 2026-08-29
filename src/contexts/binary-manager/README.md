# Context: binary-manager

Black-box, hash-verified management of the local **Dolt** CLI binary used by
the other local contexts (`mysql-embedded`'s `dolt sql-server`, versioning's
`dolt commit`/`dolt push`).

Dolt is always consumed as an **unmodified official release artifact** — never
compiled, patched, or otherwise altered locally — and its on-disk integrity is
re-verified against a recorded SHA-256 before every single run.

## Resolution order

When the CLI needs a dolt binary, `BinaryManager#ensureInstalled()` resolves:

1. `DELTIX_DOLT_BIN_PATH` — explicit override (trusted as-is; CI/preinstalled).
2. A `dolt` on `PATH` reporting the pinned version.
3. An already-installed copy under `~/.deltix/bin/dolt-<ver>` that passes its
   recorded SHA-256 (trust-on-first-use, same model as `deltix configure`).
4. Otherwise: download the official release tarball over HTTPS, extract with
   `tar`, record its SHA-256 for future re-verification.

Only the pinned `DOLT_VERSION` is ever selected, so the client always speaks
the same Dolt on-disk format as Deltix-Server.

## Layout

```
~/.deltix/bin/
  dolt-2.3.1/bin/dolt     <- the executable
  dolt-2.3.1/.sha256      <- SHA-256 of ./bin/dolt (re-verified each run)
```

## ACL boundary

Only `index.ts` from this folder may be imported by other contexts. All actual
process spawning against external executables (`dolt`, `tar`, `which`) goes
through `src/acl/dolt-exec.ts`.
