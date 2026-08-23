import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createMaxMindAnonymousPlusAdapter,
  type MaxMindAnonymousPlusReader,
} from '../../src/main/egress-diagnostics/adapters/maxmind-anonymous-plus';
import type {
  MaxMindFileStats,
  MaxMindFileSystem,
} from '../../src/main/egress-diagnostics/maxmind-file-policy';

const NOW = Date.UTC(2026, 7, 20, 12);
const ROOT = path.resolve('controlled-maxmind-root');
const DATABASE = path.join(ROOT, 'GeoIP-Anonymous-Plus.mmdb');
const DATABASE_SIZE = 4_096;

interface StatsOptions {
  readonly device?: number;
  readonly directory?: boolean;
  readonly inode?: number;
  readonly modifiedAtMs?: number;
  readonly reparse?: boolean;
  readonly size?: number;
  readonly symbolicLink?: boolean;
}

const stats = (options: StatsOptions = {}): MaxMindFileStats => ({
  dev: options.device ?? 7,
  ino: options.inode ?? (options.directory ? 1 : 2),
  mtimeMs: options.modifiedAtMs ?? NOW - 60_000,
  size: options.size ?? (options.directory ? 0 : DATABASE_SIZE),
  isDirectory: () => options.directory === true,
  isFile: () => options.directory !== true,
  isReparsePoint: () => options.reparse === true,
  isSymbolicLink: () => options.symbolicLink === true,
});

interface FileSystemOptions {
  readonly descriptorStats?: StatsOptions;
  readonly handleClose?: () => Promise<void>;
  readonly realDatabasePath?: string;
  readonly reparse?: boolean;
  readonly symbolicLink?: boolean;
}

const fileSystem = (options: FileSystemOptions = {}): MaxMindFileSystem => {
  const statFile = vi.fn(async (_target: string) => stats());
  return {
    lstat: vi.fn(async (target) =>
      target === ROOT
        ? stats({ directory: true })
        : stats({ reparse: options.reparse, symbolicLink: options.symbolicLink }),
    ),
    open: vi.fn(async (target) => {
      const openedStats = options.descriptorStats
        ? stats(options.descriptorStats)
        : await statFile(target);
      return {
        close: options.handleClose ?? vi.fn(async () => undefined),
        readFile: vi.fn(async () => Buffer.alloc(openedStats.size)),
        stat: vi.fn(async () => openedStats),
      };
    }),
    realpath: vi.fn(async (target) =>
      target === ROOT ? ROOT : (options.realDatabasePath ?? DATABASE),
    ),
    stat: statFile,
  };
};

const record = {
  anonymizerConfidence: 99,
  isAnonymous: true,
  isAnonymousVpn: true,
  isHostingProvider: false,
  isPublicProxy: false,
  isResidentialProxy: true,
  isTorExitNode: false,
  networkLastSeen: '2026-08-19',
  providerName: 'example-vpn',
};

const input = {
  address: { address: '203.0.113.40', family: 'ipv4' as const },
  leaseCurrent: true,
};

