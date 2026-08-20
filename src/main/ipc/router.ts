import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain, shell } from 'electron';
import type {
  ClaudeProjectState,
  ClaudeRouterInstallSource,
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
  RouterKernelState,
} from '../../shared/contracts';
import { selectRouterKernelState } from '../../shared/router/kernel';
import type { RunClaudeProjectConfigTransaction } from '../claude/config-transaction';
import type { SavedRouterProvider } from '../claude/router-manager';
import type { PreparedClaudeConfigSave } from '../claude/runtime';
import type { WithSessionOperation } from '../coordination/session-operation';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { BUSY_REGISTRY } from '../infra/service-tokens';
import type { TerminalWorkspace } from '../terminal/workspace';
import { validateClaudeRouterProviderInput, validateSessionId } from './validation';
import type { MainGuards } from './guards';

const routerInstallSources = new Set<ClaudeRouterInstallSource>(['npm', 'npmmirror']);
const reportRouterFailure = createFailureReporter('claude-router');
const reportRouterKernelFailure = createFailureReporter('router-kernel');

export interface RouterIpcDependencies {
  /* Every domain that writes project configuration reports the same rolled-back state. */
  configTransactionState: (error: unknown) => ClaudeProjectState | undefined;
  guards: Pick<MainGuards, 'requireCcSwitchAdapter' | 'requireClaudeRuntime' | 'validateSender'>;
  runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  services: Registry;
  withDevelopmentSessionOperation: WithSessionOperation;
  workspace: TerminalWorkspace;
}

interface RouterIpcContext {
  getRouterKernelState: () => Promise<RouterKernelState>;
  routerFailure: (error: unknown, fallback: string) => Promise<ClaudeRouterOperationResult>;
  routerKernelFailure: (error: unknown, fallback: string) => Promise<RouterKernelOperationResult>;
  withBlockingRouterTask: <T>(id: string, label: string, action: () => Promise<T>) => Promise<T>;
}

