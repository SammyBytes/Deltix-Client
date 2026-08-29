/**
 * The "binary-manager" bounded context: black-box, hash-verified management
 * of the local `dolt` CLI binary (resolve from PATH, discover an installed
 * copy, or download the official release tarball into `~/.deltix/bin/`).
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 */
export {
  BinaryManager,
  type BinaryManagerDeps,
  DOLT_VERSION,
  doltReleaseUrl,
} from './binary-manager.service';
export type { DoltDownloader } from './download';
export { createGitHubReleaseDownloader } from './download';
