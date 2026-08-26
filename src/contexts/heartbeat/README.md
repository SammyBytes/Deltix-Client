# Context: heartbeat

Status: placeholder — implementation scheduled for Fase 3 of the roadmap: a
background loop that pings the server every 30s to keep the sliding-window
gRPC session alive during large transfers.

Only `index.ts` from this folder may be imported by other contexts (ACL boundary).