const registerRouterKernelIpc = (
  {
    guards: { requireCcSwitchAdapter, requireClaudeRuntime, validateSender },
    workspace,
  }: RouterIpcDependencies,
  { getRouterKernelState, routerKernelFailure }: RouterIpcContext,
): void => {
  ipcMain.handle(CHANNELS.CLAUDE_ROUTER_GET_STATE, async (event, sessionId: unknown) => {
    validateSender(event);
    validateSessionId(sessionId);
    return requireClaudeRuntime().getRouterManagementState();
  });
  ipcMain.handle(CHANNELS.ROUTER_KERNEL_STATE, async (event, sessionId: unknown) => {
    validateSender(event);
    validateSessionId(sessionId);
    return getRouterKernelState();
  });
  ipcMain.handle(
    CHANNELS.ROUTER_CC_SWITCH_INSTALL,
    async (event, sessionId: unknown): Promise<RouterKernelOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const ccSwitch = await requireCcSwitchAdapter().install();
        const state = await getRouterKernelState();
        return {
          message: ccSwitch.installed
            ? 'CC Switch 官方 MSI 已校验并安装。'
            : 'CC Switch 安装程序已结束，但尚未检测到安装状态。',
          ok: ccSwitch.installed,
          state,
        };
      } catch (error) {
        return routerKernelFailure(error, '无法安装 CC Switch。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.ROUTER_CC_SWITCH_UNINSTALL,
    async (event, sessionId: unknown): Promise<RouterKernelOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const ccSwitch = await requireCcSwitchAdapter().uninstall(true);
        const state = await getRouterKernelState();
        return {
          message:
            !ccSwitch.installed && ccSwitch.residuals.length === 0
              ? 'CC Switch 已卸载，程序、协议注册与已知数据目录均无残留。'
              : `卸载后仍检测到残留：${ccSwitch.residuals.join('、') || ccSwitch.message}`,
          ok: !ccSwitch.installed && ccSwitch.residuals.length === 0,
          state,
        };
      } catch (error) {
        return routerKernelFailure(error, '无法卸载 CC Switch。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.ROUTER_CC_SWITCH_EXPORT_CURRENT,
    async (event, sessionId: unknown): Promise<RouterKernelOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      try {
        await requireCcSwitchAdapter().exportProvider(
          requireClaudeRuntime().currentProviderForCcSwitch(status.cwd),
        );
        return {
          message: '已通过 ccswitch:// 打开单向导入确认；请在 CC Switch 中确认。',
          ok: true,
          state: await getRouterKernelState(),
        };
      } catch (error) {
        return routerKernelFailure(error, '无法导出当前供应商。');
      }
    },
  );
};

const registerRouterLifecycleIpc = (
  { guards: { requireClaudeRuntime, validateSender } }: RouterIpcDependencies,
  { routerFailure, withBlockingRouterTask }: RouterIpcContext,
): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_INSTALL,
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-install',
          '正在后台安装 Claude Code Router CLI',
          () => requireClaudeRuntime().installRouterPackage('npm'),
        );
        return { message: result.message, ok: true, routerState: result.state };
      } catch (error) {
        return routerFailure(error, '无法安装或更新路由器 CLI。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_INSTALL_SOURCE,
    async (event, sessionId: unknown, source: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      if (
        typeof source !== 'string' ||
        !routerInstallSources.has(source as ClaudeRouterInstallSource)
      ) {
        return routerFailure(new Error('路由器安装源无效。'), '无法安装路由器。');
      }
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-install',
          '正在安装 Claude Code Router',
          () => requireClaudeRuntime().installRouterPackage(source as ClaudeRouterInstallSource),
        );
        return { message: result.message, ok: true, routerState: result.state };
      } catch (error) {
        return routerFailure(error, '无法安装或更新路由器。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_UNINSTALL,
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-uninstall',
          '正在卸载 Claude Code Router CLI',
          () => requireClaudeRuntime().uninstallRouter(),
        );
        return { message: result.message, ok: true, routerState: result.state };
      } catch (error) {
        return routerFailure(error, '无法卸载路由器。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_START,
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const routerState = await requireClaudeRuntime().startRouter();
        return {
          message:
            routerState.gatewayState === 'running' ? '路由器网关已启动。' : routerState.message,
          ok: routerState.gatewayState === 'running',
          routerState,
        };
      } catch (error) {
        return routerFailure(error, '无法启动路由器。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_STOP,
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      try {
        const routerState = await requireClaudeRuntime().stopRouter();
        return {
          message: 'ClaudeDock 管理的 CCR CLI 后台与模型网关已停止。',
          ok: !routerState.serviceRunning,
          routerState,
        };
      } catch (error) {
        return routerFailure(error, '无法停止路由器。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_OPEN_MANAGEMENT,
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      const runtime = requireClaudeRuntime();
      try {
        await shell.openExternal(await runtime.routerManagementUrl());
        return {
          message: '已打开 CCR 本机管理页。',
          ok: true,
          routerState: await runtime.getRouterManagementState(),
        };
      } catch (error) {
        return routerFailure(error, '无法打开 CCR 管理页。');
      }
    },
  );
};

const registerRouterProviderIpc = (
  {
    guards: { requireClaudeRuntime, validateSender },
    runClaudeProjectConfigTransaction,
    withDevelopmentSessionOperation,
    workspace,
  }: RouterIpcDependencies,
  { routerFailure, withBlockingRouterTask }: RouterIpcContext,
): void => {
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_REPAIR_FROM_PROJECT,
    async (event, sessionId: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const result = await withBlockingRouterTask(
          'router:ccr-repair',
          '正在修复 Claude Code Router 配置',
          () =>
            withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
              let saved: SavedRouterProvider | undefined;
              const projectState =
                await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
                  assertCurrent,
                  commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
                  complete: (prepared) =>
                    runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
                  cwd: status.cwd,
                  prepare: async () => {
                    saved = await runtime.repairRouterProviderFromProject(
                      status.cwd,
                      assertCurrent,
                    );
                    assertCurrent();
                    return runtime.prepareRouterProjectConfig(saved);
                  },
                  runtime,
                  sessionId: validatedSessionId,
                });
              if (!saved) {
                throw new Error('路由器服务提供方保存结果缺失。');
              }
              return { projectState, saved };
            }),
        );
        return {
          message: `已用当前项目配置创建服务提供方 ${result.saved.provider.name}，启动 3456，并将当前项目安全切换到路由器。`,
          ok: true,
          projectState: result.projectState,
          provider: result.saved.provider,
          routerState: result.saved.state,
        };
      } catch (error) {
        return routerFailure(error, '无法用当前项目配置修复路由器。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_SAVE_PROVIDER,
    async (event, sessionId: unknown, input: unknown): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      const validatedSessionId = validateSessionId(sessionId);
      const status = workspace.getStatus(validatedSessionId);
      const runtime = requireClaudeRuntime();
      try {
        const validatedInput = validateClaudeRouterProviderInput(input);
        const result = await withBlockingRouterTask<{
          projectState?: ClaudeProjectState;
          saved: SavedRouterProvider;
        }>('router:ccr-save-provider', '正在保存 Claude Code Router 服务提供方', () => {
          if (!validatedInput.useForCurrentProject) {
            return runtime
              .saveRouterProvider(validatedInput)
              .then((saved) => ({ projectState: undefined, saved }));
          }
          return withDevelopmentSessionOperation(validatedSessionId, async (assertCurrent) => {
            let saved: SavedRouterProvider | undefined;
            const projectState = await runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>({
              assertCurrent,
              commit: (prepared) => runtime.commitPreparedConfig(status.cwd, prepared),
              complete: (prepared) =>
                runtime.completePreparedConfigSave(validatedSessionId, status.cwd, prepared),
              cwd: status.cwd,
              prepare: async () => {
                saved = await runtime.saveRouterProvider(validatedInput, assertCurrent);
                assertCurrent();
                return runtime.prepareRouterProjectConfig(saved);
              },
              runtime,
              sessionId: validatedSessionId,
            });
            if (!saved) {
              throw new Error('路由器服务提供方保存结果缺失。');
            }
            return { projectState, saved };
          });
        });
        return {
          message: result.projectState
            ? `服务提供方 ${result.saved.provider.name} 已保存，并已安全接入当前项目。`
            : `服务提供方 ${result.saved.provider.name} 已保存。`,
          ok: true,
          projectState: result.projectState,
          provider: result.saved.provider,
          routerState: result.saved.state,
        };
      } catch (error) {
        return routerFailure(error, '无法保存路由器服务提供方。');
      }
    },
  );
  ipcMain.handle(
    CHANNELS.CLAUDE_ROUTER_DELETE_PROVIDER,
    async (
      event,
      sessionId: unknown,
      providerId: unknown,
    ): Promise<ClaudeRouterOperationResult> => {
      validateSender(event);
      validateSessionId(sessionId);
      if (typeof providerId !== 'string') {
        return routerFailure(new Error('服务提供方标识无效。'), '无法删除服务提供方。');
      }
      try {
        return {
          message: '服务提供方已从路由器删除。',
          ok: true,
          routerState: await withBlockingRouterTask(
            'router:ccr-delete-provider',
            '正在删除 Claude Code Router 服务提供方',
            () => requireClaudeRuntime().deleteRouterProvider(providerId),
          ),
        };
      } catch (error) {
        return routerFailure(error, '无法删除路由器服务提供方。');
      }
    },
  );
};

