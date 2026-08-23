import type { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_DATABASE_BYTES = 512 * 1024 * 1024;

export interface MaxMindFileStats {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isReparsePoint?(): boolean;
  isSymbolicLink(): boolean;
}

export interface MaxMindFileHandle {
  readonly close: () => Promise<void>;
  readonly readFile: () => Promise<Buffer>;
  readonly stat: () => Promise<MaxMindFileStats>;
}

export interface MaxMindFileSystem {
  readonly lstat: (target: string) => Promise<MaxMindFileStats>;
  readonly open: (target: string, flags: number) => Promise<MaxMindFileHandle>;
  readonly realpath: (target: string) => Promise<string>;
  readonly stat: (target: string) => Promise<MaxMindFileStats>;
}

export interface MaxMindFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly realPath: string;
  readonly size: number;
}

export interface ValidatedMaxMindDatabase {
  readonly bytes: Buffer;
  readonly identity: MaxMindFileIdentity;
}

export const realMaxMindFileSystem: MaxMindFileSystem = {
  lstat,
  open,
  realpath,
  stat,
};

const isContained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};

const rejectsLinks = (stats: MaxMindFileStats): boolean =>
  stats.isSymbolicLink() || stats.isReparsePoint?.() === true;

const identityFromStats = (stats: MaxMindFileStats, realPath: string): MaxMindFileIdentity => {
  if (
    !Number.isSafeInteger(stats.dev) ||
    stats.dev <= 0 ||
    !Number.isSafeInteger(stats.ino) ||
    stats.ino <= 0 ||
    !Number.isSafeInteger(stats.size) ||
    stats.size <= 0 ||
    stats.size > MAX_DATABASE_BYTES ||
    !Number.isFinite(stats.mtimeMs) ||
    stats.mtimeMs < 0 ||
    stats.mtimeMs > 8_640_000_000_000_000
  ) {
    throw new Error('invalid-file-identity');
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    modifiedAtMs: stats.mtimeMs,
    realPath,
    size: stats.size,
  };
};

const inspectLexicalPath = async (
  fileSystem: MaxMindFileSystem,
  root: string,
  databasePath: string,
): Promise<void> => {
  const rootStats = await fileSystem.lstat(root);
  if (rejectsLinks(rootStats) || !rootStats.isDirectory()) throw new Error('unsafe-root');
  const relative = path.relative(root, databasePath);
  const components = relative.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    const stats = await fileSystem.lstat(cursor);
    if (rejectsLinks(stats)) throw new Error('unsafe-reparse-point');
    const isLast = index === components.length - 1;
    if ((isLast && !stats.isFile()) || (!isLast && !stats.isDirectory())) {
      throw new Error('unexpected-file-type');
    }
  }
};

export const inspectMaxMindDatabaseFile = async (
  fileSystem: MaxMindFileSystem,
  root: string,
  databasePath: string,
): Promise<MaxMindFileIdentity> => {
  if (
    !path.isAbsolute(root) ||
    !path.isAbsolute(databasePath) ||
    path.extname(databasePath).toLowerCase() !== '.mmdb' ||
    !isContained(root, databasePath)
  ) {
    throw new Error('invalid-database-path');
  }
  await inspectLexicalPath(fileSystem, root, databasePath);
  const [realRoot, realDatabasePath] = await Promise.all([
    fileSystem.realpath(root),
    fileSystem.realpath(databasePath),
  ]);
  if (
    !path.isAbsolute(realRoot) ||
    !path.isAbsolute(realDatabasePath) ||
    !isContained(realRoot, realDatabasePath)
  ) {
    throw new Error('realpath-escaped-root');
  }
  const stats = await fileSystem.stat(realDatabasePath);
  if (!stats.isFile() || rejectsLinks(stats)) throw new Error('unsafe-database-file');
  return identityFromStats(stats, realDatabasePath);
};

export const sameMaxMindFileIdentity = (
  left: MaxMindFileIdentity,
  right: MaxMindFileIdentity,
): boolean =>
  left.realPath === right.realPath &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.modifiedAtMs === right.modifiedAtMs;

const descriptorIdentity = async (
  handle: MaxMindFileHandle,
  approved: MaxMindFileIdentity,
): Promise<MaxMindFileIdentity> => {
  const stats = await handle.stat();
  if (!stats.isFile() || rejectsLinks(stats)) throw new Error('unsafe-open-database');
  return identityFromStats(stats, approved.realPath);
};

export const readValidatedMaxMindDatabase = async (
  fileSystem: MaxMindFileSystem,
  root: string,
  databasePath: string,
): Promise<ValidatedMaxMindDatabase> => {
  const approved = await inspectMaxMindDatabaseFile(fileSystem, root, databasePath);
  const handle = await fileSystem.open(approved.realPath, constants.O_RDONLY);
  try {
    const beforeRead = await descriptorIdentity(handle, approved);
    if (!sameMaxMindFileIdentity(approved, beforeRead)) {
      throw new Error('opened-database-identity-mismatch');
    }
    const bytes = await handle.readFile();
    const afterRead = await descriptorIdentity(handle, approved);
    const afterPath = await inspectMaxMindDatabaseFile(fileSystem, root, databasePath);
    if (
      bytes.byteLength !== approved.size ||
      !sameMaxMindFileIdentity(approved, afterRead) ||
      !sameMaxMindFileIdentity(approved, afterPath)
    ) {
      throw new Error('database-changed-during-read');
    }
    return { bytes, identity: approved };
  } finally {
    await handle.close();
  }
};
