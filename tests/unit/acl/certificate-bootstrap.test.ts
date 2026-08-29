import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import {
  CertificateFetchError,
  fetchServerCertificate,
} from '../../../src/acl/certificate-bootstrap';

/**
 * Exercises `fetchServerCertificate()` against a real self-signed TLS
 * server (no mocking of `node:tls`) — this is the exact scenario the
 * function exists for: bootstrapping trust for a Deltix-Server instance
 * using a self-signed certificate, without requiring the operator to
 * manually copy the `.crt` file off the box.
 */
describe('acl/certificate-bootstrap (integration, real self-signed TLS server)', () => {
  let dir: string;
  let keyPath: string;
  let certPath: string;
  let server: tls.Server;
  let port: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deltix-cert-bootstrap-'));
    keyPath = join(dir, 'server.key');
    certPath = join(dir, 'server.crt');

    const result = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,DNS:host-a.internal,IP:10.1.10.129',
      ],
      { stdio: 'pipe' },
    );
    if (result.status !== 0) {
      throw new Error(`openssl failed to generate a test certificate: ${result.stderr.toString()}`);
    }

    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    port = await new Promise<number>((resolve, reject) => {
      const srv = tls.createServer({ key, cert }, (socket) => socket.end());
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('expected an AddressInfo from server.listen()'));
          return;
        }
        resolve(address.port);
      });
      server = srv;
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('fetches the self-signed certificate and returns its PEM and fingerprint', async () => {
    const result = await fetchServerCertificate('127.0.0.1', port);

    expect(result.pem).toContain('-----BEGIN CERTIFICATE-----');
    expect(result.pem).toContain('-----END CERTIFICATE-----');
    expect(result.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(result.subject).toBe('localhost');
    // DNS-style SANs are surfaced so `deltix configure` can suggest the right
    // server-name override; IP SANs are not DNS names and must not appear.
    expect(result.dnsNames).toContain('localhost');
    expect(result.dnsNames).toContain('host-a.internal');
    expect(result.dnsNames).not.toContain('10.1.10.129');
  });

  it('rejects with CertificateFetchError when nothing is listening on the port', async () => {
    // Grab a free port, then immediately release it so nothing is bound there.
    const freePort = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => {
          if (address === null || typeof address === 'string') {
            reject(new Error('expected an AddressInfo'));
            return;
          }
          resolve(address.port);
        });
      });
    });

    await expect(fetchServerCertificate('127.0.0.1', freePort, 1_000)).rejects.toThrow(
      CertificateFetchError,
    );
  });

  it('rejects with CertificateFetchError on a connection timeout to an unreachable host', async () => {
    // TEST-NET-1 (RFC 5737): reserved for documentation, guaranteed to not
    // respond, giving a deterministic timeout instead of a flaky network
    // dependency.
    await expect(fetchServerCertificate('192.0.2.1', 9, 300)).rejects.toThrow(
      CertificateFetchError,
    );
  });
});
