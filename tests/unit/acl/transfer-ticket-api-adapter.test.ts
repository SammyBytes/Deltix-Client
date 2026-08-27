import { afterEach, describe, expect, it } from 'bun:test';
import { TransferTicketApiAdapter } from '../../../src/acl/transfer-ticket-api-adapter';
import {
  TicketAuthenticationError,
  TicketIssuanceError,
  TicketNotFoundOrInactiveError,
} from '../../../src/contexts/dataflow/errors';
import { ServerUnreachableError } from '../../../src/contexts/session/errors';

describe('acl/transfer-ticket-api-adapter (unit, mocked fetch)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('issueTicket() posts operation/repo with a bearer token and returns the parsed ticket', async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | null = null;
    let capturedBody: unknown;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).authorization;
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ ticketId: 't1', operation: 'push', repo: 'org/repo', expiresAt: 123 }),
        { status: 201 },
      );
    }) as typeof fetch;

    const adapter = new TransferTicketApiAdapter('http://127.0.0.1:9090');
    const result = await adapter.issueTicket('access-token', 'push', 'org/repo');

    expect(capturedUrl).toBe('http://127.0.0.1:9090/api/v1/push/ticket');
    expect(capturedAuth).toBe('Bearer access-token');
    expect(capturedBody).toEqual({ operation: 'push', repo: 'org/repo' });
    expect(result).toEqual({ ticketId: 't1', operation: 'push', repo: 'org/repo', expiresAt: 123 });
  });

  it('issueTicket() throws TicketAuthenticationError on a 401 response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })) as typeof fetch;

    const adapter = new TransferTicketApiAdapter('http://127.0.0.1:9090');

    await expect(adapter.issueTicket('bad-token', 'push', 'org/repo')).rejects.toThrow(
      TicketAuthenticationError,
    );
  });

  it('issueTicket() throws TicketIssuanceError on an unexpected non-2xx response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400,
      })) as typeof fetch;

    const adapter = new TransferTicketApiAdapter('http://127.0.0.1:9090');

    await expect(adapter.issueTicket('token', 'push', 'org/repo')).rejects.toThrow(
      TicketIssuanceError,
    );
  });

  it('issueTicket() wraps a network failure in ServerUnreachableError', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const adapter = new TransferTicketApiAdapter('http://127.0.0.1:9090');

    await expect(adapter.issueTicket('token', 'push', 'org/repo')).rejects.toThrow(
      ServerUnreachableError,
    );
  });

  it('closeTicket() posts the ticketId with a bearer token and resolves on 200', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const adapter = new TransferTicketApiAdapter('http://127.0.0.1:9090');
    await adapter.closeTicket('token', 't1');

    expect(capturedUrl).toBe('http://127.0.0.1:9090/api/v1/auth/session-close');
    expect(capturedBody).toEqual({ ticketId: 't1' });
  });

  it('closeTicket() throws TicketNotFoundOrInactiveError on a 404 response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Ticket not found or not active' }), {
        status: 404,
      })) as typeof fetch;

    const adapter = new TransferTicketApiAdapter('http://127.0.0.1:9090');

    await expect(adapter.closeTicket('token', 'unknown-ticket')).rejects.toThrow(
      TicketNotFoundOrInactiveError,
    );
  });
});
