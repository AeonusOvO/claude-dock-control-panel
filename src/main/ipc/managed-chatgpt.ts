import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain, shell } from 'electron';
import type {
  ClaudeConnectionTestResult,
  ClaudeProjectState,
  ManagedChatGptGatewayOperationResult,
  ManagedChatGptSetupStage,
  OperationResult,
  SaveClaudeConfigInput,
} from '../../shared/contracts';
import type { RunClaudeProjectConfigTransaction } from '../claude/config-transaction';
import type { ManagedChatGptGatewayProjectConfig } from '../claude/managed-chatgpt-gateway';
import { ManagedChatGptGlobalSetupCoordinator } from '../claude/managed-chatgpt-setup';
import type { ClaudeRuntime, PreparedClaudeConfigSave } from '../claude/runtime';
import type { WithSessionOperation } from '../coordination/session-operation';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { MAIN_WINDOW } from '../infra/service-tokens';
import {
  cleanupFailedRuntimeLaunch,
  type FailedRuntimeLaunchCleanupDependencies,
  type RestartRuntimeTerminal,
} from '../terminal/lifecycle';
import type { TerminalWorkspace } from '../terminal/workspace';
import { validateSessionId } from './validation';
import type { MainGuards } from './guards';

export interface ManagedChatGptIpcDependencies {
  /* Every domain that writes project configuration reports the same rolled-back state. */
  configTransactionState: (error: unknown) => ClaudeProjectState | undefined;
  failedRuntimeLaunchCleanupDependencies: FailedRuntimeLaunchCleanupDependencies;
  guards: Pick<
    MainGuards,
    | 'withOfficialProviderAccess'
    | 'requireClaudeRuntime'
    | 'requireManagedChatGptGateway'
    | 'validateSender'
  >;
  restartRuntimeTerminal: RestartRuntimeTerminal;
  runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  services: Registry;
  withDevelopmentSessionOperation: WithSessionOperation;
  /* The terminal transition coordinator suppresses the same invalidations, so the assembly owns it. */
  withoutTerminalOperationInvalidation: <T>(sessionId: string, operation: () => T) => T;
  workspace: TerminalWorkspace;
}

const reportManagedChatGptFailure = createFailureReporter('managed-chatgpt');

const managedChatGptConnectionFailure = (
  connectionTest: ClaudeConnectionTestResult,
  message: string,
) =>
  connectionTest.code && connectionTest.detail && connectionTest.kind
    ? {
        code: connectionTest.code,
        detail: connectionTest.detail,
        kind: connectionTest.kind,
        message,
      }
    : reportManagedChatGptFailure('external-service', message, connectionTest);

const managedChatGptConfigInput = (
  managed: ManagedChatGptGatewayProjectConfig,
  model = managed.model,
  modelFast = managed.modelFast,
): SaveClaudeConfigInput => ({
  apiKeyHelperPolicy: 'prefer-claudedock',
  authMode: 'authToken',
  baseUrl: managed.baseUrl,
  credential: managed.credential,
  credentialAction: 'replace',
  model,
  modelFast,
  preset: 'chatgpt-subscription',
  protocol: 'anthropic',
  provider: 'gateway',
});

interface ManagedChatGptGlobalOperations {
  emitManagedChatGptProgress: (
    sessionId: string | undefined,
    stage: ManagedChatGptSetupStage,
    step: number,
    detail: string,
    active?: boolean,
    totalSteps?: number,
  ) => void;
  setupManagedChatGptGatewayGlobally: () => Promise<ManagedChatGptGatewayOperationResult>;
}

interface ManagedChatGptProjectOperations {
  verifyAndSaveManagedChatGptProject: (
    sessionId: string,
    cwd: string,
    managed: ManagedChatGptGatewayProjectConfig,
    assertCurrent: () => void,
    requestedModel?: string,
    resumeAfterSave?: boolean,
  ) => Promise<{
    connectionTest: ClaudeConnectionTestResult;
    projectState?: ClaudeProjectState;
  }>;
}

type ManagedChatGptIpcContext = ManagedChatGptGlobalOperations & ManagedChatGptProjectOperations;

