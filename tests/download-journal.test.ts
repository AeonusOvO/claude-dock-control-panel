import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../src/main/busy-registry';
import { DownloadEngine, type DownloadSession } from '../src/main/download-engine';
import { DownloadJournal } from '../src/main/download-journal';

describe('download journal recovery', () => {
  it('recreates a valid interrupted download without resuming it automatically', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-journal-'));
    const finalPath = path.join(userDataPath, 'installers', 'tool.exe');
    const savePath = `${finalPath}.partial`;
    mkdirSync(path.dirname(savePath), { recursive: true });
    writeFileSync(savePath, 'data', { encoding: 'utf8', mode: 0o600 });
    new DownloadJournal(userDataPath).upsert({
      allowedHosts: ['downloads.example.com'],
      allowedPathPrefixes: ['/tool.exe'],
      eTag: '"release-1"',
      expectedBytes: 4,
      expectedSha256: '0'.repeat(64),
      finalPath,
      id: 'recover-tool',
      label: '恢复工具',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      length: 10,
      maxBytes: 100,
      receivedBytes: 4,
      savePath,
      startTime: 1_700_000_000,
      urlChain: ['https://downloads.example.com/tool.exe'],
    });
    const electronSession = {
      createInterruptedDownload: vi.fn(),
      downloadURL: vi.fn(),
      on: vi.fn(),
    } satisfies DownloadSession;
    const engine = new DownloadEngine(
      electronSession,
      new BusyRegistry(),
      userDataPath,
    );

    engine.restoreInterrupted();

    expect(electronSession.createInterruptedDownload).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 4, path: savePath }),
    );
    expect(electronSession.downloadURL).not.toHaveBeenCalled();
    expect(engine.list()).toEqual([
      expect.objectContaining({ canResume: true, receivedBytes: 4, state: 'paused' }),
    ]);
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('drops a mismatched partial file and its journal entry', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-journal-'));
    const finalPath = path.join(userDataPath, 'installers', 'tool.exe');
    const savePath = `${finalPath}.partial`;
    mkdirSync(path.dirname(savePath), { recursive: true });
    writeFileSync(savePath, 'short', { encoding: 'utf8', mode: 0o600 });
    new DownloadJournal(userDataPath).upsert({
      allowedHosts: ['downloads.example.com'],
      allowedPathPrefixes: ['/tool.exe'],
      finalPath,
      id: 'invalid-tool',
      label: '损坏工具',
      length: 20,
      maxBytes: 100,
      receivedBytes: 10,
      savePath,
      startTime: 1_700_000_000,
      urlChain: ['https://downloads.example.com/tool.exe'],
    });
    const electronSession = {
      createInterruptedDownload: vi.fn(),
      downloadURL: vi.fn(),
      on: vi.fn(),
    } satisfies DownloadSession;
    const engine = new DownloadEngine(
      electronSession,
      new BusyRegistry(),
      userDataPath,
    );

    engine.restoreInterrupted();

    expect(engine.list()).toEqual([]);
    expect(existsSync(savePath)).toBe(false);
    expect(new DownloadJournal(userDataPath).list()).toEqual([]);
    rmSync(userDataPath, { force: true, recursive: true });
  });
});
