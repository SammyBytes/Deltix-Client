import { describe, expect, it } from 'bun:test';
import { startHeartbeat } from '../../../src/contexts/heartbeat/heartbeat.service';

describe('heartbeat/heartbeat.service (unit, fake timers via short real intervals)', () => {
  it('calls renew() repeatedly at roughly the configured interval until stopped', async () => {
    let calls = 0;
    const handle = startHeartbeat(
      async () => {
        calls += 1;
        return Date.now();
      },
      10,
      () => {},
    );

    await new Promise((resolve) => setTimeout(resolve, 55));
    handle.stop();
    const callsAtStop = calls;

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(callsAtStop).toBeGreaterThanOrEqual(3);
    // No further calls after stop() — the interval must actually be cleared.
    expect(calls).toBe(callsAtStop);
  });

  it('invokes onError when renew() rejects, without crashing the loop', async () => {
    let renewCalls = 0;
    let errorCalls = 0;
    const handle = startHeartbeat(
      async () => {
        renewCalls += 1;
        throw new Error('ticket expired');
      },
      10,
      () => {
        errorCalls += 1;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 55));
    handle.stop();

    expect(renewCalls).toBeGreaterThanOrEqual(3);
    expect(errorCalls).toBe(renewCalls);
  });

  it('stop() is idempotent and safe to call multiple times', () => {
    const handle = startHeartbeat(
      async () => 0,
      1000,
      () => {},
    );
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });
});
