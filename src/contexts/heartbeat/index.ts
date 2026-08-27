/**
 * The "heartbeat" bounded context: a background loop that pings the
 * server's gRPC Heartbeat RPC roughly every 30s to keep the sliding-window
 * transfer ticket alive during a long-running Push/Pull.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 */
export type { HeartbeatHandle } from './heartbeat.service';
export { startHeartbeat } from './heartbeat.service';
