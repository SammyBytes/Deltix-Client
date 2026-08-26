/**
 * The "dataflow" bounded context: thin orchestration around Push/Pull
 * transfers over the Fase 3 gRPC Transfer Engine, using an ephemeral
 * ticket obtained from the `session` context's access token.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 */
export { createDataflowService } from './create-dataflow-service';
export type { PullResult, PushResult } from './dataflow.service';
export { DataflowService } from './dataflow.service';
export {
  ChecksumMismatchError,
  LocalFileNotFoundError,
  TicketAuthenticationError,
  TicketIssuanceError,
  TicketNotFoundOrInactiveError,
  TransferAbortedError,
} from './errors';
