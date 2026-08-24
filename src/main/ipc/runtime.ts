import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type { DevelopmentRuntimeState, RuntimeActivitySnapshot } from '../../shared/contracts';
import type { ProjectRuntimeSwitchCoordinator } from '../coordination/main-process-operation';
import type { Registry } from '../infra/registry';
import { RUNTIME_PROCESS_REGISTRY } from '../infra/service-tokens';
import type { RuntimeActivityRegistry } from '../runtime/activity-registry';
import type { AgentRuntimeStore } from '../runtime/store';
import type { TerminalWorkspace } from '../terminal/workspace';
import { validateDevelopmentRuntime, validateSessionId } from './validation';
import type { MainGuards } from './guards';

export interface RuntimeIpcDependencies {
  agentRuntimeStore: AgentRuntimeStore;
  guards: Pick<MainGuards, 'validateSender'>;
  projectRuntimeSwitchOperations: ProjectRuntimeSwitchCoordinator;
  runtimeActivityRegistry: RuntimeActivityRegistry;
  services: Registry;
  workspace: TerminalWorkspace;
}

export const registerRuntimeIpc = ({
  agentRuntimeStore,
  guards: { validateSender },
  projectRuntimeSwitchOperations,
  runtimeActivityRegistry,
  services,
  workspace,
}: RuntimeIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.RUNTIME_GET_ACTIVITY,
    (event, sessionId: unknown): RuntimeActivitySnapshot => {
      validateSender(event);
      return runtimeActivityRegistry.get(validateSessionId(sessionId));
    },
  );
  ipcMain.handle(
    CHANNELS.RUNTIME_TERMINATE_PROCESS,
    async (event, sessionId: unknown, processKey: unknown): Promise<RuntimeActivitySnapshot> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      if (typeof processKey !== 'string' || processKey.length > 200) {
        throw new Error('进程控制请求无效。');
      }
      await services.resolve(RUNTIME_PROCESS_REGISTRY).terminate(validatedSessionId, processKey);
      return runtimeActivityRegistry.get(validatedSessionId);
    },
  );
  ipcMain.handle(CHANNELS.RUNTIME_GET, (event, sessionId: unknown): DevelopmentRuntimeState => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return {
      cwd: status.cwd,
      runtime: agentRuntimeStore.get(status.cwd),
      sessionId: validatedSessionId,
      switchOperation: projectRuntimeSwitchOperations.activeSwitch(status.cwd),
    };
  });
  ipcMain.handle(
    CHANNELS.RUNTIME_SET,
    async (event, sessionId: unknown, runtime: unknown): Promise<DevelopmentRuntimeState> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const selected = validateDevelopmentRuntime(runtime);
      const status = workspace.getStatus(validatedSessionId);
      const committedRuntime = await projectRuntimeSwitchOperations.switchRuntime(
        validatedSessionId,
        status.cwd,
        selected,
      );
      return {
        cwd: status.cwd,
        runtime: committedRuntime,
        sessionId: validatedSessionId,
      };
    },
  );
};
