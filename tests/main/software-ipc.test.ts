import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationUpdaterState } from '../../src/shared/contracts';
import { createIpcHarness } from '../helpers/ipc-harness';

const cachedState: ApplicationUpdaterState = {
  currentVersion: '5.0.0-rc.15',
  message: 'Cached updater state.',
  phase: 'idle',
};

const checkedState: ApplicationUpdaterState = {
  currentVersion: '5.0.0-rc.15',
  latestVersion: '5.0.0-rc.16',
  message: 'Update available.',
  phase: 'available',
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('software update IPC', () => {
  it('uses the existing GET route for check-only refresh and reserves download for its explicit route', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const [{ Registry }, { APPLICATION_UPDATER_SERVICE }, { registerSoftwareIpc }, { CHANNELS }] =
      await Promise.all([
        import('../../src/main/infra/registry'),
        import('../../src/main/infra/service-tokens'),
        import('../../src/main/ipc/software'),
        import('../../src/shared/ipc/channels'),
      ]);
    const applicationUpdater = {
      check: vi.fn(async () => checkedState),
      checkAndDownload: vi.fn(async () => ({ ...checkedState, phase: 'downloading' as const })),
      getState: vi.fn(() => cachedState),
      installDownloaded: vi.fn(),
    };
    const services = new Registry();
    services.register(APPLICATION_UPDATER_SERVICE, () => applicationUpdater as never);
    const assertApplicationUpdatesAllowed = vi.fn();
    const validateSender = vi.fn();
    registerSoftwareIpc({
      guards: {
        assertApplicationUpdatesAllowed,
        requireClaudeRuntime: vi.fn(),
        validateSender,
      },
      services,
      state: { isQuitting: false } as never,
    });

    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET)).resolves.toEqual(
      cachedState,
    );
    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET, false)).resolves.toEqual(
      cachedState,
    );
    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET, true)).resolves.toEqual(
      checkedState,
    );
    expect(applicationUpdater.getState).toHaveBeenCalledTimes(2);
    expect(applicationUpdater.check).toHaveBeenCalledOnce();
    expect(applicationUpdater.checkAndDownload).not.toHaveBeenCalled();
    expect(assertApplicationUpdatesAllowed).not.toHaveBeenCalled();

    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD)).resolves.toMatchObject(
      { phase: 'downloading' },
    );
    expect(assertApplicationUpdatesAllowed).toHaveBeenCalledOnce();
    expect(applicationUpdater.checkAndDownload).toHaveBeenCalledOnce();
    expect(validateSender).toHaveBeenCalledTimes(4);
  });

  it('automatically prepares and installs only after the explicit download route completes', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const [
      { Registry },
      { APPLICATION_UPDATER_SERVICE, CLAUDE_PERMISSION_BRIDGE, RUNTIME_PROCESS_REGISTRY },
      { registerSoftwareIpc },
      { CHANNELS },
    ] = await Promise.all([
      import('../../src/main/infra/registry'),
      import('../../src/main/infra/service-tokens'),
      import('../../src/main/ipc/software'),
      import('../../src/shared/ipc/channels'),
    ]);
    const downloadedState: ApplicationUpdaterState = {
      currentVersion: '5.0.0-rc.15',
      latestVersion: '5.0.0-rc.16',
      message: 'Downloaded and verified.',
      phase: 'downloaded',
    };
    const installingState: ApplicationUpdaterState = {
      ...downloadedState,
      message: 'Installing.',
      phase: 'installing',
    };
    const lifecycle: string[] = [];
    const applicationUpdater = {
      check: vi.fn(async () => checkedState),
      checkAndDownload: vi.fn(async () => downloadedState),
      getState: vi.fn(() => installingState),
      installDownloaded: vi.fn(async (prepareInstall: () => Promise<void>) => {
        lifecycle.push('install.begin');
        await prepareInstall();
        lifecycle.push('install.launch');
      }),
    };
    const permissionBridge = {
      shutdown: vi.fn(() => lifecycle.push('permission.shutdown')),
    };
    const runtimeProcessRegistry = {
      stop: vi.fn(() => lifecycle.push('runtime.stop')),
      terminateAll: vi.fn(async () => {
        lifecycle.push('runtime.terminate');
      }),
    };
    const services = new Registry();
    services.register(APPLICATION_UPDATER_SERVICE, () => applicationUpdater as never);
    services.register(CLAUDE_PERMISSION_BRIDGE, () => permissionBridge as never);
    services.register(RUNTIME_PROCESS_REGISTRY, () => runtimeProcessRegistry as never);
    const state = { isQuitting: false };
    registerSoftwareIpc({
      guards: {
        assertApplicationUpdatesAllowed: vi.fn(),
        requireClaudeRuntime: vi.fn(),
        validateSender: vi.fn(),
      },
      services,
      state: state as never,
    });

    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD)).resolves.toEqual(
      installingState,
    );

    expect(applicationUpdater.checkAndDownload).toHaveBeenCalledOnce();
    expect(applicationUpdater.installDownloaded).toHaveBeenCalledOnce();
    expect(permissionBridge.shutdown).toHaveBeenCalledOnce();
    expect(runtimeProcessRegistry.terminateAll).toHaveBeenCalledOnce();
    expect(runtimeProcessRegistry.stop).not.toHaveBeenCalled();
    expect(state.isQuitting).toBe(true);
    expect(lifecycle).toEqual([
      'install.begin',
      'runtime.terminate',
      'permission.shutdown',
      'install.launch',
    ]);
  });

  it('does not install when download fails and restores quitting state when launch fails', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const [
      { Registry },
      { APPLICATION_UPDATER_SERVICE, CLAUDE_PERMISSION_BRIDGE, RUNTIME_PROCESS_REGISTRY },
      { registerSoftwareIpc },
      { CHANNELS },
    ] = await Promise.all([
      import('../../src/main/infra/registry'),
      import('../../src/main/infra/service-tokens'),
      import('../../src/main/ipc/software'),
      import('../../src/shared/ipc/channels'),
    ]);
    const failedState: ApplicationUpdaterState = {
      currentVersion: '5.0.0-rc.15',
      latestVersion: '5.0.0-rc.16',
      message: '应用更新失败：SHA-512 mismatch',
      phase: 'error',
    };
    const downloadedState: ApplicationUpdaterState = {
      ...failedState,
      message: 'Downloaded and verified.',
      phase: 'downloaded',
    };
    const applicationUpdater = {
      check: vi.fn(async () => checkedState),
      checkAndDownload: vi
        .fn()
        .mockResolvedValueOnce(failedState)
        .mockResolvedValueOnce(downloadedState)
        .mockResolvedValueOnce(downloadedState),
      getState: vi.fn(() => failedState),
      installDownloaded: vi.fn(async (prepareInstall: () => Promise<void>) => {
        await prepareInstall();
        throw new Error('installer launch failed');
      }),
    };
    const permissionBridge = { shutdown: vi.fn() };
    const runtimeProcessRegistry = {
      stop: vi.fn(),
      terminateAll: vi
        .fn()
        .mockRejectedValueOnce(new Error('runtime cleanup failed'))
        .mockResolvedValueOnce(undefined),
    };
    const services = new Registry();
    services.register(APPLICATION_UPDATER_SERVICE, () => applicationUpdater as never);
    services.register(CLAUDE_PERMISSION_BRIDGE, () => permissionBridge as never);
    services.register(RUNTIME_PROCESS_REGISTRY, () => runtimeProcessRegistry as never);
    const state = { isQuitting: false };
    registerSoftwareIpc({
      guards: {
        assertApplicationUpdatesAllowed: vi.fn(),
        requireClaudeRuntime: vi.fn(),
        validateSender: vi.fn(),
      },
      services,
      state: state as never,
    });

    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD)).resolves.toEqual(
      failedState,
    );
    expect(applicationUpdater.installDownloaded).not.toHaveBeenCalled();
    expect(permissionBridge.shutdown).not.toHaveBeenCalled();

    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD)).rejects.toThrow(
      'runtime cleanup failed',
    );
    expect(applicationUpdater.installDownloaded).toHaveBeenCalledOnce();
    expect(permissionBridge.shutdown).not.toHaveBeenCalled();
    expect(runtimeProcessRegistry.stop).not.toHaveBeenCalled();
    expect(state.isQuitting).toBe(false);

    await expect(ipc.invoke(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD)).rejects.toThrow(
      'installer launch failed',
    );
    expect(applicationUpdater.installDownloaded).toHaveBeenCalledTimes(2);
    expect(permissionBridge.shutdown).toHaveBeenCalledOnce();
    expect(runtimeProcessRegistry.stop).not.toHaveBeenCalled();
    expect(state.isQuitting).toBe(false);
  });
});
