import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 64;
const AUTH_FILE = /^codex-.+\.json$/i;
const TRANSACTION_DIRECTORY = /^\.quarantine-[0-9a-f]{32}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type ManagedQuotaAuthFailure =
  'not-authorized' | 'invalid-auth' | 'unsafe-auth' | 'account-changing' | 'ambiguous-account';

export class ManagedQuotaAuthError extends Error {
  public constructor(public readonly kind: ManagedQuotaAuthFailure) {
    super(kind);
    this.name = 'ManagedQuotaAuthError';
  }
}

/** This capability stays inside the main process and is never logged, persisted, or sent to IPC. */
export interface ManagedQuotaCredential {
  accessToken: string;
  accountId: string;
  accountKey: string;
}

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const timestamp = (value: unknown): boolean =>
  typeof value === 'string' && RFC3339.test(value) && Number.isFinite(Date.parse(value));

const sameFile = (left: Stats, right: Stats): boolean =>
  right.isFile() &&
  !right.isSymbolicLink() &&
  right.nlink === 1 &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const entriesAt = async (directory: string, signal: AbortSignal) => {
  const entries = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    signal.throwIfAborted();
    if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new ManagedQuotaAuthError('unsafe-auth');
    entries.push(entry);
  }
  return entries;
};

const authenticationFiles = async (
  directory: string,
  signal: AbortSignal,
): Promise<{ files: string[]; realDirectory: string }> => {
  signal.throwIfAborted();
  const parent = path.dirname(directory);
  const [parentStat, directoryStat, realParent, realDirectory] = await Promise.all([
    lstat(parent),
    lstat(directory),
    realpath(parent),
    realpath(directory),
  ]);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !samePath(path.dirname(realDirectory), realParent)
  )
    throw new ManagedQuotaAuthError('unsafe-auth');
  const files: string[] = [];
  for (const entry of await entriesAt(directory, signal)) {
    if (TRANSACTION_DIRECTORY.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new ManagedQuotaAuthError('unsafe-auth');
      const transaction = path.join(directory, entry.name);
      if (!samePath(path.dirname(await realpath(transaction)), realDirectory))
        throw new ManagedQuotaAuthError('unsafe-auth');
      const contents = await entriesAt(transaction, signal);
      // Reading quota never recovers or deletes a transaction. Only an already committed one
      // can be ignored; an interrupted login must be settled by the existing lifecycle owner.
      if (
        !contents.some((item) => item.name === '.phase-committed') ||
        contents.some(
          (item) =>
            !item.isFile() ||
            item.isSymbolicLink() ||
            (item.name !== '.phase-committed' &&
              !/^oauth-artifact-[0-9a-f]{32}\.bin$/.test(item.name)),
        )
      )
        throw new ManagedQuotaAuthError('account-changing');
    }
    if (!AUTH_FILE.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new ManagedQuotaAuthError('unsafe-auth');
    files.push(entry.name);
  }
  signal.throwIfAborted();
  return { files: files.sort(), realDirectory };
};

const parseCredential = (value: unknown): ManagedQuotaCredential | undefined => {
  if (record(value) && value.disabled === true) return undefined;
  if (
    !record(value) ||
    value.type !== 'codex' ||
    value.disabled !== false ||
    !nonEmpty(value.email) ||
    value.email.length > 320 ||
    !nonEmpty(value.access_token) ||
    value.access_token.length > 32_768 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(value.access_token) ||
    !nonEmpty(value.account_id) ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(value.account_id) ||
    !nonEmpty(value.refresh_token) ||
    !nonEmpty(value.id_token) ||
    !timestamp(value.expired) ||
    !timestamp(value.last_refresh)
  )
    throw new ManagedQuotaAuthError('invalid-auth');
  return {
    accessToken: value.access_token,
    accountId: value.account_id,
    accountKey: createHash('sha256')
      .update(JSON.stringify([value.email.trim().toLowerCase(), value.account_id]))
      .digest('hex'),
  };
};

const readCredential = async (
  file: string,
  directory: string,
  signal: AbortSignal,
): Promise<ManagedQuotaCredential | undefined> => {
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > MAX_AUTH_BYTES ||
    !samePath(path.dirname(await realpath(file)), directory)
  )
    throw new ManagedQuotaAuthError('unsafe-auth');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await handle.stat())) throw new ManagedQuotaAuthError('account-changing');
    signal.throwIfAborted();
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      signal.throwIfAborted();
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const [after, namedAfter, realFile] = await Promise.all([
      handle.stat(),
      lstat(file),
      realpath(file),
    ]);
    if (
      offset !== before.size ||
      !sameFile(before, after) ||
      !sameFile(before, namedAfter) ||
      !samePath(path.dirname(realFile), directory)
    )
      throw new ManagedQuotaAuthError('account-changing');
    signal.throwIfAborted();
    try {
      return parseCredential(JSON.parse(bytes.toString('utf8', 0, offset)) as unknown);
    } catch (error) {
      if (error instanceof ManagedQuotaAuthError) throw error;
      throw new ManagedQuotaAuthError('invalid-auth');
    }
  } finally {
    await handle.close();
  }
};

/** Bounded asynchronous reads of ClaudeDock-owned auth only; never consults CODEX_HOME. */
export const readManagedQuotaCredential = async (
  authDirectory: string,
  signal: AbortSignal,
): Promise<ManagedQuotaCredential> => {
  try {
    const directory = path.resolve(authDirectory);
    const before = await authenticationFiles(directory, signal);
    let credential: ManagedQuotaCredential | undefined;
    for (const name of before.files) {
      const candidate = await readCredential(
        path.join(directory, name),
        before.realDirectory,
        signal,
      );
      if (!candidate) continue;
      // A legacy multi-account gateway can route requests to any enabled account. Do not guess
      // its current account by filename, email, timestamp, or the user's independent Codex login.
      if (credential) throw new ManagedQuotaAuthError('ambiguous-account');
      credential = candidate;
    }
    const after = await authenticationFiles(directory, signal);
    if (
      !samePath(before.realDirectory, after.realDirectory) ||
      JSON.stringify(before.files) !== JSON.stringify(after.files)
    )
      throw new ManagedQuotaAuthError('account-changing');
    if (!credential) throw new ManagedQuotaAuthError('not-authorized');
    return credential;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ManagedQuotaAuthError) throw error;
    throw new ManagedQuotaAuthError(
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not-authorized' : 'unsafe-auth',
    );
  }
};
