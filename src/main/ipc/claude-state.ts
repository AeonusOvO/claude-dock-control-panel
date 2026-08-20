import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  ClaudeConnectionTestResult,
  ClaudeProviderModelDiscoveryResult,
} from '../../shared/contracts';
import { officialNetworkProviderForClaudePreset } from '../../shared/claude/providers';
import { createFailureReporter } from '../infra/logger';
import type { TerminalWorkspace } from '../terminal/workspace';
import {
  validateClaudeConfigInput,
  validateProviderModelDiscoveryInput,
  validateSessionId,
} from './validation';
import type { MainGuards } from './guards';

export interface ClaudeStateIpcDependencies {
  guards: Pick<
    MainGuards,
    | 'assertOfficialProviderAllowed'
    | 'requireClaudeRuntime'
    | 'requireManagedChatGptGateway'
    | 'validateSender'
  >;
  workspace: TerminalWorkspace;
}

const reportClaudeStateFailure = createFailureReporter('claude-connection');

export const registerClaudeStateIpc = ({
  guards: {
    assertOfficialProviderAllowed,
    requireClaudeRuntime,
    requireManagedChatGptGateway,
    validateSender,
  },
  workspace,
}: ClaudeStateIpcDependencies): void => {
  ipcMain.handle(CHANNELS.CLAUDE_GET_STATE, async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getState(validatedSessionId, status.cwd);
  });
  ipcMain.handle(CHANNELS.CLAUDE_GET_GATEWAY_DIAGNOSTICS, async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getGatewayDiagnostics(status.cwd);
  });
  ipcMain.handle(
    CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER,
    async (event, rawInput: unknown): Promise<ClaudeProviderModelDiscoveryResult> => {
      validateSender(event);
      try {
        const input = validateProviderModelDiscoveryInput(rawInput);
        const models = await requireClaudeRuntime().discoverProviderModels(
          input.baseUrl,
          input.credential,
        );
        return {
          message: `已从当前接口读取 ${models.length} 个可用模型。`,
          models,
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法读取当前接口的模型列表。';
        return {
          ...reportClaudeStateFailure('external-service', message, error),
          error: message,
          models: [],
          ok: false,
        };
      }
    },
  );
  ipcMain.handle(CHANNELS.CLAUDE_MODEL_OPTIONS, async (event, sessionId: unknown) => {
    validateSender(event);
    const validatedSessionId = validateSessionId(sessionId);
    const status = workspace.getStatus(validatedSessionId);
    return requireClaudeRuntime().getModelOptions(status.cwd, validatedSessionId);
  });
  ipcMain.handle(
    CHANNELS.CLAUDE_TEST_CONNECTION,
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeConnectionTestResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        const validatedInput = validateClaudeConfigInput(input);
        // The ChatGPT subscription route is an app-owned loopback gateway. A saved project must be
        // able to survive an app or Windows restart without presenting the stopped child process as
        // a broken user configuration. Start it before both manual and automatic connection tests.
        if (validatedInput.preset === 'chatgpt-subscription') {
          await requireManagedChatGptGateway().ensureRunning();
        }
        const officialProvider = officialNetworkProviderForClaudePreset(validatedInput.preset);
        if (officialProvider) {
          await assertOfficialProviderAllowed(officialProvider, 'first-request', status.cwd);
        }
        return await requireClaudeRuntime().testConnection(status.cwd, validatedInput);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法测试 Claude 接入。';
        return {
          ...reportClaudeStateFailure('external-service', message, error),
          ok: false,
          stages: [
            { detail: message, id: 'endpoint', label: '接口地址', status: 'failed' },
            {
              detail: '请先修正配置。',
              id: 'authentication',
              label: '身份认证',
              status: 'skipped',
            },
            { detail: '尚未发送请求。', id: 'model', label: '模型响应', status: 'skipped' },
          ],
          testedAt: Date.now(),
          tone: 'error',
        };
      }
    },
  );
};
