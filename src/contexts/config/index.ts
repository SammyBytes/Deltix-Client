/**
 * The "config" bounded context: persists CLI connection settings (server
 * URL, gRPC host/port, TLS trust options) so a first-time user can run
 * `deltix configure` once instead of hand-setting env vars.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside (e.g. `contexts/config/config-store`).
 */

export type { StoredConfig } from './config-store';
export { ConfigStore } from './config-store';
export { defaultConfigPath } from './default-config-path';