const createManagedChatGptGlobalOperations = ({
  guards: { withOfficialProviderAccess, requireClaudeRuntime, requireManagedChatGptGateway },
  services,
}: ManagedChatGptIpcDependencies): ManagedChatGptGlobalOperations => {
  const managedChatGptGlobalSetup =
    new ManagedChatGptGlobalSetupCoordinator<ManagedChatGptGatewayOperationResult>();

  const emitManagedChatGptProgress = (
    sessionId: string | undefined,
    stage: ManagedChatGptSetupStage,
    step: number,
    detail: string,
    active = true,
    totalSteps = 8,
  ): void => {
    services
      .resolve(MAIN_WINDOW)
      .current?.webContents.send(CHANNELS.CLAUDE_MANAGED_CHATGPT_SETUP_PROGRESS, {
        active,
        detail,
        interruptible: active && stage === 'logging-in',
        sessionId,
        stage,
        step,
        totalSteps,
      });
  };

  /** Installs, authenticates, discovers, tests and saves the global next-conversation choice. */
  const performManagedChatGptGatewayGlobalSetup =
    async (): Promise<ManagedChatGptGatewayOperationResult> => {
      const progress = (
        stage: ManagedChatGptSetupStage,
        step: number,
        detail: string,
        active = true,
      ): void => emitManagedChatGptProgress(undefined, stage, step, detail, active, 8);
      let releaseConnection: (() => void) | undefined;
      try {
        const runtime = requireClaudeRuntime();
        const reservation = runtime.reserveNextConversationConnection();
        releaseConnection = reservation.release;
        const operation = async (): Promise<ManagedChatGptGatewayOperationResult> => {
          progress('detecting', 1, '正在检测 Claude Code、登录网关与本机端口。');
          let environment = await runtime.getSoftwareUpdates(true);
          if (!environment.claudeCode.installed) {
            progress('installing-claude', 2, '未检测到 Claude Code，正在通过官方安装方式补齐。');
            environment = (await runtime.installOrUpdateClaudeCode()).state;
          } else {
            progress('installing-claude', 2, 'Claude Code 已就绪，无需重复安装。');
          }
          if (!environment.claudeCode.installed) {
            throw new Error('Claude Code 自动安装结束后仍未通过环境检测。');
          }
          progress(
            'installing-gateway',
            3,
            'Claude Code 已就绪，正在检查并配置 ChatGPT 本地网关；此方式不需要 CCR。',
          );
          const managed = await requireManagedChatGptGateway().setup(false, (step, detail) => {
            const stage: ManagedChatGptSetupStage =
              step === 5 ? 'logging-in' : step >= 6 ? 'discovering-models' : 'installing-gateway';
            progress(stage, step, detail);
          });
          const current = await runtime.getNextConversationConnection();
          const model =
            current.config?.preset === 'chatgpt-subscription' &&
            managed.availableModels.includes(current.config.model)
              ? current.config.model
              : managed.model;
          const modelFast =
            current.config?.preset === 'chatgpt-subscription' &&
            current.config.modelFast &&
            managed.availableModels.includes(current.config.modelFast)
              ? current.config.modelFast
              : managed.modelFast;
          progress('testing', 7, `正在真实验证模型 ${model}。`);
          const applied = await runtime.verifyAndSaveNextConversationConfig(
            managedChatGptConfigInput(managed, model, modelFast),
            async () => {
              progress('testing', 7, '连接首次失败，正在自动重启网关并复检。');
              await requireManagedChatGptGateway().ensureRunning();
            },
            { reservation: reservation.token },
          );
          const state = await requireManagedChatGptGateway().getState();
          if (!applied.connectionTest.ok) {
            progress('error', 8, `自动接入未通过：${applied.connectionTest.message}`, false);
            return {
              ...managedChatGptConnectionFailure(
                applied.connectionTest,
                '环境与模型列表已准备好，但真实连接测试未通过；原选择保持不变。',
              ),
              connectionTest: applied.connectionTest,
              error: applied.connectionTest.message,
              message: '所选 ChatGPT 模型未通过真实连接测试；原选择保持不变。',
              nextConnection: applied.state,
              ok: false,
              state,
            };
          }
          progress('complete', 8, `接入成功；下个新对话将使用模型 ${model}。`, false);
          return {
            connectionTest: applied.connectionTest,
            message: `ChatGPT 接入已验证；下个新对话将使用 ${model}。`,
            nextConnection: applied.state,
            ok: true,
            state,
          };
        };
        const request = {
          action: 'login' as const,
          cwd: runtime.nextConversationConnectionScope(),
          networkScope: 'application' as const,
          provider: 'openai-codex' as const,
        };
        return await withOfficialProviderAccess(request, operation);
      } catch (error) {
        const state = await requireManagedChatGptGateway().getState();
        const message = error instanceof Error ? error.message : '托管网关配置失败。';
        const failureMessage = '未能完成 ChatGPT 订阅的一键安装与 OpenAI 授权。';
        progress('error', 8, message, false);
        return {
          ...reportManagedChatGptFailure('external-service', failureMessage, error),
          error: message,
          nextConnection: await requireClaudeRuntime().getNextConversationConnection(),
          ok: false,
          state,
        };
      } finally {
        releaseConnection?.();
      }
    };

  const setupManagedChatGptGatewayGlobally = (): Promise<ManagedChatGptGatewayOperationResult> =>
    managedChatGptGlobalSetup.run(() => performManagedChatGptGatewayGlobalSetup());

  return { emitManagedChatGptProgress, setupManagedChatGptGatewayGlobally };
};

