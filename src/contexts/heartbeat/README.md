# Context: heartbeat

Sliding-window keep-alive for gRPC transfer tickets: `startHeartbeat()` runs a
lightweight `setInterval` loop calling `renew()` (backed by
`GrpcTransferClient.heartbeat()`) roughly every `DELTIX_HEARTBEAT_INTERVAL_MS`
(default 30s), comfortably below the ticket's TTL (default 120s). Started by
`dataflow` at the beginning of a Push/Pull and always stopped when the
transfer finishes (success or failure) — never left running unattended.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).
