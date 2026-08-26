/**
 * Placeholder for the "session" bounded context.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside (e.g. `contexts/session/some-internal-file`).
 *
 * Implementation lands in Fase 2 of the roadmap (`deltix auth login` /
 * `deltix auth logout`, refresh token storage in
 * `~/.deltix/credentials.json`).
 */
export {};
