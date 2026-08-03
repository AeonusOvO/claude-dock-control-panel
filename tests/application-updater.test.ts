import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationUpdaterService,
  type ApplicationUpdaterDriver,
} from '../src/main/application-updater';
import type { ApplicationUpdateSourceSelection } from '../src/main/application-update-sources';

const directories: string[] = [];
const sha512 = (value: Uint8Array): string => createHash('sha512').update(value).digest('base64');

const createDriver = (): ApplicationUpdaterDriver & {
  emit: (event: string, payload?: unknown) => void;
} => {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  return {
    allowDowngrade: true,
    allowPrerelease: true,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => null),
    disableWebInstaller: false,
    downloadUpdate: vi.fn(async () => []),
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  };
};

const createInstaller = (content: Uint8Array): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-updater-'));
  directories.push(directory);
  const installerPath = path.join(directory, 'ClaudeDock-Setup-4.1.0-x64.exe');
  writeFileSync(installerPath, content);
  return installerPath;
};

const sourceSelection = (content: Uint8Array): ApplicationUpdateSourceSelection => ({
  allowedHosts: ['124.221.158.247'],
  expectedInstaller: {
    name: 'ClaudeDock-Setup-4.1.0-x64.exe',
    sampleSha512: sha512(content),
    sampleSize: content.byteLength,
    sha512: sha512(content),
    size: content.byteLength,
  },
  feed: { provider: 'generic', url: 'https://124.221.158.247/claudedock/windows/x64/' },
  id: 'mirror',
  label: '中国大陆 HTTPS 兜底镜像',
  manifestDigest: 'A'.repeat(88),
  releaseBaseUrl: 'https://124.221.158.247/claudedock/windows/x64/',
  releaseVersion: '4.1.0',
  sourceDiagnostics: [],
  throughputBps: 2_000_000,
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('ApplicationUpdaterService', () => {
  it('downloads an available release and reports readiness only after the independent digest check', async () => {
    const content = new Uint8Array([1, 2, 3, 4]);
    const installerPath = createInstaller(content);
    const selection = sourceSelection(content);
    const driver = createDriver();
    driver.checkForUpdates = vi.fn(async () => {
      driver.emit('update-available', { version: '4.1.0' });
      return { isUpdateAvailable: true, updateInfo: { version: '4.1.0' } };
    });
    driver.downloadUpdate = vi.fn(async () => {
      driver.emit('download-progress', {
        bytesPerSecond: 1024,
        percent: 50,
        total: 4,
        transferred: 2,
      });
      driver.emit('update-downloaded', { version: '4.1.0' });
      return [installerPath];
    });
    const changes: string[] = [];
    const trustedVersions: string[] = [];
    const configureSource = vi.fn();
    const service = new ApplicationUpdaterService({
      configureSource,
      currentVersion: '4.0.0',
      driver,
      enabled: true,
      onChange: ({ phase }) => changes.push(phase),
      onTrustedVersion: (version) => trustedVersions.push(version),
      selectSource: async () => selection,
    });

    const state = await service.checkAndDownload();

    expect(state).toMatchObject({
      latestVersion: '4.1.0',
      percent: 100,
      phase: 'downloaded',
      sourceId: 'mirror',
      sourceThroughputBps: 2_000_000,
    });
    expect(driver.setFeedURL).toHaveBeenCalledWith(selection.feed);
    expect(configureSource).toHaveBeenCalledWith(selection);
    expect(trustedVersions).toEqual(['4.1.0']);
    expect(changes).toContain('downloading');
    expect(driver.allowDowngrade).toBe(false);
    expect(driver.allowPrerelease).toBe(false);
    expect(driver.autoDownload).toBe(false);
    expect(driver.autoInstallOnAppQuit).toBe(false);
    expect(driver.disableWebInstaller).toBe(true);
    service.installDownloaded();
    expect(driver.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('rejects a tampered installer after electron-updater reports download completion', async () => {
    const expected = new Uint8Array([1, 2, 3, 4]);
    const installerPath = createInstaller(new Uint8Array([9, 9, 9, 9]));
    const driver = createDriver();
    driver.checkForUpdates = vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '4.1.0' },
    }));
    driver.downloadUpdate = vi.fn(async () => {
      driver.emit('update-downloaded', { version: '4.1.0' });
      return [installerPath];
    });
    const service = new ApplicationUpdaterService({
      currentVersion: '4.0.0',
      driver,
      enabled: true,
      onChange: vi.fn(),
      selectSource: async () => sourceSelection(expected),
    });

    await expect(service.checkAndDownload()).resolves.toMatchObject({
      message: expect.stringContaining('SHA-512'),
      phase: 'error',
    });
    expect(() => service.installDownloaded()).toThrow('尚未下载完成');
  });

  it('rejects updater metadata that disagrees with the signed manifest version', async () => {
    const content = new Uint8Array([1, 2, 3, 4]);
    const driver = createDriver();
    driver.checkForUpdates = vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '4.2.0' },
    }));
    const service = new ApplicationUpdaterService({
      currentVersion: '4.0.0',
      driver,
      enabled: true,
      onChange: vi.fn(),
      selectSource: async () => sourceSelection(content),
    });

    await expect(service.checkAndDownload()).resolves.toMatchObject({
      message: expect.stringContaining('签名发布清单声明 4.1.0'),
      phase: 'error',
    });
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
  });

  it('does not contact an update provider outside the packaged Windows build', async () => {
    const driver = createDriver();
    const service = new ApplicationUpdaterService({
      currentVersion: '4.0.0',
      driver,
      enabled: false,
      onChange: vi.fn(),
    });

    expect(await service.checkAndDownload()).toMatchObject({ phase: 'disabled' });
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
  });
});
