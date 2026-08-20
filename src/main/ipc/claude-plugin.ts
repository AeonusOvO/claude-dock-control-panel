import { CHANNELS } from '../../shared/ipc/channels';
import { createHash } from 'node:crypto';
import { ipcMain } from 'electron';
import type { ClaudePluginCatalog, ClaudePluginOperationResult } from '../../shared/contracts';
import {
  type ClaudePluginManager,
  isValidMarketplaceName,
  isValidMarketplaceSource,
} from '../claude/plugin-manager';
import { createFailureReporter } from '../infra/logger';
import type { Registry } from '../infra/registry';
import { BUSY_REGISTRY } from '../infra/service-tokens';
import { validatePluginId } from './validation';
import type { MainGuards } from './guards';

export interface ClaudePluginIpcDependencies {
  guards: Pick<MainGuards, 'assertPluginMutationsAllowed' | 'validateSender'>;
  pluginManager: ClaudePluginManager;
  services: Registry;
}

const reportPluginFailure = createFailureReporter('claude-plugin');

export const registerClaudePluginIpc = ({
  guards: { assertPluginMutationsAllowed, validateSender },
  pluginManager,
  services,
}: ClaudePluginIpcDependencies): void => {
  const refreshedPluginCatalog = async (): Promise<ClaudePluginCatalog> => {
    pluginManager.invalidate();
    return pluginManager.getCatalog(true);
  };

  /** Every plugin mutation shares the same validate → run → refresh → report shape. */
  const runPluginMutation = async (
    operation: () => Promise<string>,
  ): Promise<ClaudePluginOperationResult> => {
    try {
      assertPluginMutationsAllowed();
      const message = await operation();
      return { catalog: await refreshedPluginCatalog(), message, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '插件操作失败。';
      return {
        ...reportPluginFailure('external-service', message, error),
        catalog: await refreshedPluginCatalog(),
        error: message,
        ok: false,
      };
    }
  };

  const pluginMutations = new Map<string, (argument: unknown, flag: unknown) => Promise<string>>([
    [
      CHANNELS.CLAUDE_PLUGINS_INSTALL,
      (argument) => pluginManager.install(validatePluginId(argument)),
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_UNINSTALL,
      (argument) => pluginManager.uninstall(validatePluginId(argument)),
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_UPDATE,
      (argument) => pluginManager.update(validatePluginId(argument)),
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_SET_ENABLED,
      (argument, flag) => {
        if (typeof flag !== 'boolean') {
          throw new Error('插件启用状态无效。');
        }
        return pluginManager.setEnabled(validatePluginId(argument), flag);
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_ADD,
      (argument) => {
        if (!isValidMarketplaceSource(argument)) {
          throw new Error('插件市场地址无效，请填写仓库所有者/仓库名、HTTPS 地址或本机绝对路径。');
        }
        return pluginManager.addMarketplace(argument.trim());
      },
    ],
    [
      CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_REMOVE,
      (argument) => {
        if (!isValidMarketplaceName(argument)) {
          throw new Error('插件市场名称无效。');
        }
        return pluginManager.removeMarketplace(argument);
      },
    ],
    [CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_REFRESH, () => pluginManager.refreshMarketplaces()],
    [CHANNELS.CLAUDE_PLUGINS_UPDATE_ALL, () => pluginManager.updateAll()],
  ]);
  ipcMain.handle(CHANNELS.CLAUDE_PLUGINS_GET, async (event, refresh: unknown) => {
    validateSender(event);
    return pluginManager.getCatalog(refresh === true);
  });

  /*
   * Each mutation gets a blocking lease so the quit handshake and the tray both know a plugin write is
   * in flight; the label is derived from the channel so a new entry above needs no wiring here.
   */
  for (const [channel, run] of pluginMutations) {
    ipcMain.handle(channel, async (event, argument: unknown, flag: unknown) => {
      validateSender(event);
      return runPluginMutation(async () => {
        const identity =
          typeof argument === 'string'
            ? createHash('sha256').update(argument).digest('hex').slice(0, 16)
            : 'global';
        const action = channel.includes('uninstall')
          ? 'uninstall'
          : channel.includes('disable')
            ? 'disable'
            : channel.includes('enable')
              ? 'enable'
              : channel.includes('update')
                ? 'update'
                : channel.includes('refresh')
                  ? 'refresh'
                  : channel.includes('remove')
                    ? 'remove'
                    : 'install';
        const actionLabel = (
          {
            disable: '禁用',
            enable: '启用',
            install: '安装',
            refresh: '刷新',
            remove: '移除',
            uninstall: '卸载',
            update: '更新',
          } as const
        )[action];
        const target =
          typeof argument === 'string' && /^[\w@./:-]{1,120}$/.test(argument)
            ? argument
            : channel.includes('marketplace')
              ? '插件市场'
              : '所选插件';
        const release = services.resolve(BUSY_REGISTRY).acquire({
          action,
          cancellable: false,
          domain: 'plugin',
          id: `plugin:${channel}:${identity}`,
          kind:
            channel.includes('uninstall') || channel.includes('remove') ? 'uninstall' : 'install',
          label: `${actionLabel} ${target}`,
          severity: 'blocking',
          stage: `${actionLabel} Claude Code 插件`,
          target,
        });
        try {
          return await run(argument, flag);
        } finally {
          release();
        }
      });
    });
  }
};
