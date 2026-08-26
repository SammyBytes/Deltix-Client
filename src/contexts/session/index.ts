/**
 * The "session" bounded context: authenticates against Deltix-Server's REST
 * auth API and manages the local refresh-token lifecycle
 * (`~/.deltix/credentials.json`).
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside (e.g. `contexts/session/some-internal-file`).
 */
export { createSessionService } from './create-session-service';
export {
  InvalidCredentialsError,
  NoActiveSessionError,
  ServerUnreachableError,
} from './errors';
export type { SessionStatus } from './session.service';
export { SessionService } from './session.service';
