import { ConfigStore, defaultConfigPath } from '../../contexts/config';

/**
 * Saves `port` to the Deltix config when DELTIX_LOCAL_PORT is currently set
 * in the process environment (meaning the operator chose it explicitly).
 * Merges into the existing config so unrelated fields (server URL, TLS,
 * credentials paths) are preserved. No-op when DELTIX_LOCAL_PORT is unset
 * OR when the persisted port already matches.
 */
export async function persistLocalPortIfExplicit(
  port: number,
  configPath: string = defaultConfigPath,
): Promise<void> {
  if (Bun.env.DELTIX_LOCAL_PORT === undefined) return;
  const store = new ConfigStore(configPath);
  const existing = (await store.load()) ?? {};
  if (existing.localPort === port) return;
  await store.save({ ...existing, localPort: port });
}
