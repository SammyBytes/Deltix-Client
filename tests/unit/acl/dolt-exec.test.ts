import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DoltExecError,
  runCommand,
  runDoltCommand,
  runDoltOrThrow,
  whichBinary,
} from '../../../src/acl/dolt-exec';

describe('acl/dolt-exec (unit, real system binaries)', () => {
  it('runCommand captures stdout and exit code from an argv array', async () => {
    const result = await runCommand('/bin/echo', ['hello', 'world']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('runCommand surfaces a non-zero exit code without throwing', async () => {
    const result = await runCommand('/bin/false', []);
    expect(result.exitCode).toBe(1);
  });

  it('never interprets argv as a shell string (A03 injection guard)', async () => {
    const marker = join(tmpdir(), `deltix-pwned-${Date.now()}`);
    await rm(marker, { force: true });
    const result = await runCommand('/bin/echo', [`x; touch ${marker}`]);
    expect(result.exitCode).toBe(0);
    // The literal argument is printed back unchanged — nothing was executed.
    expect(result.stdout.trim()).toBe(`x; touch ${marker}`);
    expect(existsSync(marker)).toBe(false);
  });

  it('runDoltOrThrow wraps a failing dolt command in DoltExecError', async () => {
    await expect(runDoltOrThrow('/bin/false', ['commit', '-m', 'x'])).rejects.toBeInstanceOf(
      DoltExecError,
    );
  });

  it('runDoltCommand is an alias of runCommand (same behavior)', async () => {
    const a = await runDoltCommand('/bin/echo', ['a']);
    const b = await runCommand('/bin/echo', ['a']);
    expect(a).toEqual(b);
  });

  it('whichBinary resolves an existing binary and returns null for a fake one', async () => {
    const found = await whichBinary('echo');
    expect(found).toBeString();
    const missing = await whichBinary(`definitely-not-a-real-binary-${Date.now()}`);
    expect(missing).toBeNull();
  });
});
