/**
 * ACL adapter translating Deltix-Client's dataflow context to
 * Deltix-Server's Fase 3 ephemeral-ticket REST endpoints
 * (`/api/v1/push/ticket`, `/api/v1/auth/session-close`). This is the only
 * place that knows the server's ticket wire shape — the dataflow context
 * works with its own local types.
 *
 * Ticket issuance always requires a fresh, valid access token (never the
 * refresh token directly) — the caller is responsible for minting one via
 * `AuthApiAdapter.refresh()` immediately before calling `issueTicket()`.
 */

import {
  TicketAuthenticationError,
  TicketIssuanceError,
  TicketNotFoundOrInactiveError,
} from '../contexts/dataflow/errors';
import { ServerUnreachableError } from '../contexts/session/errors';

export interface IssuedTicket {
  ticketId: string;
  operation: 'push' | 'pull';
  repo: string;
  expiresAt: number;
}

export class TransferTicketApiAdapter {
  constructor(private readonly serverUrl: string) {}

  async issueTicket(
    accessToken: string,
    operation: 'push' | 'pull',
    repo: string,
  ): Promise<IssuedTicket> {
    const res = await this.request('/api/v1/push/ticket', accessToken, { operation, repo });

    if (res.status === 401) {
      throw new TicketAuthenticationError();
    }
    if (!res.ok) {
      throw new TicketIssuanceError(res.status);
    }

    const body = (await res.json()) as {
      ticketId: string;
      operation: 'push' | 'pull';
      repo: string;
      expiresAt: number;
    };
    return body;
  }

  async closeTicket(accessToken: string, ticketId: string): Promise<void> {
    const res = await this.request('/api/v1/auth/session-close', accessToken, { ticketId });

    if (res.status === 401) {
      throw new TicketAuthenticationError();
    }
    if (res.status === 404) {
      throw new TicketNotFoundOrInactiveError();
    }
    if (!res.ok) {
      throw new TicketIssuanceError(res.status);
    }
  }

  private async request(path: string, accessToken: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ServerUnreachableError(err);
    }
  }
}
