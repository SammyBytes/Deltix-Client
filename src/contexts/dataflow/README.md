# Context: dataflow

Status: placeholder — implementation scheduled for Fase 3 of the roadmap: thin
wrappers around `init`, `clone`, `checkout`, `commit`, `push` and `pull`, using
the ephemeral gRPC ticket obtained from the `session` context.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).
