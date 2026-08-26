# Context: session

Status: implemented (Fase 2).

Authenticates against Deltix-Server's REST auth API (`/api/v1/auth/*`) and manages the local
session lifecycle:

- `deltix login <username> <password>` — authenticates and stores the refresh token in
  `~/.deltix/credentials.json` (0600 permissions, override via `DELTIX_CREDENTIALS_PATH`).
- `deltix logout` — revokes the session server-side and clears local credentials (fail-safe:
  local credentials are cleared even if the server call fails).
- `deltix whoami` — reports the locally stored session status.

Public API (`index.ts`): `createSessionService`, `SessionService`, error classes
(`InvalidCredentialsError`, `NoActiveSessionError`, `ServerUnreachableError`).

Only `index.ts` from this folder may be imported by other contexts (ACL boundary). The HTTP
integration with Deltix-Server lives in `src/acl/auth-api-adapter.ts`, not here — this context
works with its own local types only.
