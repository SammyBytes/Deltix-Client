import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrpcTransferClient } from '../../../src/acl/grpc-transfer-client';
import type { TransferTicketApiAdapter } from '../../../src/acl/transfer-ticket-api-adapter';
import { DataflowService } from '../../../src/contexts/dataflow/dataflow.service';
import {
  LocalFileNotFoundError,
  TransferAbortedError,
} from '../../../src/contexts/dataflow/errors';
import { NoActiveSessionError } from '../../../src/contexts/session/errors';
import type { SessionService } from '../../../src/contexts/session/session.service';

function fakeSessionService(overrides: Partial<SessionService> = {}): SessionService {
  return {
    mintAccessToken: async () => 'fake-access-token',
    ...overrides,
  } as SessionService;
}

function fakeTicketApi(
  overrides: Partial<TransferTicketApiAdapter> = {},
): TransferTicketApiAdapter {
  return {
    issueTicket: async (_token: string, operation: 'push' | 'pull', repo: string) => ({
      ticketId: 'ticket-1',
      operation,
      repo,
      expiresAt: Date.now() + 120_000,
    }),
    closeTicket: async () => undefined,
    ...overrides,
  } as TransferTicketApiAdapter;
}

function fakeGrpcClient(overrides: Partial<GrpcTransferClient> = {}): GrpcTransferClient {
  return {
    push: async () => ({ jobId: 'job-1', checksum: 'abc123', bytesReceived: 42 }),
    heartbeat: async () => Date.now() + 120_000,
    pullStream: () => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        emitter.emit('data', { data: Buffer.from('hello ') });
        emitter.emit('data', { data: Buffer.from('world') });
        emitter.emit('end');
      });
      return emitter as unknown as ReturnType<GrpcTransferClient['pullStream']>;
    },
    close: () => {},
    ...overrides,
  } as GrpcTransferClient;
}

describe('dataflow/dataflow.service (unit, fake adapters/clients)', () => {
  it('push() rejects with LocalFileNotFoundError when the local file does not exist', async () => {
    const service = new DataflowService(
      fakeSessionService(),
      fakeTicketApi(),
      fakeGrpcClient(),
      30_000,
    );

    await expect(service.push('org/repo', '/nonexistent/path/file.bin')).rejects.toThrow(
      LocalFileNotFoundError,
    );
  });

  it('push() mints a token, issues a ticket, streams the file, and closes the ticket on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-dataflow-push-'));
    const filePath = join(dir, 'repo.dolt');
    await writeFile(filePath, 'some repo bytes');

    let closedTicketId: string | undefined;
    const service = new DataflowService(
      fakeSessionService(),
      fakeTicketApi({
        closeTicket: async (_token: string, ticketId: string) => {
          closedTicketId = ticketId;
        },
      }),
      fakeGrpcClient(),
      30_000,
    );

    const result = await service.push('org/repo', filePath);

    expect(result).toEqual({ jobId: 'job-1', checksum: 'abc123', bytesSent: 42 });
    expect(closedTicketId).toBe('ticket-1');
    await rm(dir, { recursive: true, force: true });
  });

  it('push() closes the ticket even when the gRPC call fails, and wraps the error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-dataflow-push-fail-'));
    const filePath = join(dir, 'repo.dolt');
    await writeFile(filePath, 'some repo bytes');

    let ticketClosed = false;
    const service = new DataflowService(
      fakeSessionService(),
      fakeTicketApi({
        closeTicket: async () => {
          ticketClosed = true;
        },
      }),
      fakeGrpcClient({
        push: async () => {
          throw new Error('connection dropped');
        },
      }),
      30_000,
    );

    await expect(service.push('org/repo', filePath)).rejects.toThrow(TransferAbortedError);
    expect(ticketClosed).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('push() propagates NoActiveSessionError when there is no local session (never issues a ticket)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-dataflow-push-nosession-'));
    const filePath = join(dir, 'repo.dolt');
    await writeFile(filePath, 'bytes');

    let ticketIssued = false;
    const service = new DataflowService(
      fakeSessionService({
        mintAccessToken: async () => {
          throw new NoActiveSessionError();
        },
      }),
      fakeTicketApi({
        issueTicket: async () => {
          ticketIssued = true;
          return { ticketId: 'x', operation: 'push', repo: 'org/repo', expiresAt: 0 };
        },
      }),
      fakeGrpcClient(),
      30_000,
    );

    await expect(service.push('org/repo', filePath)).rejects.toThrow(NoActiveSessionError);
    expect(ticketIssued).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('pull() streams the remote bytes to the destination file and returns the checksum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-dataflow-pull-'));
    const destinationPath = join(dir, 'downloaded.dolt');

    const service = new DataflowService(
      fakeSessionService(),
      fakeTicketApi(),
      fakeGrpcClient(),
      30_000,
    );

    const result = await service.pull('org/repo', destinationPath);
    const written = await readFile(destinationPath, 'utf8');

    expect(written).toBe('hello world');
    expect(result.bytesReceived).toBe('hello world'.length);
    expect(result.checksum).toBeString();
    await rm(dir, { recursive: true, force: true });
  });

  it('pull() closes the ticket even when the stream errors out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deltix-dataflow-pull-fail-'));
    const destinationPath = join(dir, 'downloaded.dolt');

    let ticketClosed = false;
    const service = new DataflowService(
      fakeSessionService(),
      fakeTicketApi({
        closeTicket: async () => {
          ticketClosed = true;
        },
      }),
      fakeGrpcClient({
        pullStream: () => {
          const emitter = new EventEmitter();
          queueMicrotask(() => emitter.emit('error', new Error('stream reset')));
          return emitter as unknown as ReturnType<GrpcTransferClient['pullStream']>;
        },
      }),
      30_000,
    );

    await expect(service.pull('org/repo', destinationPath)).rejects.toThrow(TransferAbortedError);
    expect(ticketClosed).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
