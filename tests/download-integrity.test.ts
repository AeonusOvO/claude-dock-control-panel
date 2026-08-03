import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../src/main/busy-registry';
import { DownloadEngine, type DownloadSession } from '../src/main/download-engine';

const createFixture = (urlChain = ['https://downloads.example.com/tool.exe']) => {
  const electronSession = Object.assign(new EventEmitter(), {
    createInterruptedDownload: vi.fn(),
    downloadURL: vi.fn(),
  });
  const item = Object.assign(new EventEmitter(), {
    canResume: vi.fn(() => true),
    cancel: vi.fn(),
    getETag: vi.fn(() => '"fixture"'),
    getLastModifiedTime: vi.fn(() => 'Mon, 01 Jan 2024 00:00:00 GMT'),
    getReceivedBytes: vi.fn(() => 4),
    getStartTime: vi.fn(() => Date.now() / 1000),
    getTotalBytes: vi.fn(() => 4),
    getURL: vi.fn(() => 'https://downloads.example.com/tool.exe'),
    getURLChain: vi.fn(() => urlChain),
    isPaused: vi.fn(() => false),
    pause: vi.fn(),
    resume: vi.fn(),
    setSavePath: vi.fn(),
  });
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-integrity-'));
  const finalPath = path.join(userDataPath, 'downloads', 'tool.exe');
  const engine = new DownloadEngine(
    electronSession as unknown as DownloadSession,
    new BusyRegistry(),
    userDataPath,
  );
  const start = (overrides: { expectedSha256?: string; maxBytes?: number } = {}) =>
    engine.start({
      allowedHosts: ['downloads.example.com'],
      allowedPathPrefixes: ['/tool.exe'],
      expectedBytes: 4,
      finalPath,
      id: 'tool',
      label: '测试下载',
      maxBytes: 100,
      url: 'https://downloads.example.com/tool.exe',
      ...overrides,
    });
  return { electronSession, engine, finalPath, item, start, userDataPath };
};

describe('download integrity gate', () => {
  it('deletes a completed partial when SHA-256 does not match', async () => {
    const fixture = createFixture();
    const completion = fixture.start({ expectedSha256: '0'.repeat(64) });
    fixture.electronSession.emit('will-download', { preventDefault: vi.fn() }, fixture.item);
    writeFileSync(`${fixture.finalPath}.partial`, 'data', { encoding: 'utf8', mode: 0o600 });
    fixture.item.emit('done', {}, 'completed');

    await expect(completion).rejects.toThrow('校验未通过，文件已删除');
    expect(existsSync(`${fixture.finalPath}.partial`)).toBe(false);
    expect(fixture.engine.list()[0]).toMatchObject({ state: 'failed' });
    rmSync(fixture.userDataPath, { force: true, recursive: true });
  });

  it('cancels a redirect chain containing an unapproved host', async () => {
    const fixture = createFixture([
      'https://downloads.example.com/tool.exe',
      'https://attacker.example.net/tool.exe',
    ]);
    const completion = fixture.start();
    fixture.electronSession.emit('will-download', { preventDefault: vi.fn() }, fixture.item);

    await expect(completion).rejects.toThrow('重定向链包含未获允许的来源');
    expect(fixture.item.cancel).toHaveBeenCalledOnce();
    rmSync(fixture.userDataPath, { force: true, recursive: true });
  });

  it('cancels immediately when the declared size exceeds the cap', async () => {
    const fixture = createFixture();
    fixture.item.getTotalBytes.mockReturnValue(4);
    const completion = fixture.start({ maxBytes: 3 });
    fixture.electronSession.emit('will-download', { preventDefault: vi.fn() }, fixture.item);

    await expect(completion).rejects.toThrow('超过安全上限');
    expect(fixture.item.cancel).toHaveBeenCalledOnce();
    rmSync(fixture.userDataPath, { force: true, recursive: true });
  });
});
