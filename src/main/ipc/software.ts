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
  ipcMain.handle(CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET, (event) => {
    validateSender(event);
    return services.resolve(APPLICATION_UPDATER_SERVICE).getState();
  });
  ipcMain.handle(CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD, async (event) => {
    validateSender(event);
    assertApplicationUpdatesAllowed();
    return services.resolve(APPLICATION_UPDATER_SERVICE).checkAndDownload();
  });
  ipcMain.handle(CHANNELS.SOFTWARE_APPLICATION_UPDATER_INSTALL, async (event) => {
    validateSender(event);
    assertApplicationUpdatesAllowed();
    const applicationUpdaterService = services.resolve(APPLICATION_UPDATER_SERVICE);
    if (applicationUpdaterService.getState().phase !== 'downloaded') {
      throw new Error('更新安装包尚未下载完成。');
    }
    services.resolve(CLAUDE_PERMISSION_BRIDGE).shutdown();
    const runtimeProcessRegistry = services.resolve(RUNTIME_PROCESS_REGISTRY);
    await runtimeProcessRegistry.terminateAll();
    runtimeProcessRegistry.stop();
    state.isQuitting = true;
    try {
      applicationUpdaterService.installDownloaded();
    } catch (error) {
      state.isQuitting = false;
      throw error;
    }
  });
};
