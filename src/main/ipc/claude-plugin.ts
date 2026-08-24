import { createHash } from 'node:crypto';
import { ipcMain } from 'electron';
import type {
  BusyKind,
  ClaudePluginCatalog,
  ClaudePluginOperationResult,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';
import {
  type ClaudePluginManager,
  ClaudePluginMutationError,
  type ClaudePluginMutationRequest,
  claudePluginMutationIdentity,
  isValidMarketplaceName,
  isValidMarketplaceSource,
} from '../claude/plugin-manager';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { BUSY_REGISTRY } from '../infra/service-tokens';
import type { MainGuards } from './guards';
import { validatePluginId } from './validation';

export interface ClaudePluginIpcDependencies {
  guards: Pick<MainGuards, 'assertPluginMutationsAllowed' | 'validateSender'>;
  pluginManager: ClaudePluginManager;
  services: Registry;
}

const reportPluginFailure = createFailureReporter('claude-plugin');

type PluginBusyAction =
  'disable' | 'enable' | 'install' | 'refresh' | 'remove' | 'uninstall' | 'update';

interface PreparedPluginMutation {
  action: PluginBusyAction;
  kind: BusyKind;
  request: ClaudePluginMutationRequest;
  target: string;
}

type PreparePluginMutation = (argument: unknown, flag: unknown) => PreparedPluginMutation;

const actionLabel = (action: PluginBusyAction): string =>
  (
    ({
      disable: '禁用',
      enable: '启用',
      install: '安装',
      refresh: '刷新',
      remove: '移除',
      uninstall: '卸载',
      update: '更新',
    }) as const
  )[action];

export const registerClaudePluginIpc = ({
  guards: { assertPluginMutationsAllowed, validateSender },
  pluginManager,
  services,
}: ClaudePluginIpcDependencies): void => {
  let mutationSequence = 0;

  const failedMutationResult = async (
    error: unknown,
    catalog?: ClaudePluginCatalog,
  ): Promise<ClaudePluginOperationResult> => {
    const message = error instanceof Error ? error.message : '插件操作失败。';
    return {
      ...reportPluginFailure('external-service', message, error),
      catalog: catalog ?? (await pluginManager.getCatalog(false)),
      error: message,
      ok: false,
    };
  };

  const pluginMutations = new Map<string, PreparePluginMutation>([
    [
      CHANNELS.CLAUDE_PLUGINS_INSTALL,
      (argument) => {
        const pluginId = validatePluginId(argument);
        return {
          action: 'install',
          kind: 'install',
          request: { pluginId, type: 'install' },
          target: pluginId,
        };
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_UNINSTALL,
      (argument) => {
        const pluginId = validatePluginId(argument);
        return {
          action: 'uninstall',
          kind: 'uninstall',
          request: { pluginId, type: 'uninstall' },
          target: pluginId,
        };
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_UPDATE,
      (argument) => {
        const pluginId = validatePluginId(argument);
        return {
          action: 'update',
          kind: 'install',
          request: { pluginId, type: 'update' },
          target: pluginId,
        };
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_SET_ENABLED,
      (argument, flag) => {
        const pluginId = validatePluginId(argument);
        if (typeof flag !== 'boolean') {
          throw new Error('插件启用状态无效。');
        }
        return {
          action: flag ? 'enable' : 'disable',
          kind: 'configure',
          request: { enabled: flag, pluginId, type: 'set-enabled' },
          target: pluginId,
        };
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_ADD,
      (argument) => {
        if (!isValidMarketplaceSource(argument)) {
          throw new Error('插件市场地址无效，请填写仓库所有者/仓库名、HTTPS 地址或本机绝对路径。');
        }
        const source = argument.trim();
        return {
          action: 'install',
          kind: 'install',
          request: { source, type: 'marketplace-add' },
          // Local paths and remote URLs stay out of busy status and tray text.
          target: '插件市场',
        };
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_REMOVE,
      (argument) => {
        if (!isValidMarketplaceName(argument)) {
          throw new Error('插件市场名称无效。');
        }
        return {
          action: 'remove',
          kind: 'uninstall',
          request: { name: argument, type: 'marketplace-remove' },
          target: argument,
        };
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_REFRESH,
      () => ({
        action: 'refresh',
        kind: 'install',
        request: { type: 'marketplaces-refresh' },
        target: '插件市场',
      }),
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_UPDATE_ALL,
      () => ({
        action: 'update',
        kind: 'install',
        request: { type: 'update-all' },
        target: '所有插件',
      }),
    ],
  ]);

  ipcMain.handle(CHANNELS.CLAUDE_PLUGINS_GET, async (event, refresh: unknown) => {
    validateSender(event);
    return pluginManager.getCatalog(refresh === true);
  });

  /*
   * The first main-owned mutation gets one blocking lease. Identical callers join that owner and
   * competing mutations are rejected, so renderer reload cannot duplicate side effects or leases.
   * Preparation validates all inputs before any user-controlled value reaches metadata.
   */
  for (const [channel, prepare] of pluginMutations) {
    ipcMain.handle(channel, async (event, argument: unknown, flag: unknown) => {
      validateSender(event);
      let release: (() => void) | undefined;
      try {
        assertPluginMutationsAllowed();
        const mutation = prepare(argument, flag);
        const joinsActiveMutation = pluginManager.hasActiveMutation();
        const outcomePromise = pluginManager.mutate(mutation.request);
        if (!joinsActiveMutation) {
          const identity = createHash('sha256')
            .update(claudePluginMutationIdentity(mutation.request))
            .digest('hex')
            .slice(0, 16);
          mutationSequence += 1;
          const label = actionLabel(mutation.action);
          release = services.resolve(BUSY_REGISTRY).acquire({
            action: mutation.action,
            cancellable: false,
            domain: 'plugin',
            id: `plugin:${channel}:${identity}:${mutationSequence.toString(36)}`,
            kind: mutation.kind,
            label: `${label} ${mutation.target}`,
            severity: 'blocking',
            stage: `${label} Claude Code 插件`,
            target: mutation.target,
          });
        }
        const outcome = await outcomePromise;
        return { ...outcome, ok: true };
      } catch (error) {
        return failedMutationResult(
          error,
          error instanceof ClaudePluginMutationError ? error.catalog : undefined,
        );
      } finally {
        release?.();
      }
    });
  }
};