describe('MaxMind Anonymous Plus local adapter', () => {
  it('opens a descriptor-bound byte image and parses provider freshness locally', async () => {
    const anonymousPlus = vi.fn(() => record);
    const readerFactory = vi.fn(
      async (_databaseBytes: Buffer): Promise<MaxMindAnonymousPlusReader> => ({
        anonymousPlus,
      }),
    );
    const adapter = createMaxMindAnonymousPlusAdapter({
      databasePath: DATABASE,
      databaseRoot: ROOT,
      fileSystem: fileSystem(),
      now: () => NOW,
      readerFactory,
    });

    const result = await adapter.collect({
      address: { address: '2001:db8::40', family: 'ipv6' },
      leaseCurrent: true,
    });

    expect(readerFactory).toHaveBeenCalledOnce();
    expect(Buffer.isBuffer(vi.mocked(readerFactory).mock.calls[0]?.[0])).toBe(true);
    expect(vi.mocked(readerFactory).mock.calls[0]?.[0].byteLength).toBe(DATABASE_SIZE);
    expect(anonymousPlus).toHaveBeenCalledWith('2001:db8::40');
    expect(result).toMatchObject({
      assessment: { agreement: 'single-source', confidence: 'moderate', freshness: 'recent' },
      facts: {
        anonymizerConfidence: 99,
        isAnonymousVpn: true,
        isResidentialProxy: true,
        networkLastSeen: '2026-08-19',
        providerName: 'example-vpn',
      },
      provider: 'maxmind-anonymous-plus',
      provenance: { transport: 'local:maxmind-mmdb' },
      state: 'complete',
    });
    expect(result.provenance.sourceTimes.map((time) => time.label)).toEqual([
      'network_last_seen',
      'database-file-mtime',
    ]);
  });

  it('caches a reader only while file identity, size, and mtime stay stable', async () => {
    let modifiedAtMs = NOW - 60_000;
    let size = DATABASE_SIZE;
    const localFileSystem = fileSystem();
    vi.mocked(localFileSystem.stat).mockImplementation(async () => stats({ modifiedAtMs, size }));
    const readers: Array<MaxMindAnonymousPlusReader & { close: ReturnType<typeof vi.fn> }> = [];
    const readerFactory = vi.fn(async () => {
      const reader = { anonymousPlus: vi.fn(() => record), close: vi.fn() };
      readers.push(reader);
      return reader;
    });
    const adapter = createMaxMindAnonymousPlusAdapter({
      databasePath: DATABASE,
      databaseRoot: ROOT,
      fileSystem: localFileSystem,
      now: () => NOW,
      readerFactory,
    });

    await adapter.collect(input);
    await adapter.collect(input);
    expect(readerFactory).toHaveBeenCalledTimes(1);

    size += 1;
    modifiedAtMs += 1_000;
    await adapter.collect(input);

    expect(readerFactory).toHaveBeenCalledTimes(2);
    expect(readers[0]?.close).toHaveBeenCalledOnce();
    await adapter.close();
    expect(readers[1]?.close).toHaveBeenCalledOnce();
  });

  it('coalesces cold opens and permits a clean retry after one shared refresh failure', async () => {
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const readerFactory = vi.fn(async (): Promise<MaxMindAnonymousPlusReader> => {
      await openGate;
      throw new Error('library detail');
    });
    const adapter = createMaxMindAnonymousPlusAdapter({
      databasePath: DATABASE,
      databaseRoot: ROOT,
      fileSystem: fileSystem(),
      readerFactory,
    });
    const first = adapter.collect(input);
    const second = adapter.collect(input);
    await vi.waitFor(() => expect(readerFactory).toHaveBeenCalledOnce());
    releaseOpen?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ code: 'lookup-failed' }),
        state: 'unavailable',
      }),
      expect.objectContaining({
        issue: expect.objectContaining({ code: 'lookup-failed' }),
        state: 'unavailable',
      }),
    ]);
    readerFactory.mockImplementation(async () => ({ anonymousPlus: () => record }));
    await expect(adapter.collect(input)).resolves.toMatchObject({ state: 'complete' });
    expect(readerFactory).toHaveBeenCalledTimes(2);
  });

  it('rejects a swap-open-swap-back descriptor mismatch before constructing a reader', async () => {
    const handleClose = vi.fn(async () => undefined);
    const localFileSystem = fileSystem({
      descriptorStats: { device: 9, inode: 99 },
      handleClose,
    });
    const readerFactory = vi.fn(async (): Promise<MaxMindAnonymousPlusReader> => ({
      anonymousPlus: () => record,
    }));
    const adapter = createMaxMindAnonymousPlusAdapter({
      databasePath: DATABASE,
      databaseRoot: ROOT,
      fileSystem: localFileSystem,
      readerFactory,
    });

    const result = await adapter.collect(input);

    expect(result).toMatchObject({
      issue: { code: 'invalid-configuration' },
      state: 'unavailable',
    });
    expect(readerFactory).not.toHaveBeenCalled();
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('invalidates and closes a reader when the path identity changes during lookup', async () => {
    let modifiedAtMs = NOW - 60_000;
    const localFileSystem = fileSystem();
    vi.mocked(localFileSystem.stat).mockImplementation(async () => stats({ modifiedAtMs }));
    const close = vi.fn();
    const adapter = createMaxMindAnonymousPlusAdapter({
      databasePath: DATABASE,
      databaseRoot: ROOT,
      fileSystem: localFileSystem,
      readerFactory: async () => ({
        anonymousPlus: () => {
          modifiedAtMs += 1_000;
          return record;
        },
        close,
      }),
    });

    const changed = await adapter.collect(input);

    expect(changed).toMatchObject({
      issue: { code: 'invalid-configuration' },
      state: 'unavailable',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'relative path',
      path: 'relative.mmdb',
      root: ROOT,
      system: fileSystem(),
    },
    {
      name: 'wrong extension',
      path: path.join(ROOT, 'database.json'),
      root: ROOT,
      system: fileSystem(),
    },
    {
      name: 'symbolic link or junction',
      path: DATABASE,
      root: ROOT,
      system: fileSystem({ symbolicLink: true }),
    },
    {
      name: 'reparse point',
      path: DATABASE,
      root: ROOT,
      system: fileSystem({ reparse: true }),
    },
    {
      name: 'realpath escape',
      path: DATABASE,
      root: ROOT,
      system: fileSystem({ realDatabasePath: path.resolve('outside', 'database.mmdb') }),
    },
  ])('rejects a main-owned database with $name', async ({ path: databasePath, root, system }) => {
    const readerFactory = vi.fn(async (): Promise<MaxMindAnonymousPlusReader> => ({
      anonymousPlus: () => record,
    }));
    const adapter = createMaxMindAnonymousPlusAdapter({
      databasePath,
      databaseRoot: root,
      fileSystem: system,
      readerFactory,
    });

    const result = await adapter.collect(input);

    expect(result).toMatchObject({
      issue: { code: 'invalid-configuration' },
      state: 'unavailable',
    });
    expect(readerFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(databasePath);
  });

  it('contains no network, DNS, subprocess, pathname reader, or fetch fallback', async () => {
    const source = await readFile(
      new URL(
        '../../src/main/egress-diagnostics/adapters/maxmind-anonymous-plus.ts',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).not.toMatch(/node:(?:http|https|dns|child_process)/);
    expect(source).not.toMatch(/\b(?:fetch|request|spawn|exec)\s*\(/);
    expect(source).not.toMatch(/readerFactory\(identity\.realPath\)/);
  });
});
