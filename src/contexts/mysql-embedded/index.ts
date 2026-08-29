/**
 * The "mysql-embedded" bounded context: lifecycle of the local `dolt
 * sql-server` on loopback (`deltix start` / `stop` / `status`), with zero
 * dependency on a pre-installed MySQL service on the host.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 */
export { createMysqlEmbeddedService } from './create-mysql-embedded-service';
export {
  LocalServerNotRunningError,
  LocalServerPortInUseError,
  LocalServerStartError,
} from './mysql-embedded.errors';
export type {
  LocalServerIdentity,
  LocalServerStatus,
  MysqlEmbeddedDeps,
  RunState,
} from './mysql-embedded.service';
export {
  computeLocalDataDir,
  MysqlEmbeddedService,
  waitForTcpPort,
} from './mysql-embedded.service';
