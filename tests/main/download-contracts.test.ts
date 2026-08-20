import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadTaskView } from '../../src/shared/contracts';
import { CodexInstaller } from '../../src/main/codex/installer';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';
import { createRendererHarness } from '../helpers/renderer-harness';

const downloadTask = (
  overrides: Partial<DownloadTaskView> & Pick<DownloadTaskView, 'id' | 'label' | 'state'>,
): DownloadTaskView => ({
  bytesPerSecond: 0,
  canPause: false,
  canResume: false,
  elapsedMs: 1_000,
  percent: -1,
  receivedBytes: 0,
  remainingMs: -1,
  startedAt: 1,
  totalBytes: 0,
  ...overrides,
});

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('download contracts', () => {
  it('routes the real preload API through validated main handlers and forwards change events', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcMain: ipc.ipcMain,
      ipcRenderer: ipc.ipcRenderer,
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const [{ registerDownloadIpc }, { downloadBridge }] = await Promise.all([
      import('../../src/main/ipc/download'),
      import('../../src/preload/bridges/download'),
    ]);
    const task = downloadTask({ id: 'task-1', label: 'Runtime package', state: 'paused' });
    const engine = {
      cancel: vi.fn(() => ({ ...task, state: 'cancelled' as const })),
      clearHistory: vi.fn(() => []),
      deleteHistory: vi.fn(() => []),
      list: vi.fn(() => [task]),
      pause: vi.fn(() => task),
      resume: vi.fn(() => ({ ...task, state: 'progressing' as const })),
    };
    const validateSender = vi.fn();
    registerDownloadIpc({
      guards: {
        requireDownloadEngine: vi.fn(() => engine as never),
        validateSender,
      },
    });

    await expect(downloadBridge.listDownloads()).resolves.toEqual([task]);
    await expect(downloadBridge.pauseDownload('task-1')).resolves.toEqual(task);
    await expect(downloadBridge.resumeDownload('task-1')).resolves.toMatchObject({
      state: 'progressing',
    });
    await expect(downloadBridge.cancelDownload('task-1')).resolves.toMatchObject({
      state: 'cancelled',
    });
    await expect(downloadBridge.deleteDownloadHistory('task-1')).resolves.toEqual([]);
    await expect(downloadBridge.clearDownloadHistory()).resolves.toEqual([]);
    expect(validateSender).toHaveBeenCalledTimes(6);
    expect(engine.pause).toHaveBeenCalledWith('task-1');
    expect(engine.resume).toHaveBeenCalledWith('task-1');
    expect(engine.cancel).toHaveBeenCalledWith('task-1');
    expect(engine.deleteHistory).toHaveBeenCalledWith('task-1');

    await expect(downloadBridge.pauseDownload('')).rejects.toThrow('下载任务标识无效。');
    expect(engine.pause).toHaveBeenCalledOnce();

    const listener = vi.fn();
    const unsubscribe = downloadBridge.onDownloadsChanged(listener);
    ipc.emitFromMain(CHANNELS.DOWNLOAD_CHANGED, [task]);
    expect(listener).toHaveBeenCalledWith([task]);
    unsubscribe();
    ipc.emitFromMain(CHANNELS.DOWNLOAD_CHANGED, []);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('hands the verified official Codex installer asset to DownloadEngine before execution', async () => {
    const failure = new Error('stop after download handoff');
    const start = vi.fn(async () => {
      throw failure;
    });
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            assets: [
              {
                browser_download_url:
                  'https://github.com/openai/codex/releases/download/rust-v1.2.3/install.ps1',
                digest: `sha256:${'a'.repeat(64)}`,
                name: 'install.ps1',
                size: 12_345,
              },
            ],
            tag_name: 'rust-v1.2.3',
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
    );
    const userDataPath = 'D:\\ClaudeDockData';
    const installer = new CodexInstaller(
      userDataPath,
      { start } as never,
      { acquire: vi.fn() } as never,
      vi.fn(),
      fetchImplementation,
    );

    await expect(installer.installLatest()).rejects.toBe(failure);
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.github.com/repos/openai/codex/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'ClaudeDock' }),
      }),
    );
    expect(start).toHaveBeenCalledWith({
      allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
      allowedPathPrefixes: ['/openai/codex/releases/download/rust-v1.2.3/install.ps1', '/'],
      expectedBytes: 12_345,
      expectedSha256: 'a'.repeat(64),
      finalPath: path.join(userDataPath, 'claude', 'codex-installers', '1.2.3', 'install.ps1'),
      id: 'codex-installer-1.2.3',
      label: 'Codex 官方安装脚本',
      maxBytes: 1024 * 1024,
      url: 'https://github.com/openai/codex/releases/download/rust-v1.2.3/install.ps1',
    });
  });

  it('renders active actions and keeps settled download progress determinate', async () => {
    const tasks = [
      downloadTask({
        bytesPerSecond: 1_024,
        canPause: true,
        id: 'active-download',
        label: 'Active package',
        percent: 25,
        receivedBytes: 256,
        state: 'progressing',
        totalBytes: 1_024,
      }),
      downloadTask({
        canResume: true,
        id: 'paused-download',
        label: 'Paused package',
        state: 'paused',
      }),
      downloadTask({
        finishedAt: 2,
        id: 'completed-download',
        label: 'Completed package',
        percent: 100,
        receivedBytes: 1_024,
        remainingMs: 0,
        state: 'completed',
        totalBytes: 1_024,
      }),
    ];
    const harness = await createRendererHarness({
      cancelDownload: vi.fn(async () => tasks[0]!),
      listDownloads: vi.fn(async () => tasks),
      pauseDownload: vi.fn(async () => tasks[0]!),
      resumeDownload: vi.fn(async () => tasks[1]!),
    });
    try {
      harness.click('#open-download-center');
      expect(harness.query<HTMLDialogElement>('#download-center-dialog').open).toBe(true);
      expect(harness.query('#download-active-summary').textContent).toBe('2 项进行中');
      expect(harness.query('#download-history-summary').textContent).toBe('1 条记录');

      const active = harness.query<HTMLElement>(
        '#download-task-list .download-task[data-state="progressing"]',
      );
      expect(active.textContent).toContain('暂停');
      expect(active.textContent).toContain('取消');
      active.querySelector<HTMLButtonElement>('.download-task__action--pause')?.click();

      const paused = harness.query<HTMLElement>(
        '#download-task-list .download-task[data-state="paused"]',
      );
      expect(paused.textContent).toContain('继续');
      paused.querySelector<HTMLButtonElement>('.download-task__action--resume')?.click();
      await harness.flush();
      expect(harness.method('pauseDownload')).toHaveBeenCalledWith('active-download');
      expect(harness.method('resumeDownload')).toHaveBeenCalledWith('paused-download');

      const completedProgress = harness.query<HTMLElement>(
        '#download-history-list .download-task[data-state="completed"] .download-progress',
      );
      expect(completedProgress.dataset.indeterminate).toBe('false');
      expect(completedProgress.getAttribute('aria-busy')).toBe('false');
      expect(completedProgress.getAttribute('aria-valuenow')).toBe('100');
      expect(harness.query('#download-history-list').textContent).toContain('删除记录');
    } finally {
      await harness.cleanup();
    }
  });
});