const createManagedChatGptProjectOperations = (
  {
    failedRuntimeLaunchCleanupDependencies,
    guards: { requireClaudeRuntime, requireManagedChatGptGateway },
    restartRuntimeTerminal,
    runClaudeProjectConfigTransaction,
    workspace,
  }: ManagedChatGptIpcDependencies,
  emitManagedChatGptProgress: ManagedChatGptGlobalOperations['emitManagedChatGptProgress'],
): ManagedChatGptProjectOperations => {
  const resumeClaudeAfterManagedCutover = async (
    runtime: ClaudeRuntime,
    sessionId: string,
    cwd: string,
    assertCurrent: () => void,
  ): Promise<ClaudeProjectState> => {
    let launchToken: object | undefined;
    let ownedGeneration = workspace.getStatus(sessionId).ptyGeneration;
    try {
      const prepared = await runtime.prepareLaunch(sessionId, cwd, 'continue');
      launchToken = prepared.token;
      assertCurrent();
      restartRuntimeTerminal(
        runtime,
        sessionId,
        prepared.environment,
        prepared.command,
        '无法在新接入上恢复 Claude Code 会话。',
        assertCurrent,
        (ptyGeneration) => {
          ownedGeneration = ptyGeneration;
        },
        prepared.token,
      );
      const state = await runtime.getState(sessionId, cwd);
      assertCurrent();
      return state;
    } catch (error) {
      // Once the saved route changes, falling back to the old live PTY would silently keep billing
      // the previous relay. Fail closed even when preparing or starting the replacement TUI fails.
      cleanupFailedRuntimeLaunch(
        failedRuntimeLaunchCleanupDependencies,
        runtime,
        sessionId,
        ownedGeneration,
        launchToken,
      );
      throw error;
    }
  };

  const verifyAndSaveManagedChatGptProject = async (
    sessionId: string,
    cwd: string,
    managed: ManagedChatGptGatewayProjectConfig,
    assertCurrent: () => void,
    requestedModel?: string,
    resumeAfterSave = false,
  ): Promise<{ connectionTest: ClaudeConnectionTestResult; projectState?: ClaudeProjectState }> => {
    const runtime = requireClaudeRuntime();
    const current = await runtime.getState(sessionId, cwd);
    assertCurrent();
    const model =
      requestedModel ??
      (current.config.preset === 'chatgpt-subscription' &&
      managed.availableModels.includes(current.config.model)
        ? current.config.model
        : managed.model);
    const modelFast =
      current.config.preset === 'chatgpt-subscription' &&
      current.config.modelFast &&
      managed.availableModels.includes(current.config.modelFast)
        ? current.config.modelFast
        : managed.modelFast;
    const input = managedChatGptConfigInput(managed, model, modelFast);
    emitManagedChatGptProgress(sessionId, 'testing', 7, `正在真实验证模型 ${model}。`);
    let connectionTest = await runtime.testConnection(cwd, input);
    assertCurrent();
    if (
      !connectionTest.ok &&
      (connectionTest.failureKind === 'network' || connectionTest.failureKind === 'timeout')
    ) {
      emitManagedChatGptProgress(sessionId, 'testing', 7, '连接首次失败，正在自动重启网关并复检。');
      await requireManagedChatGptGateway().ensureRunning();
      assertCurrent();
      connectionTest = await runtime.testConnection(cwd, input);
      assertCurrent();
    }
    if (!connectionTest.ok) {
      return { connectionTest };
    }
    emitManagedChatGptProgress(sessionId, 'saving', 8, '连接已通过，正在保存当前项目配置。');
    const projectState = await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
      assertCurrent,
      commit: (prepared) => runtime.commitPreparedConfig(cwd, prepared, sessionId),
      complete: async (prepared) => {
        const savedState = await runtime.completePreparedConfigSave(sessionId, cwd, prepared);
        assertCurrent();
        return resumeAfterSave
          ? resumeClaudeAfterManagedCutover(runtime, sessionId, cwd, assertCurrent)
          : savedState;
      },
      cwd,
      prepare: () => runtime.prepareConnectionConfig(input, undefined, assertCurrent),
      runtime,
      sessionId,
    });
    return { connectionTest, projectState };
  };
  return { verifyAndSaveManagedChatGptProject };
};

