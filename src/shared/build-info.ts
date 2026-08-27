/**
 * Build/version metadata for `deltix version`/`--version`. Mirrors
 * Deltix-Server's `src/shared/build-info.ts` in spirit (same resolution
 * order), but kept as an independent copy — MIT/BSL licensing boundary
 * means no shared code between the two repos (see
 * .github/copilot-instructions.md).
 */
import packageJson from '../../package.json' with { type: 'json' };

export interface ClientBuildInfo {
  version: string;
  commit: string;
}

let cached: ClientBuildInfo | null = null;

async function resolveCommit(): Promise<string> {
  const fromEnv = Bun.env.DELTIX_BUILD_COMMIT;
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 && output.trim() ? output.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Resolved once and cached — commit/version never change during the process lifetime. */
export async function getClientBuildInfo(): Promise<ClientBuildInfo> {
  if (!cached) {
    cached = {
      version: packageJson.version,
      commit: await resolveCommit(),
    };
  }
  return cached;
}