export const registerRouterIpc = (dependencies: RouterIpcDependencies): void => {
  const {
    configTransactionState,
    guards: { requireCcSwitchAdapter, requireClaudeRuntime },
    services,
  } = dependencies;
  const getRouterKernelState = async (): Promise<RouterKernelState> => {
    const [ccr, ccSwitch] = await Promise.all([
      requireClaudeRuntime().getRouterManagementState(),
      requireCcSwitchAdapter().getState(),
    ]);
    return selectRouterKernelState(ccr, ccSwitch);
  };

  const withBlockingRouterTask = async <T>(
    id: string,
    label: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    const release = services.resolve(BUSY_REGISTRY).acquire({
      cancellable: false,
      id,
      kind:
        id.includes('uninstall') || id.includes('delete')
          ? 'uninstall'
          : id.includes('install')
            ? 'install'
            : 'configure',
      label,
      severity: 'blocking',
    });
    try {
      return await action();
    } finally {
      release();
    }
  };

  const routerKernelFailure = async (
    error: unknown,
    fallback: string,
  ): Promise<RouterKernelOperationResult> => {
    const message = error instanceof Error ? error.message : fallback;
    return {
      ...reportRouterKernelFailure('external-service', message, error),
      error: message,
      ok: false,
      state: await getRouterKernelState(),
    };
  };

  const routerFailure = async (
    error: unknown,
    fallback: string,
  ): Promise<ClaudeRouterOperationResult> => {
    const message = error instanceof Error ? error.message : fallback;
    const projectState = configTransactionState(error);
    return {
      ...reportRouterFailure('environment', message, error),
      error: message,
      ok: false,
      ...(projectState ? { projectState } : {}),
      routerState: await requireClaudeRuntime().getRouterManagementState(),
    };
  };
  const context: RouterIpcContext = {
    getRouterKernelState,
    routerFailure,
    routerKernelFailure,
    withBlockingRouterTask,
  };
  registerRouterKernelIpc(dependencies, context);
  registerRouterLifecycleIpc(dependencies, context);
  registerRouterProviderIpc(dependencies, context);
};
