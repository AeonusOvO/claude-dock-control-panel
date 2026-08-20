import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DownloadHistoryStore } from '../../src/main/download/history';
import type { DownloadTaskView } from '../../src/shared/contracts';

const temporaryDirectories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-download-history-'));
  temporaryDirectories.push(directory);
  return directory;
};

const historyEntry = (id: string, finishedAt: number): DownloadTaskView => ({
  bytesPerSecond: 1_024,
  canPause: false,
  canResume: false,
  elapsedMs: 2_000,
  finishedAt,
  id,
  label: `下载 ${id}`,
  percent: 100,
  receivedBytes: 4_096,
  remainingMs: 0,
  startedAt: finishedAt - 2_000,
  state: 'completed',
  totalBytes: 4_096,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('download history store', () => {
  it('persists settled tasks in newest-first order without executable paths', () => {
    const directory = temporaryDirectory();
    const store = new DownloadHistoryStore(directory);
    store.upsert(historyEntry('older', 1_000));
    store.upsert(historyEntry('newer', 2_000));

    expect(new DownloadHistoryStore(directory).list().map(({ id }) => id)).toEqual([
      'newer',
      'older',
    ]);
    const serialized = readFileSync(path.join(directory, 'download-history.json'), 'utf8');
    expect(serialized).not.toContain('finalPath');
    expect(serialized).not.toContain('urlChain');
  });

  it('supports deleting one record and clearing retained history', () => {
    const directory = temporaryDirectory();
    const store = new DownloadHistoryStore(directory);
    store.upsert(historyEntry('first', 1_000));
    store.upsert(historyEntry('second', 2_000));

    expect(store.remove('first')).toBe(true);
    expect(store.list().map(({ id }) => id)).toEqual(['second']);
    expect(store.clear()).toBe(1);
    expect(new DownloadHistoryStore(directory).list()).toEqual([]);
  });

  it('ignores corrupt and non-terminal records', () => {
    const directory = temporaryDirectory();
    writeFileSync(
      path.join(directory, 'download-history.json'),
      JSON.stringify({
        entries: [{ ...historyEntry('active', 1_000), state: 'progressing' }],
        version: 1,
      }),
    );
    expect(new DownloadHistoryStore(directory).list()).toEqual([]);

    writeFileSync(path.join(directory, 'download-history.json'), '{not-json');
    expect(new DownloadHistoryStore(directory).list()).toEqual([]);
  });
});
