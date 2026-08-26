/**
 * Placeholder for the "mysql-embedded" bounded context.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 *
 * Implementation lands in Fase 2 of the roadmap: `deltix start` manages the
 * local `dolt sql-server` process on `127.0.0.1:3306` — zero dependency on a
 * pre-installed MySQL service on the host.
 */
export {};
