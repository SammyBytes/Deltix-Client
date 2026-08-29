/**
 * ACL adapter wrapping the raw `@grpc/grpc-js` client for Deltix-Server's
 * Fase 3 Transfer Engine (Push/Pull/Heartbeat), per `proto/transfer.proto`
 * (kept in sync with the server repo's copy — this is a network contract,
 * never shared code, per the MIT/BSL license separation rule).
 *
 * This is the ONLY module in the codebase allowed to know about grpc-js
 * or the wire shape of the proto messages; `contexts/dataflow` and
 * `contexts/heartbeat` only ever see the plain TS interfaces exported here.
 *
 * TLS is always required — the server has no plaintext code path, so this
 * client never offers an insecure credentials option either. When
 * `caCertPath` is omitted, the OS root store is trusted (appropriate for a
 * real CA-signed server certificate); pass it explicitly to trust a
 * self-signed dev/test certificate.
 */
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
// Bun's `with { type: 'file' }` import embeds the referenced file into a
// `bun build --compile` binary and resolves to a real on-disk path at
// runtime (inside Bun's virtual `/$bunfs/` fs for compiled binaries, or the
// real path during `bun run`/tests) -- a plain `join(import.meta.dir, ...)`
// path only works in dev, since compiled binaries have no `node_modules`/
// source tree on disk to resolve relative paths against.
import PROTO_PATH from '../../proto/transfer.proto' with { type: 'file' };

export interface GrpcClientTlsConfig {
  caCertPath?: string | undefined;
  /**
   * Overrides the TLS ServerName used for SNI/hostname verification.
   * Node's TLS stack rejects IP-address ServerNames outright, so this MUST
   * be set whenever `host` is an IP (e.g. `127.0.0.1`) and the server's
   * certificate was issued for a DNS name (our self-signed dev/test certs
   * use `CN=localhost`).
   */
  serverNameOverride?: string | undefined;
}

export interface PushSummary {
  jobId: string;
  checksum: string;
  bytesReceived: number;
}

interface TransferEngineClient extends grpc.Client {
  push(
    callback: (err: grpc.ServiceError | null, response?: unknown) => void,
  ): grpc.ClientWritableStream<unknown>;
  pull(request: { ticketId: string; repo: string }): grpc.ClientReadableStream<{ data: Buffer }>;
  heartbeat(
    request: { ticketId: string },
    callback: (err: grpc.ServiceError | null, response?: { newExpiresAt: string }) => void,
  ): void;
}

function loadTransferEngineDefinition() {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    deltix: { transfer: { v1: { TransferEngine: grpc.ServiceClientConstructor } } };
  };
  return proto.deltix.transfer.v1.TransferEngine;
}

/**
 * Normalizes the gRPC host into a form grpc-js will accept as a channel
 * target. A stray surrounding/embedded whitespace character — typically a
 * newline pasted into a `DELTIX_GRPC_HOST` env var or a config value — makes
 * grpc-js reject the whole target with `Could not parse target name`, so we
 * strip all whitespace. Exposed for testability.
 */
export function normalizeGrpcHost(host: string): string {
  return host.replace(/\s+/g, '');
}

export class GrpcTransferClient {
  private readonly client: TransferEngineClient;

  constructor(host: string, port: number, tls: GrpcClientTlsConfig = {}) {
    const TransferEngine = loadTransferEngineDefinition();
    const rootCerts = tls.caCertPath ? readFileSync(tls.caCertPath) : null;
    const credentials = grpc.credentials.createSsl(rootCerts);
    const channelOptions: grpc.ChannelOptions = tls.serverNameOverride
      ? { 'grpc.ssl_target_name_override': tls.serverNameOverride }
      : {};
    // Defensively strip surrounding/embedded whitespace from the host: a
    // stray newline (e.g. pasted into a DELTIX_GRPC_HOST env var or a config
    // value) would otherwise make grpc-js reject the whole target with
    // `Could not parse target name "host\n\n:port"`, which is never a
    // legitimate hostname character.
    const cleanedHost = normalizeGrpcHost(host);
    if (cleanedHost === '') {
      throw new Error('gRPC host must not be empty');
    }
    this.client = new TransferEngine(
      `${cleanedHost}:${port}`,
      credentials,
      channelOptions,
    ) as unknown as TransferEngineClient;
  }

  /**
   * Streams a local file to the server as a Push transfer, authenticated
   * by a previously-issued ticket. Resolves with the server's summary once
   * the whole file has been sent and acknowledged.
   */
  async push(
    ticketId: string,
    repo: string,
    fileBytes: AsyncIterable<Uint8Array> | Uint8Array[],
  ): Promise<PushSummary> {
    return new Promise((resolve, reject) => {
      const call = this.client.push((err, response) => {
        if (err) {
          reject(err);
          return;
        }
        const r = response as { jobId: string; checksum: string; bytesReceived: string };
        resolve({ jobId: r.jobId, checksum: r.checksum, bytesReceived: Number(r.bytesReceived) });
      });

      call.write({ header: { ticketId, operation: 'push', repo } });

      (async () => {
        try {
          for await (const chunk of fileBytes) {
            call.write({ chunk: { data: Buffer.from(chunk) } });
          }
          call.end();
        } catch (err) {
          call.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  }

  /** Streams the server's staged/synced copy of `repo` back, chunk by chunk. */
  pullStream(ticketId: string, repo: string): grpc.ClientReadableStream<{ data: Buffer }> {
    return this.client.pull({ ticketId, repo });
  }

  /** Renews the sliding-window expiry of an active ticket. Returns the new epoch-ms expiry. */
  async heartbeat(ticketId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client.heartbeat({ ticketId }, (err, response) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(Number(response?.newExpiresAt ?? 0));
      });
    });
  }

  close(): void {
    this.client.close();
  }
}
