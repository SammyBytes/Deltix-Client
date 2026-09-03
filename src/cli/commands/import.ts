import {
  type BlobPolicy,
  createImportService,
  ImportBlobError,
  ImportDsnError,
  ImportError,
  ImportUnsupportedSchemeError,
} from '../../contexts/import';
import {
  createLocalProjectService,
  InvalidRepoNameError,
  ProjectAlreadyInitializedError,
  type ResolvedProject,
} from '../../contexts/local-project';
import { createSessionService } from '../../contexts/session';
import { CommitDataDirNotFoundError, LocalRepoInitError } from '../../contexts/versioning-local';
import { flagMulti, flagValue } from '../helpers/args';
import { printError, printInfo, printSuccess, promptConfirm, promptSecret } from '../output';
import { withSpinner } from '../spinner';

export async function runImport(args: string[]): Promise<number> {
  const repoArg = args.find((a) => !a.startsWith('--'));
  const from = flagValue(args, 'from') ?? process.env.DELTIX_IMPORT_URL;
  if (!repoArg || !from) {
    printError(
      'Usage: deltix import <repo> --from <mysql://dsn> [--table t] [--schema-only] [--continue] [--no-commit] [--blobs error|base64|skip]',
    );
    return 1;
  }
  const blobsRaw = flagValue(args, 'blobs');
  const blobs = (
    blobsRaw === 'base64' || blobsRaw === 'skip' || blobsRaw === 'error' ? blobsRaw : 'error'
  ) as BlobPolicy;
  const schemaOnly = args.includes('--schema-only');
  const continueOnRowError =
    args.includes('--continue') || args.includes('--continue-on-row-error');

  // When the operator didn't pick a mode AND the terminal is interactive,
  // ask once with a sensible default (schema + data, the common case). In
  // non-TTY (CI, scripts) we silently default to schema + data so the
  // command stays batchable.
  let effectiveSchemaOnly = schemaOnly;
  if (!schemaOnly && process.stdin.isTTY) {
    const wantsData = await promptConfirm('Import schema AND data? (no = schema only)', {
      default: true,
    });
    if (!wantsData) effectiveSchemaOnly = true;
  }

  // Auto-prompt for the DB password when the DSN didn't carry one. Keeping
  // the secret out of the DSN (and therefore out of shell history and `ps`)
  // is the whole point.
  const dsnWithPromptedSecret = await maybePromptForDsnPassword(from);
  try {
    // Bind the folder to the repo (the "git init" moment); reuse if already bound.
    let project: ResolvedProject;
    try {
      project = await createLocalProjectService().init(process.cwd(), repoArg);
    } catch (err) {
      if (err instanceof ProjectAlreadyInitializedError) {
        project = await createLocalProjectService().resolve(process.cwd());
      } else {
        throw err;
      }
    }
    const identity = { repo: project.config.repo, projectRoot: project.root };
    const sessionStatus = await createSessionService().status();
    const authorName = sessionStatus.loggedIn ? sessionStatus.username : undefined;
    const result = await withSpinner(`Importing into ${repoArg}`, () =>
      createImportService().import(identity, {
        from: dsnWithPromptedSecret,
        tables: flagMulti(args, 'table'),
        schemaOnly: effectiveSchemaOnly,
        continueOnRowError,
        noCommit: args.includes('--no-commit'),
        blobs,
        authorName,
      }),
    );
    printSuccess(`Imported ${result.tablesImported} table(s) from ${result.database}`, {
      commit: result.commitHash ?? '(not committed — --no-commit)',
    });
    for (const s of result.skipped) {
      printInfo(`skipped ${s.table}: ${s.reason}`);
    }
    printInfo('Next: deltix push');
    return 0;
  } catch (err) {
    if (
      err instanceof ImportDsnError ||
      err instanceof ImportUnsupportedSchemeError ||
      err instanceof ImportBlobError ||
      err instanceof ImportError ||
      err instanceof CommitDataDirNotFoundError ||
      err instanceof LocalRepoInitError ||
      err instanceof ProjectAlreadyInitializedError ||
      err instanceof InvalidRepoNameError
    ) {
      printError(err.message);
      return 1;
    }
    printError(`Import failed: ${String(err)}`);
    return 1;
  }
}

/**
 * If `dsn` parses and has no password (e.g. `mysql://root@host/db`), ask
 * for it interactively with a masked prompt and return the DSN with the
 * password filled in. If the DSN already carries a password, or the
 * operator hits Enter on the prompt (empty secret), return the input as-is.
 *
 * Non-TTY: skip the prompt silently — the operator is presumably scripting.
 */
export async function maybePromptForDsnPassword(dsn: string): Promise<string> {
  if (!process.stdin.isTTY) return dsn;
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return dsn; // let the import service emit the proper DsnError later
  }
  if (parsed.password) return dsn;
  if (!parsed.username) return dsn;
  const secret = await promptSecret(`Password for ${parsed.username}@${parsed.hostname}`);
  if (secret === '') return dsn;
  parsed.password = secret;
  return parsed.toString();
}
