import { describe, expect, it, vi } from 'vitest';
import {
  ApplicationUpdaterService,
  type ApplicationUpdaterDriver,
} from '../src/main/application-updater';

const createDriver = (): ApplicationUpdaterDriver & {
  emit: (event: string, payload?: unknown) => void;
} => {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  return {
    allowPrerelease: true,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    quitAndInstall: vi.fn(),
  };
};

describe('ApplicationUpdaterService', () => {
  it('downloads an available release and reports verified readiness', async () => {
    const driver = createDriver();
    driver.checkForUpdates = vi.fn(async () => {
      driver.emit('update-available', { version: '3.6.0' });
      return { isUpdateAvailable: true, updateInfo: { version: '3.6.0' } };
    });
    driver.downloadUpdate = vi.fn(async () => {
      driver.emit('download-progress', {
        bytesPerSecond: 1024,
        percent: 50,
        total: 2048,
        transferred: 1024,
      });
      driver.emit('update-downloaded', { version: '3.6.0' });
      return ['ClaudeDock-Setup-3.6.0-x64.exe'];
    });
    const changes: string[] = [];
    const service = new ApplicationUpdaterService({
      currentVersion: '3.5.0',
      driver,
      enabled: true,
      onChange: ({ phase }) => changes.push(phase),
    });

    const state = await service.checkAndDownload();

    expect(state).toMatchObject({ latestVersion: '3.6.0', percent: 100, phase: 'downloaded' });
    expect(changes).toContain('downloading');
    expect(driver.autoDownload).toBe(false);
    expect(driver.autoInstallOnAppQuit).toBe(false);
    service.installDownloaded();
    expect(driver.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('does not contact an update provider outside the packaged Windows build', async () => {
    const driver = createDriver();
    const service = new ApplicationUpdaterService({
      currentVersion: '3.5.0',
      driver,
      enabled: false,
      onChange: vi.fn(),
    });

    expect(await service.checkAndDownload()).toMatchObject({ phase: 'disabled' });
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
  });
});
