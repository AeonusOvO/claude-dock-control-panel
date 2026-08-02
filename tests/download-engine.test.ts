import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../src/main/busy-registry';
import {
  calculateDownloadProgress,
  DownloadEngine,
  type DownloadSession,
  exponentialMovingAverage,
  mapDownloadItemState,
} from '../src/main/download-engine';

describe('download engine', () => {
  it('smooths speed with EMA and calculates ETA', () => {
    expect(exponentialMovingAverage(1_000, 1_000, 500)).toBe(1_300);
    expect(calculateDownloadProgress(250, 1_000, 250)).toEqual({
      percent: 25,
      remainingMs: 3_000,
    });
  });

  it('uses -1 for unknown length without inventing progress', () => {
    expect(calculateDownloadProgress(250, 0, 250)).toEqual({
      percent: -1,
      remainingMs: -1,
    });
  });

  it('maps Electron updates to stable domain states', () => {
    expect(mapDownloadItemState('progressing', false, true)).toBe('progressing');
    expect(mapDownloadItemState('progressing', true, true)).toBe('paused');
    expect(mapDownloadItemState('interrupted', false, true)).toBe('paused');
    expect(mapDownloadItemState('interrupted', false, false)).toBe('failed');
  });

  it('captures DownloadItem and exposes pause, resume and cancellation', async () => {
    const session = new EventEmitter() as EventEmitter & { downloadURL: (url: string) => void };
    session.downloadURL = vi.fn();
    Object.assign(session, { createInterruptedDownload: vi.fn() });
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-download-'));
    const item = Object.assign(new EventEmitter(), {
      canResume: vi.fn(() => true),
      cancel: vi.fn(),
      getReceivedBytes: vi.fn(() => 100),
      getETag: vi.fn(() => '"fixture"'),
      getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
      getStartTime: vi.fn(() => Date.now() / 1000),
      getTotalBytes: vi.fn(() => 1_000),
      getURL: vi.fn(() => 'https://downloads.example.com/tool.exe'),
      getURLChain: vi.fn(() => ['https://downloads.example.com/tool.exe']),
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
      resume: vi.fn(),
      setSavePath: vi.fn(),
    });
    const engine = new DownloadEngine(
      session as unknown as DownloadSession,
      new BusyRegistry(),
      userDataPath,
    );
    const finalPath = path.join(userDataPath, 'outputs', 'test-tool.exe');
    const completion = engine
      .start({
        allowedHosts: ['downloads.example.com'],
        allowedPathPrefixes: ['/tool.exe'],
        finalPath,
        id: 'tool',
        label: '测试工具',
        maxBytes: 10_000,
        url: 'https://downloads.example.com/tool.exe',
      })
      .catch(() => undefined);
    session.emit('will-download', { preventDefault: vi.fn() }, item);

    expect(item.setSavePath).toHaveBeenCalledWith(`${finalPath}.partial`);
    expect(engine.list()[0]).toMatchObject({ percent: 10, state: 'progressing' });
    engine.pause('tool');
    expect(item.pause).toHaveBeenCalledOnce();
    engine.resume('tool');
    expect(item.resume).toHaveBeenCalledOnce();
    engine.cancel('tool');
    expect(item.cancel).toHaveBeenCalledOnce();
    item.emit('done', {}, 'cancelled');
    await completion;
    expect(engine.list()[0]?.state).toBe('cancelled');
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('continues a resumable interruption automatically instead of failing the task', async () => {
    vi.useFakeTimers();
    try {
      const session = new EventEmitter() as EventEmitter & { downloadURL: (url: string) => void };
      session.downloadURL = vi.fn();
      Object.assign(session, { createInterruptedDownload: vi.fn() });
      const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-download-'));
      let state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' = 'progressing';
      const item = Object.assign(new EventEmitter(), {
        canResume: vi.fn(() => true),
        cancel: vi.fn(),
        getReceivedBytes: vi.fn(() => 100),
        getETag: vi.fn(() => '"fixture"'),
        getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
        getStartTime: vi.fn(() => Date.now() / 1000),
        getState: vi.fn(() => state),
        getTotalBytes: vi.fn(() => 1_000),
        getURL: vi.fn(() => 'https://downloads.example.com/tool.exe'),
        getURLChain: vi.fn(() => ['https://downloads.example.com/tool.exe']),
        isPaused: vi.fn(() => false),
        pause: vi.fn(),
        resume: vi.fn(),
        setSavePath: vi.fn(),
      });
      const engine = new DownloadEngine(
        session as unknown as DownloadSession,
        new BusyRegistry(),
        userDataPath,
      );
      const finalPath = path.join(userDataPath, 'outputs', 'test-tool.exe');
      const completion = engine
        .start({
          allowedHosts: ['downloads.example.com'],
          allowedPathPrefixes: ['/tool.exe'],
          finalPath,
          id: 'tool',
          label: '测试工具',
          maxBytes: 10_000,
          url: 'https://downloads.example.com/tool.exe',
        })
        .catch(() => undefined);
      session.emit('will-download', { preventDefault: vi.fn() }, item);

      state = 'interrupted';
      item.emit('done', {}, 'interrupted');
      expect(engine.list()[0]).toMatchObject({ state: 'paused' });
      expect(engine.list()[0]?.errorMessage).toContain('自动续传');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(item.resume).toHaveBeenCalledOnce();
      expect(engine.list()[0]).toMatchObject({ errorMessage: undefined, state: 'progressing' });

      engine.cancel('tool');
      state = 'cancelled';
      item.emit('done', {}, 'cancelled');
      await completion;
      expect(engine.list()[0]?.state).toBe('cancelled');
      rmSync(userDataPath, { force: true, recursive: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
