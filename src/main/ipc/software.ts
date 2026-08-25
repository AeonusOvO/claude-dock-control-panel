import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type { SoftwareUpdateOperationResult } from '../../shared/contracts';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import {
  APPLICATION_UPDATER_SERVICE,
  BUSY_REGISTRY,
  CLAUDE_PERMISSION_BRIDGE,
  RUNTIME_PROCESS_REGISTRY,
} from '../infra/service-tokens';
import type { MainState } from './context';
import type { MainGuards } from './guards';

export interface SoftwareIpcDependencies {
  guards: Pick<
    MainGuards,
    'assertApplicationUpdatesAllowed' | 'requireClaudeRuntime' | 'validateSender'
  >;
  services: Registry;
  state: MainState;
}

const reportSoftwareFailure = createFailureReporter('software-update');

export const registerSoftwareIpc = ({
  guards: { assertApplicationUpdatesAllowed, requireClaudeRuntime, validateSender },
  services,
  state,
}: SoftwareIpcDependencies): void => {
  const installDownloadedApplicationUpdate = async (): Promise<void> => {
    const applicationUpdaterService = services.resolve(APPLICATION_UPDATER_SERVICE);
    try {
      await applicationUpdaterService.installDownloaded(async () => {
        // Latch before asynchronous cleanup so no new session can enter while the owned process
        // set is being drained. The regular before-quit contributions stop the observer only after
        // quitAndInstall has successfully asked Electron to quit; a synchronous installer failure
        // therefore leaves the registry usable for a retry.
        state.isQuitting = true;
        const runtimeProcessRegistry = services.resolve(RUNTIME_PROCESS_REGISTRY);
        await runtimeProcessRegistry.terminateAll();
        services.resolve(CLAUDE_PERMISSION_BRIDGE).shutdown();
      });
    } catch (error) {
      state.isQuitting = false;
      throw error;
    }
  };

  ipcMain.handle(CHANNELS.SOFTWARE_UPDATES_GET, async (event, refresh: unknown) => {
    validateSender(event);
    return requireClaudeRuntime().getSoftwareUpdates(refresh === true);
  });
  ipcMain.handle(
    CHANNELS.SOFTWARE_CLAUDE_INSTALL_UPDATE,
    async (event): Promise<SoftwareUpdateOperationResult> => {
      validateSender(event);
      assertApplicationUpdatesAllowed();
      const runtime = requireClaudeRuntime();
      const operationId = CHANNELS.SOFTWARE_CLAUDE_INSTALL_UPDATE;
      const release = services.resolve(BUSY_REGISTRY).acquire({
        action: 'update',
        cancellable: false,
        domain: 'claude-code',
        id: operationId,
        kind: 'install',
        label: 'Claude Code',
        severity: 'blocking',
        stage: '准备安装或更新',
        target: 'Claude Code',
      });
      let logTail: string[] = [];
      try {
        const result = await runtime.installOrUpdateClaudeCode(({ line, stage }) => {
          if (line) logTail = [...logTail, line].slice(-8);
          services.resolve(BUSY_REGISTRY).update(operationId, { logTail, stage });
        });
        return { message: result.message, ok: true, state: result.state };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法安装或更新 Claude Code。';
        return {
          ...reportSoftwareFailure('external-service', message, error),
          error: message,
          ok: false,
          state: await runtime.getSoftwareUpdates(true),
        };
      } finally {
        release();
      }
    },
  );
  ipcMain.handle(CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET, (event, refresh: unknown) => {
    validateSender(event);
    const applicationUpdater = services.resolve(APPLICATION_UPDATER_SERVICE);
    return refresh === true ? applicationUpdater.check() : applicationUpdater.getState();
  });
  ipcMain.handle(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD, async (event) => {
    validateSender(event);
    assertApplicationUpdatesAllowed();
    const applicationUpdater = services.resolve(APPLICATION_UPDATER_SERVICE);
    const result = await applicationUpdater.checkAndDownload();
    if (result.phase === 'downloaded') {
      await installDownloadedApplicationUpdate();
      return applicationUpdater.getState();
    }
    return result;
  });
  ipcMain.handle(CHANNELS.SOFTWARE_APPLICATION_UPDATER_INSTALL, async (event) => {
    validateSender(event);
    assertApplicationUpdatesAllowed();
    await installDownloadedApplicationUpdate();
  });
};
