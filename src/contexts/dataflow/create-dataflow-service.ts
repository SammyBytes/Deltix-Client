import { GrpcTransferClient } from '../../acl/grpc-transfer-client';
import { TransferTicketApiAdapter } from '../../acl/transfer-ticket-api-adapter';
import { loadEnv } from '../../shared/env';
import { createSessionService } from '../session';
import { DataflowService } from './dataflow.service';

export function createDataflowService(): DataflowService {
  const env = loadEnv();
  const sessionService = createSessionService();
  const ticketApi = new TransferTicketApiAdapter(env.DELTIX_SERVER_URL, {
    caCertPath: env.DELTIX_HTTP_TLS_CA_PATH,
    serverNameOverride: env.DELTIX_HTTP_TLS_SERVER_NAME_OVERRIDE,
  });
  const grpcClient = new GrpcTransferClient(env.DELTIX_GRPC_HOST, env.DELTIX_GRPC_PORT, {
    caCertPath: env.DELTIX_GRPC_TLS_CA_PATH,
    serverNameOverride: env.DELTIX_GRPC_TLS_SERVER_NAME_OVERRIDE,
  });
  return new DataflowService(
    sessionService,
    ticketApi,
    grpcClient,
    env.DELTIX_HEARTBEAT_INTERVAL_MS,
  );
}
