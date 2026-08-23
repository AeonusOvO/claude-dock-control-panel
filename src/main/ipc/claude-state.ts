import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type {
  ClaudeConnectionTestResult,
  ClaudeProviderModelDiscoveryResult,
} from '../../shared/contracts';
import { officialNetworkProviderForClaudePreset } from '../../shared/claude/providers';
import { createFailureReporter } from '../infra/logger';
import { ProviderAccessBlockedError } from '../network/provider-access-guard';
import {
  ProviderModelDiscoveryError,
  resolveProviderModelDiscoveryTarget,
} from '../network/provider-model-discovery';
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
    | 'requireClaudeRuntime'
    | 'requireManagedChatGptGateway'
    | 'validateSender'
    | 'withOfficialProviderAccess'
  >;
  workspace: TerminalWorkspace;
}

const reportClaudeStateFailure = createFailureReporter('claude-connection');
const OFFICIAL_DISCOVERY_BLOCKED_MESSAGE =
  '官方模型列表访问已被网络预检阻止，请在网络预检详情中重新检查。';
const PROVIDER_DISCOVERY_FAILED_MESSAGE = '无法读取当前接口的模型列表。';

const providerModelDiscoveryFailure = (error: unknown): ClaudeProviderModelDiscoveryResult => {
  if (error instanceof ProviderAccessBlockedError) {
    const failure = reportClaudeStateFailure('environment', OFFICIAL_DISCOVERY_BLOCKED_MESSAGE);
    return {
      code: failure.code,
      error: failure.message,
      kind: failure.kind,
      message: failure.message,
      models: [],
      ok: false,
    };
  }

  const message =
    error instanceof ProviderModelDiscoveryError
      ? error.message
      : PROVIDER_DISCOVERY_FAILED_MESSAGE;
  return {
    ...reportClaudeStateFailure('external-service', message),
    error: message,
    models: [],
    ok: false,
  };
};

export const registerClaudeStateIpc = ({
  guards: {
    requireClaudeRuntime,
    requireManagedChatGptGateway,
    validateSender,
    withOfficialProviderAccess,
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
    async (
      event,
      sessionId: unknown,
      rawInput: unknown,
    ): Promise<ClaudeProviderModelDiscoveryResult> => {
      validateSender(event);
      try {
        const input = validateProviderModelDiscoveryInput(rawInput);
        const validatedSessionId = validateSessionId(sessionId);
        const status = workspace.getStatus(validatedSessionId);
        const target = resolveProviderModelDiscoveryTarget(input.baseUrl);
        const discover = async (): Promise<ClaudeProviderModelDiscoveryResult> => {
          const models = await requireClaudeRuntime().discoverProviderModels(
            target,
            input.credential,
          );
          return {
            message: `已从当前接口读取 ${models.length} 个可用模型。`,
            models,
            ok: true,
          };
        };
        if (!target.officialProvider) {
          return await discover();
        }
        return await withOfficialProviderAccess(
          {
            action: 'first-request',
            cwd: status.cwd,
            networkScope: 'application',
            provider: target.officialProvider,
            target: { process: 'application', url: target.endpoint },
          },
          discover,
        );
      } catch (error) {
        return providerModelDiscoveryFailure(error);
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
        const officialProvider = officialNetworkProviderForClaudePreset(validatedInput.preset);
        const runtime = requireClaudeRuntime();
        const testConnection = async (): Promise<ClaudeConnectionTestResult> => {
          // Readiness can make the sidecar contact its upstream provider, so it must remain behind the
          // same official-network decision as the real connection request.
          if (validatedInput.preset === 'chatgpt-subscription') {
            await requireManagedChatGptGateway().ensureRunning();
          }
          return runtime.testConnection(status.cwd, validatedInput);
        };
        if (!officialProvider) {
          return await testConnection();
        }
        return await withOfficialProviderAccess(
          {
            action: 'first-request',
            cwd: status.cwd,
            provider: officialProvider,
          },
          testConnection,
        );
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