const registerManagedChatGptAccessIpc = ({
  guards: { requireManagedChatGptGateway, validateSender },
}: ManagedChatGptIpcDependencies): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_CANCEL_SETUP,
    async (event): Promise<OperationResult> => {
      validateSender(event);
      const cancelled = await requireManagedChatGptGateway().cancelSetup();
      return {
        message: cancelled
          ? '已取消当前 OpenAI 授权并返回模型选择。'
          : '当前没有可取消的授权操作。',
        ok: cancelled,
      };
    },
  );
  ipcMain.handle(CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_STATE, async (event) => {
    validateSender(event);
    return requireManagedChatGptGateway().getState();
  });
  ipcMain.handle(
    CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_LOGOUT,
    async (event): Promise<ManagedChatGptGatewayOperationResult> => {
      validateSender(event);
      try {
        const gateway = requireManagedChatGptGateway();
        await gateway.logout();
        const state = await gateway.getState();
        return {
          message: '已退出 ClaudeDock 托管的 OpenAI 账号；浏览器和 Google 登录状态未被修改。',
          ok: true,
          state,
        };
      } catch (error) {
        const state = await requireManagedChatGptGateway().getState();
        const message = error instanceof Error ? error.message : '无法退出托管的 OpenAI 账号。';
        return {
          ...reportManagedChatGptFailure('environment', '无法退出托管的 OpenAI 账号。', error),
          error: message,
          ok: false,
          state,
        };
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_OPEN_MANAGEMENT,
    async (event): Promise<OperationResult> => {
      validateSender(event);
      try {
        const access = await requireManagedChatGptGateway().managementAccess();
        await shell.openExternal(access.url);
        return {
          message: '已打开 ChatGPT 网关本机后台；管理凭据不会发送到页面或剪贴板。',
          ok: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法打开 ChatGPT 网关后台。';
        return {
          ...reportManagedChatGptFailure('environment', message, error),
          error: message,
          ok: false,
        };
      }
    },
  );
};

const registerManagedChatGptSetupIpc = (
  {
    configTransactionState,
    guards: {
      withOfficialProviderAccess,
      requireClaudeRuntime,
      requireManagedChatGptGateway,
      validateSender,
    },
    withDevelopmentSessionOperation,
    withoutTerminalOperationInvalidation,
    workspace,
  }: ManagedChatGptIpcDependencies,
  {
    emitManagedChatGptProgress,
    setupManagedChatGptGatewayGlobally,
    verifyAndSaveManagedChatGptProject,
  }: ManagedChatGptIpcContext,
): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP,
    async (event, sessionId: unknown): Promise<ManagedChatGptGatewayOperationResult> => {
      validateSender(event);
      if (sessionId === undefined) {
        return setupManagedChatGptGatewayGlobally();
      }
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      const resumeAfterSetup = runtime.isActive(validatedSessionId);
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let connectionTest: ClaudeConnectionTestResult | undefined;
          try {
            const operation = async (): Promise<ManagedChatGptGatewayOperationResult> => {
              assertCurrent();
              if (resumeAfterSetup) {
                emitManagedChatGptProgress(
                  validatedSessionId,
                  'detecting',
                  1,
                  '检测到运行中的 Claude 会话；已先停止旧路由，防止登录期间继续消耗原中转站额度。',
                );
                withoutTerminalOperationInvalidation(validatedSessionId, () => {
                  workspace.stopIfGeneration(validatedSessionId, status.ptyGeneration);
                });
                runtime.setInactive(validatedSessionId, status.ptyGeneration);
                assertCurrent();
              }
              emitManagedChatGptProgress(
                validatedSessionId,
                'detecting',
                1,
                resumeAfterSetup
                  ? '旧路由已停止，正在检测 Claude Code、登录网关与本机端口。'
                  : '正在检测 Claude Code、登录网关与本机端口。',
              );
              let environment = await runtime.getSoftwareUpdates(true);
              assertCurrent();
              if (!environment.claudeCode.installed) {
                emitManagedChatGptProgress(
                  validatedSessionId,
                  'installing-claude',
                  2,
                  '未检测到 Claude Code，正在通过官方安装方式补齐。',
                );
                environment = (await runtime.installOrUpdateClaudeCode()).state;
                assertCurrent();
              } else {
                emitManagedChatGptProgress(
                  validatedSessionId,
                  'installing-claude',
                  2,
                  'Claude Code 已就绪，无需重复安装。',
                );
              }
              if (!environment.claudeCode.installed) {
                throw new Error('Claude Code 自动安装结束后仍未通过环境检测。');
              }
              emitManagedChatGptProgress(
                validatedSessionId,
                'installing-gateway',
                3,
                'Claude Code 已就绪，正在检查并配置 ChatGPT 本地网关；此方式不需要 CCR。',
              );
              const managed = await requireManagedChatGptGateway().setup(false, (step, detail) => {
                const stage: ManagedChatGptSetupStage =
                  step === 5
                    ? 'logging-in'
                    : step >= 6
                      ? 'discovering-models'
                      : 'installing-gateway';
                emitManagedChatGptProgress(validatedSessionId, stage, step, detail);
              });
              assertCurrent();
              const applied = await verifyAndSaveManagedChatGptProject(
                validatedSessionId,
                status.cwd,
                managed,
                assertCurrent,
                undefined,
                resumeAfterSetup,
              );
              assertCurrent();
              connectionTest = applied.connectionTest;
              const state = await requireManagedChatGptGateway().getState();
              assertCurrent();
              if (!applied.projectState) {
                emitManagedChatGptProgress(
                  validatedSessionId,
                  'error',
                  8,
                  `自动接入未通过：${connectionTest.message}`,
                  false,
                );
                return {
                  ...managedChatGptConnectionFailure(
                    connectionTest,
                    '环境与模型列表已准备好，但真实连接测试未通过。',
                  ),
                  connectionTest,
                  error: connectionTest.message,
                  ok: false,
                  state,
                };
              }
              emitManagedChatGptProgress(
                validatedSessionId,
                'complete',
                8,
                resumeAfterSetup
                  ? `接入成功；旧路由已切断，最近会话已在新路由恢复，模型为 ${applied.projectState.config.model}。`
                  : `接入成功，已自动选择并验证模型 ${applied.projectState.config.model}。`,
                false,
              );
              return {
                connectionTest,
                message: resumeAfterSetup
                  ? `环境、网关和模型已全部自动配置；旧路由已停止，最近会话已在新路由恢复。`
                  : `环境、网关和模型已全部自动配置；当前使用 ${applied.projectState.config.model}。`,
                ok: true,
                projectState: applied.projectState,
                state,
              };
            };
            const request = {
              action: 'login' as const,
              cwd: status.cwd,
              provider: 'openai-codex' as const,
            };
            return await withOfficialProviderAccess(request, operation);
          } catch (error) {
            const state = await requireManagedChatGptGateway().getState();
            const message = error instanceof Error ? error.message : '托管网关配置失败。';
            const failureMessage = resumeAfterSetup
              ? '未能完成 ChatGPT 订阅的一键接入；旧路由会话已保持停止，不会继续消耗原中转站额度。'
              : '未能完成 ChatGPT 订阅的一键接入。';
            const projectState = configTransactionState(error);
            emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
            return {
              ...reportManagedChatGptFailure('external-service', failureMessage, error),
              connectionTest,
              error: message,
              ok: false,
              ...(projectState ? { projectState } : {}),
              state,
            };
          }
        });
      } catch (error) {
        const state = await requireManagedChatGptGateway().getState();
        const message = error instanceof Error ? error.message : '托管网关配置失败。';
        const failureMessage = resumeAfterSetup
          ? '未能完成 ChatGPT 订阅的一键接入；旧路由会话已保持停止，不会继续消耗原中转站额度。'
          : '未能完成 ChatGPT 订阅的一键接入。';
        emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
        return {
          ...reportManagedChatGptFailure('external-service', failureMessage, error),
          error: message,
          ok: false,
          state,
        };
      }
    },
  );
};

