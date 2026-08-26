/**
 * Placeholder for the "heartbeat" bounded context.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 *
 * Implementation lands in Fase 3 of the roadmap: a background loop that
 * pings the server every 30s to keep the sliding-window gRPC session alive
 * during large transfers.
 */
export {};
