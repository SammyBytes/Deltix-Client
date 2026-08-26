/**
 * Sliding-window heartbeat: keeps an active gRPC transfer ticket alive
 * during a long-running Push/Pull by calling the server's Heartbeat RPC
 * roughly every `intervalMs` (default 30s, comfortably below the ticket's
 * TTL). Started when a transfer begins and stopped as soon as it finishes
 * (success or failure) — never left running unattended.
 *
 * Deliberately decoupled from `dataflow`'s push/pull orchestration so it
 * can be unit tested with a fake ticket-renewal function, without a live
 * gRPC connection.
 */
export interface HeartbeatHandle {
  stop(): void;
}

export function startHeartbeat(
  renew: () => Promise<number>,
  intervalMs: number,
  onError: (err: unknown) => void,
): HeartbeatHandle {
  const timer = setInterval(() => {
    renew().catch(onError);
  }, intervalMs);
  // Never keep the CLI process alive just for the heartbeat timer.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