const setManagedChatGptGatewayModelGlobally = async (
  {
    guards: { withOfficialProviderAccess, requireClaudeRuntime, requireManagedChatGptGateway },
  }: Pick<ManagedChatGptIpcDependencies, 'guards'>,
  emitManagedChatGptProgress: ManagedChatGptGlobalOperations['emitManagedChatGptProgress'],
  requestedModel: string,
): Promise<ManagedChatGptGatewayOperationResult> => {
  const runtime = requireClaudeRuntime();
  let connectionTest: ClaudeConnectionTestResult | undefined;
  try {
    return await withOfficialProviderAccess(
      {
        action: 'first-request',
        cwd: runtime.nextConversationConnectionScope(),
        networkScope: 'application',
        provider: 'openai-codex',
      },
      async () => {
        emitManagedChatGptProgress(
          undefined,
          'discovering-models',
          6,
          '正在刷新网关模型列表并校验你的选择。',
        );
        const gateway = requireManagedChatGptGateway();
        const managed = await gateway.configurationForModel(requestedModel);
        emitManagedChatGptProgress(undefined, 'testing', 7, `正在真实验证模型 ${requestedModel}。`);
        const applied = await runtime.verifyAndSaveNextConversationConfig(
          managedChatGptConfigInput(managed, requestedModel, managed.modelFast),
          async () => {
            emitManagedChatGptProgress(
              undefined,
              'testing',
              7,
              '连接首次失败，正在自动重启网关并复检。',
            );
            await gateway.ensureRunning();
          },
        );
        connectionTest = applied.connectionTest;
        const state = await gateway.getState();
        if (!connectionTest.ok) {
          emitManagedChatGptProgress(undefined, 'error', 8, connectionTest.message, false);
          return {
            ...managedChatGptConnectionFailure(
              connectionTest,
              '所选模型未通过真实连接测试，原选择保持不变。',
            ),
            connectionTest,
            error: connectionTest.message,
            nextConnection: applied.state,
            ok: false,
            state,
          };
        }
        emitManagedChatGptProgress(
          undefined,
          'complete',
          8,
          `模型 ${requestedModel} 已验证；下个新对话将使用它。`,
          false,
        );
        return {
          connectionTest,
          message: `已选择并验证模型 ${requestedModel}；下个新对话将使用它。`,
          nextConnection: applied.state,
          ok: true,
          state,
        };
      },
    );
  } catch (error) {
    const state = await requireManagedChatGptGateway().getState();
    const message = error instanceof Error ? error.message : '无法切换托管网关模型。';
    emitManagedChatGptProgress(undefined, 'error', 8, message, false);
    return {
      ...reportManagedChatGptFailure('external-service', '无法完成模型切换。', error),
      ...(connectionTest ? { connectionTest } : {}),
      error: message,
      nextConnection: await runtime.getNextConversationConnection(),
      ok: false,
      state,
    };
  }
};

