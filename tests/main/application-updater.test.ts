import { describe, expect, it, vi } from 'vitest';
import {
  ApplicationUpdaterService,
  type ApplicationUpdaterDriver,
} from '../../src/main/updates/application';
import type { ApplicationUpdaterState } from '../../src/shared/contracts';

type DriverListener = (payload?: unknown) => void;

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
};

const createHarness = (enabled = true) => {
  const listeners = new Map<string, DriverListener[]>();
  const checkForUpdates = vi.fn<ApplicationUpdaterDriver['checkForUpdates']>(async () => ({
    isUpdateAvailable: false,
    updateInfo: { version: '5.0.0-rc.15' },
  }));
  const downloadUpdate = vi.fn<ApplicationUpdaterDriver['downloadUpdate']>(async () => []);
  const quitAndInstall = vi.fn<ApplicationUpdaterDriver['quitAndInstall']>();
  const driver: ApplicationUpdaterDriver = {
    allowDowngrade: true,
    allowPrerelease: true,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates,
    disableWebInstaller: false,
    downloadUpdate,
    on: vi.fn((event: string, listener: DriverListener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return driver;
    }),
    quitAndInstall,
  };
  const changes: ApplicationUpdaterState[] = [];
  const service = new ApplicationUpdaterService({
    currentVersion: '5.0.0-rc.15',
    driver,
    enabled,
    onChange: (state) => changes.push(state),
  });
  return {
    changes,
    checkForUpdates,
    downloadUpdate,
    driver,
    emit: (event: string, payload?: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    quitAndInstall,
    service,
  };
};

describe('application updater service', () => {
  it('enforces manual update policy and keeps disabled builds inert', async () => {
    const harness = createHarness(false);

    expect(harness.driver).toMatchObject({
      allowDowngrade: false,
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      disableWebInstaller: true,
    });
    expect(harness.driver.on).not.toHaveBeenCalled();
    expect(harness.service.getState()).toMatchObject({
      currentVersion: '5.0.0-rc.15',
      phase: 'disabled',
    });

    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'disabled' });
    await expect(harness.service.checkAndDownload()).resolves.toMatchObject({
      phase: 'disabled',
    });
    harness.emit('update-available', { version: '5.0.0-rc.16' });
    expect(harness.service.getState().phase).toBe('disabled');
    expect(harness.checkForUpdates).not.toHaveBeenCalled();
    expect(harness.downloadUpdate).not.toHaveBeenCalled();
    expect(() => harness.service.installDownloaded()).toThrow('更新安装包尚未下载完成。');
  });

  it('checks without downloading and preserves complete prerelease versions', async () => {
    const harness = createHarness();
    harness.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '5.0.0-rc.16' },
    });

    const state = await harness.service.check();

    expect(state).toMatchObject({
      currentVersion: '5.0.0-rc.15',
      latestVersion: '5.0.0-rc.16',
      phase: 'available',
    });
    expect(state.message).toContain('5.0.0-rc.16');
    expect(harness.checkForUpdates).toHaveBeenCalledOnce();
    expect(harness.downloadUpdate).not.toHaveBeenCalled();
    expect(harness.changes.map(({ phase }) => phase)).toEqual(['checking', 'available']);

    state.phase = 'error';
    expect(harness.service.getState().phase).toBe('available');
  });

  it('reports the current channel as up to date without starting a download', async () => {
    const harness = createHarness();

    const state = await harness.service.checkAndDownload();

    expect(state).toMatchObject({
      latestVersion: '5.0.0-rc.15',
      phase: 'up-to-date',
    });
    expect(harness.checkForUpdates).toHaveBeenCalledOnce();
    expect(harness.downloadUpdate).not.toHaveBeenCalled();
  });

  it('coalesces checks while allowing a download request to continue after the shared check', async () => {
    const harness = createHarness();
    const check = deferred<{
      isUpdateAvailable: boolean;
      updateInfo: { version: string };
    }>();
    const download = deferred<string[]>();
    harness.checkForUpdates.mockReturnValueOnce(check.promise);
    harness.downloadUpdate.mockReturnValueOnce(download.promise);

    const checkOnly = harness.service.check();
    const firstDownload = harness.service.checkAndDownload();
    const duplicateDownload = harness.service.checkAndDownload();
    expect(firstDownload).toBe(duplicateDownload);
    expect(harness.checkForUpdates).toHaveBeenCalledOnce();

    check.resolve({
      isUpdateAvailable: true,
      updateInfo: { version: '5.0.0-rc.16' },
    });
    await expect(checkOnly).resolves.toMatchObject({ phase: 'available' });
    await vi.waitFor(() => expect(harness.service.getState().phase).toBe('downloading'));
    expect(harness.downloadUpdate).toHaveBeenCalledOnce();

    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'downloading' });
    expect(harness.checkForUpdates).toHaveBeenCalledOnce();
    harness.emit('download-progress', {
      bytesPerSecond: 2_048,
      percent: 49.6,
      total: 4_096,
      transferred: 2_032,
    });
    expect(harness.service.getState()).toMatchObject({
      bytesPerSecond: 2_048,
      downloadedBytes: 2_032,
      latestVersion: '5.0.0-rc.16',
      percent: 49.6,
      phase: 'downloading',
      totalBytes: 4_096,
    });
    expect(harness.service.getState().message).toContain('50%');

    harness.emit('update-downloaded', { version: '5.0.0-rc.16' });
    download.resolve([]);
    await expect(firstDownload).resolves.toMatchObject({
      latestVersion: '5.0.0-rc.16',
      percent: 100,
      phase: 'downloaded',
    });
    await harness.service.check();
    expect(harness.checkForUpdates).toHaveBeenCalledOnce();

    harness.service.installDownloaded();
    expect(harness.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('surfaces check, download, and driver errors without losing the latest version', async () => {
    const harness = createHarness();
    harness.checkForUpdates.mockRejectedValueOnce(new Error('feed offline'));

    await expect(harness.service.check()).resolves.toMatchObject({
      message: '应用更新失败：feed offline',
      phase: 'error',
    });

    harness.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '5.0.0-rc.16' },
    });
    harness.downloadUpdate.mockRejectedValueOnce(new Error('SHA-512 mismatch'));
    await expect(harness.service.checkAndDownload()).resolves.toMatchObject({
      latestVersion: '5.0.0-rc.16',
      message: '应用更新失败：SHA-512 mismatch',
      phase: 'error',
    });

    harness.emit('error', 'untrusted non-error payload');
    expect(harness.service.getState()).toMatchObject({
      latestVersion: '5.0.0-rc.16',
      message: '应用更新失败：更新服务暂时不可用。',
      phase: 'error',
    });
  });

  it('treats a missing check result as an updater error', async () => {
    const harness = createHarness();
    harness.checkForUpdates.mockResolvedValueOnce(null);

    await expect(harness.service.check()).resolves.toMatchObject({
      message: '应用更新失败：更新服务未返回检查结果。',
      phase: 'error',
    });
    expect(harness.downloadUpdate).not.toHaveBeenCalled();
  });
});
