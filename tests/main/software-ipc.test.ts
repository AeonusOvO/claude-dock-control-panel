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
});