const registerManagedChatGptModelIpc = (
  {
    configTransactionState,
    guards: {
      withOfficialProviderAccess,
      requireClaudeRuntime,
      requireManagedChatGptGateway,
      validateSender,
    },
    withDevelopmentSessionOperation,
    workspace,
  }: ManagedChatGptIpcDependencies,
  { emitManagedChatGptProgress, verifyAndSaveManagedChatGptProject }: ManagedChatGptIpcContext,
): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_MODEL,
    async (
      event,
      sessionId: unknown,
      requestedModel: unknown,
    ): Promise<ManagedChatGptGatewayOperationResult> => {
      validateSender(event);
      if (
        typeof requestedModel !== 'string' ||
        !/^[-A-Za-z0-9._:/@[\]]{1,200}$/.test(requestedModel)
      ) {
        throw new Error('托管网关模型标识无效。');
      }
      if (sessionId === undefined) {
        return setManagedChatGptGatewayModelGlobally(
          {
            guards: {
              withOfficialProviderAccess,
              requireClaudeRuntime,
              requireManagedChatGptGateway,
              validateSender,
            },
          },
          emitManagedChatGptProgress,
          requestedModel,
        );
      }
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      const resumeAfterModelChange = runtime.isActive(validatedSessionId);
      try {
        return await withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
          let connectionTest: ClaudeConnectionTestResult | undefined;
          try {
            return await withOfficialProviderAccess(
              { action: 'first-request', cwd: status.cwd, provider: 'openai-codex' },
              async () => {
                assertCurrent();
                emitManagedChatGptProgress(
                  validatedSessionId,
                  'discovering-models',
                  6,
                  '正在刷新网关模型列表并校验你的选择。',
                );
                const managed =
                  await requireManagedChatGptGateway().configurationForModel(requestedModel);
                assertCurrent();
                const applied = await verifyAndSaveManagedChatGptProject(
                  validatedSessionId,
                  status.cwd,
                  managed,
                  assertCurrent,
                  requestedModel,
                  resumeAfterModelChange,
                );
                assertCurrent();
                connectionTest = applied.connectionTest;
                const state = await requireManagedChatGptGateway().getState();
                assertCurrent();
                if (!applied.projectState) {
                  emitManagedChatGptProgress(
                    validatedSessionId,
                    'error',
                    8,
                    connectionTest.message,
                    false,
                  );
                  return {
                    ...managedChatGptConnectionFailure(
                      connectionTest,
                      '所选模型未通过真实连接测试，原配置保持不变。',
                    ),
                    connectionTest,
                    error: connectionTest.message,
                    ok: false,
                    state,
                  };
                }
                emitManagedChatGptProgress(
                  validatedSessionId,
                  'complete',
                  8,
                  `模型 ${requestedModel} 已验证并切换完成。`,
                  false,
                );
                return {
                  connectionTest,
                  message: `已切换并验证模型 ${requestedModel}。`,
                  ok: true,
                  projectState: applied.projectState,
                  state,
                };
              },
            );
          } catch (error) {
            const state = await requireManagedChatGptGateway().getState();
            const message = error instanceof Error ? error.message : '无法切换托管网关模型。';
            const projectState = configTransactionState(error);
            emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
            return {
              ...reportManagedChatGptFailure('external-service', '无法完成模型切换。', error),
              connectionTest,
              error: message,
              ok: false,
              ...(projectState ? { projectState } : {}),
              state,
            };
          }
        });
      } catch (error) {
        const state = await requireManagedChatGptGateway().getState();
        const message = error instanceof Error ? error.message : '无法切换托管网关模型。';
        emitManagedChatGptProgress(validatedSessionId, 'error', 8, message, false);
        return {
          ...reportManagedChatGptFailure('external-service', '无法完成模型切换。', error),
          error: message,
          ok: false,
          state,
        };
      }
    },
  );
};

export const registerManagedChatGptIpc = (dependencies: ManagedChatGptIpcDependencies): void => {
  const globalOperations = createManagedChatGptGlobalOperations(dependencies);
  const projectOperations = createManagedChatGptProjectOperations(
    dependencies,
    globalOperations.emitManagedChatGptProgress,
  );
  const context: ManagedChatGptIpcContext = {
    ...globalOperations,
    ...projectOperations,
  };
  registerManagedChatGptAccessIpc(dependencies);
  registerManagedChatGptSetupIpc(dependencies, context);
  registerManagedChatGptModelIpc(dependencies, context);
};
