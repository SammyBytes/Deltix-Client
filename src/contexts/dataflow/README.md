# Context: dataflow

Orchestrates a full Push or Pull transfer against Deltix-Server's Fase 3
gRPC Transfer Engine:

1. Mint a fresh access token via the `session` context (never persisted to
   disk — only the refresh token is stored).
2. Issue a scoped, single-use ephemeral ticket over REST
   (`POST /api/v1/push/ticket`), authenticated by that access token.
3. Open a real TLS gRPC stream (`acl/grpc-transfer-client.ts`) authenticated
   by the ticket, streaming the local file in Push, or the remote repo's
   synced bytes in Pull.
4. Keep the ticket's sliding window alive for the duration of the transfer
   via the `heartbeat` context.
5. Always close the ticket when the transfer finishes, success or failure.

Depends on `session` (access tokens) and `heartbeat` (keep-alive loop) only
through their public `index.ts` barrels — never their internals.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).
