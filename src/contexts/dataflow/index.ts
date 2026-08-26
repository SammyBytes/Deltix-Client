/**
 * Placeholder for the "dataflow" bounded context.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 *
 * Implementation lands in Fase 3 of the roadmap: thin wrappers around
 * `init`, `clone`, `checkout`, `commit`, `push` and `pull`, using the
 * ephemeral gRPC ticket obtained from the `session` context.
 */
export {};
