/**
 * Orchestrates a full Push or Pull transfer: mint a fresh access token via
 * the session context -> issue a scoped ephemeral ticket over REST -> open
 * a real TLS gRPC stream authenticated by that ticket -> keep the ticket's
 * sliding window alive via the heartbeat context while bytes are in
 * flight -> close the ticket once the transfer finishes (success or
 * failure — a ticket must never be left open past its transfer).
 *
 * No business logic lives in the CLI command handlers — it all lives here,
 * matching the `SessionService` pattern from Fase 2.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { GrpcTransferClient, PushSummary } from '../../acl/grpc-transfer-client';
import type { TransferTicketApiAdapter } from '../../acl/transfer-ticket-api-adapter';
import { startHeartbeat } from '../heartbeat';
import type { SessionService } from '../session';
import { ChecksumMismatchError, LocalFileNotFoundError, TransferAbortedError } from './errors';

export interface PushResult {
  jobId: string;
  checksum: string;
  bytesSent: number;
}

export interface PullResult {
  bytesReceived: number;
  checksum: string;
}

const CHUNK_SIZE = 64 * 1024;

export class DataflowService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly ticketApi: TransferTicketApiAdapter,
    private readonly grpcClient: GrpcTransferClient,
    private readonly heartbeatIntervalMs: number,
  ) {}

  async push(repo: string, localFilePath: string): Promise<PushResult> {
    const fileInfo = await stat(localFilePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      throw new LocalFileNotFoundError(localFilePath);
    }

    const accessToken = await this.sessionService.mintAccessToken();
    const ticket = await this.ticketApi.issueTicket(accessToken, 'push', repo);

    const heartbeat = startHeartbeat(
      () => this.grpcClient.heartbeat(ticket.ticketId),
      this.heartbeatIntervalMs,
      () => {
        // A failed heartbeat is surfaced by the eventual gRPC call failure
        // (the server fails-closed on an expired ticket) — nothing to do
        // here beyond not crashing the interval loop itself.
      },
    );

    try {
      const summary: PushSummary = await this.grpcClient.push(
        ticket.ticketId,
        repo,
        readFileChunks(localFilePath),
      );
      return { jobId: summary.jobId, checksum: summary.checksum, bytesSent: summary.bytesReceived };
    } catch (err) {
      throw new TransferAbortedError(err instanceof Error ? err.message : String(err));
    } finally {
      heartbeat.stop();
      await this.ticketApi.closeTicket(accessToken, ticket.ticketId).catch(() => {
        // Best-effort close: the ticket also self-expires via its sliding
        // window, so a failed close here is not a correctness issue.
      });
    }
  }

  async pull(repo: string, destinationFilePath: string): Promise<PullResult> {
    const accessToken = await this.sessionService.mintAccessToken();
    const ticket = await this.ticketApi.issueTicket(accessToken, 'pull', repo);

    const heartbeat = startHeartbeat(
      () => this.grpcClient.heartbeat(ticket.ticketId),
      this.heartbeatIntervalMs,
      () => {},
    );

    try {
      const stream = this.grpcClient.pullStream(ticket.ticketId, repo);
      const hash = createHash('sha256');
      let bytesReceived = 0;

      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(destinationFilePath);
        stream.on('data', (chunk: { data: Buffer }) => {
          hash.update(chunk.data);
          bytesReceived += chunk.data.length;
          out.write(chunk.data);
        });
        stream.on('end', () => out.end(resolve));
        stream.on('error', (err) => {
          out.destroy();
          reject(err);
        });
      });

      return { bytesReceived, checksum: hash.digest('hex') };
    } catch (err) {
      throw new TransferAbortedError(err instanceof Error ? err.message : String(err));
    } finally {
      heartbeat.stop();
      await this.ticketApi.closeTicket(accessToken, ticket.ticketId).catch(() => {});
    }
  }

  /**
   * Verifies a just-completed pull's checksum against the server's
   * PushSummary-equivalent (the caller supplies the expected checksum,
   * e.g. from a prior manifest or the storage API's dead-letter listing).
   */
  static assertChecksum(expected: string, actual: string): void {
    if (expected !== actual) {
      throw new ChecksumMismatchError();
    }
  }
}

async function* readFileChunks(path: string): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: CHUNK_SIZE });
  for await (const chunk of stream) {
    yield chunk as Uint8Array;
  }
}
