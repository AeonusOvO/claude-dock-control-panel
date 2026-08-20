import { describe, expect, it, vi } from 'vitest';
import type { DownloadTaskView } from '../../src/shared/contracts';
import { createRendererHarness } from '../helpers/renderer-harness';

const downloadTask = (overrides: Partial<DownloadTaskView> = {}): DownloadTaskView => ({
  bytesPerSecond: 512,
  canPause: true,
  canResume: false,
  elapsedMs: 2_000,
  id: 'download-1',
  label: 'Claude Code',
  percent: 50,
  receivedBytes: 512,
  remainingMs: 2_000,
  state: 'progressing',
  totalBytes: 1_024,
  ...overrides,
});

describe('renderer downloads feature', () => {
  it('renders active downloads, completed history and aggregate titlebar state', async () => {
    const harness = await createRendererHarness({
      listDownloads: vi.fn(async () => [
        downloadTask(),
        downloadTask({
          canPause: false,
          finishedAt: 2,
          id: 'history-1',
          label: 'Completed package',
          percent: 100,
          receivedBytes: 1_024,
          remainingMs: 0,
          state: 'completed',
        }),
      ]),
    });
    try {
      await harness.flush();
      expect(harness.query('#download-task-list').textContent).toContain('Claude Code');
      expect(harness.query('#download-history-list').textContent).toContain('Completed package');
      expect(harness.query('#download-active-count').textContent).toBe('1');
      expect(harness.query('#open-download-center').getAttribute('aria-label')).toContain(
        '1 项未完成',
      );
      expect(harness.document.body.dataset.downloading).toBe('true');
    } finally {
      await harness.cleanup();
    }
  });

  it('routes task controls and live download events through the bridge', async () => {
    const harness = await createRendererHarness({
      listDownloads: vi.fn(async () => [downloadTask()]),
    });
    try {
      await harness.flush();
      harness.click('.download-task__action--pause');
      expect(harness.method('pauseDownload')).toHaveBeenCalledWith('download-1');

      harness.emit('onDownloadsChanged', [
        downloadTask({
          canPause: false,
          canResume: true,
          label: 'Paused package',
          state: 'paused',
        }),
      ]);
      expect(harness.query('#download-task-list').textContent).toContain('Paused package');
      expect(harness.query('.download-task__action--resume')).toBeTruthy();
    } finally {
      await harness.cleanup();
    }
  });

  it('locks history removal while pending and restores the control after failure', async () => {
    let rejectDeletion: (reason: Error) => void = () => undefined;
    const deletion = new Promise<DownloadTaskView[]>((_, reject) => {
      rejectDeletion = reject;
    });
    const harness = await createRendererHarness({
      deleteDownloadHistory: vi.fn(() => deletion),
      listDownloads: vi.fn(async () => [
        downloadTask({
          canPause: false,
          finishedAt: 2,
          id: 'history-1',
          percent: 100,
          receivedBytes: 1_024,
          remainingMs: 0,
          state: 'completed',
        }),
      ]),
    });
    try {
      await harness.flush();
      const remove = harness.query<HTMLButtonElement>('.download-task__delete');
      remove.click();
      expect(harness.query('#confirmation-dialog').textContent).toContain('删除下载历史');
      harness.query<HTMLDialogElement>('#confirmation-dialog').close('confirm');
      await harness.flush();
      expect(harness.method('deleteDownloadHistory')).toHaveBeenCalledWith('history-1');
      expect(remove.disabled).toBe(true);

      rejectDeletion(new Error('synthetic deletion failure'));
      await harness.flush();
      expect(remove.disabled).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it('opens from both UI and main-process requests and disposes subscriptions on unload', async () => {
    const harness = await createRendererHarness();
    try {
      harness.click('#open-download-center');
      expect(harness.query<HTMLDialogElement>('#download-center-dialog').open).toBe(true);
      harness.click('#close-download-center');
      expect(harness.query<HTMLDialogElement>('#download-center-dialog').open).toBe(false);

      harness.emit('onOpenDownloadCenterRequested');
      expect(harness.query<HTMLDialogElement>('#download-center-dialog').open).toBe(true);
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('beforeunload'));
      expect(harness.method('onDownloadsChanged')).toHaveBeenCalledOnce();
      expect(harness.method('onBusyChanged')).toHaveBeenCalledOnce();
      expect(harness.method('onOpenDownloadCenterRequested')).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });
});
