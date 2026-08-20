import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { NetworkPreflightAction, NetworkProviderId } from '../../shared/contracts';
import type { RuntimeEffects } from '../app/profile';
import type { CcSwitchAdapter } from '../claude/cc-switch-adapter';
import type { ManagedChatGptGateway } from '../claude/managed-chatgpt-gateway';
import type { ClaudeRuntime } from '../claude/runtime';
import type { CodexRuntime } from '../codex/runtime';
import type { NativeConversationService } from '../conversation/service';
import type { DownloadEngine } from '../download/engine';
import type { Registry } from '../infra/registry';
import {
  APPLICATION_PROXY_STORE,
  CC_SWITCH_ADAPTER,
  CLAUDE_RUNTIME,
  CODEX_RUNTIME,
  DOWNLOAD_ENGINE,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MCP_MANAGER,
  NATIVE_CONVERSATION_SERVICE,
  NETWORK_PREFLIGHT_SERVICE,
  PROVIDER_ACCESS_GUARD,
} from '../infra/service-tokens';
import type { McpManager } from '../mcp/manager';
import type { NetworkPreflightService } from '../network/preflight-service';
import type { ProviderAccessGuard } from '../network/provider-access-guard';
import type { ApplicationProxyStore } from '../proxy/application-proxy-store';

/*
 * Every handler starts by rejecting anything that is not the one renderer we own. Service accessors are
 * built once here against the registry, so a handler file imports the guard instead of reaching for the
 * container.
 */

export interface MainGuards {
  assertApplicationUpdatesAllowed: () => void;
  assertExternalRoutingWritesAllowed: () => void;
  /** Rejects a request the access guard does not allow to reach an official endpoint. */
  assertOfficialProviderAllowed: (
    provider: NetworkProviderId,
    action: NetworkPreflightAction,
    cwd?: string,
    networkScope?: 'conversation',
  ) => Promise<void>;
  assertPluginMutationsAllowed: () => void;
  assertRealRuntimeAllowed: () => void;
  requireApplicationProxyStore: () => ApplicationProxyStore;
  requireCcSwitchAdapter: () => CcSwitchAdapter;
  requireClaudeRuntime: () => ClaudeRuntime;
  requireCodexRuntime: () => CodexRuntime;
  requireDownloadEngine: () => DownloadEngine;
  requireManagedChatGptGateway: () => ManagedChatGptGateway;
  requireMcpManager: () => McpManager;
  requireNativeConversationService: () => NativeConversationService;
  requireNetworkPreflightService: () => NetworkPreflightService;
  requireProviderAccessGuard: () => ProviderAccessGuard;
  /** Throws unless the event came from the main window's top frame. */
  validateSender: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
}

export const createMainGuards = (services: Registry, effects: RuntimeEffects): MainGuards => {
  const assertRuntimeEffect = (allowed: boolean, message: string): void => {
    if (!allowed) throw new Error(message);
  };

  const requireClaudeRuntime = (): ClaudeRuntime => services.resolve(CLAUDE_RUNTIME);
  const requireProviderAccessGuard = (): ProviderAccessGuard =>
    services.resolve(PROVIDER_ACCESS_GUARD);

  return {
    assertApplicationUpdatesAllowed: (): void =>
      assertRuntimeEffect(
        effects.allowApplicationUpdates,
        '隔离运行配置禁止下载、安装或应用真实软件更新。',
      ),

    assertExternalRoutingWritesAllowed: (): void =>
      assertRuntimeEffect(
        effects.allowExternalRoutingWrites,
        '隔离运行配置禁止写入真实接入、路由或 MCP 配置。',
      ),

    assertOfficialProviderAllowed: async (provider, action, cwd, networkScope): Promise<void> => {
      void networkScope;
      await requireProviderAccessGuard().assertAllowed(provider, action, cwd);
    },

    assertPluginMutationsAllowed: (): void =>
      assertRuntimeEffect(
        effects.allowPluginMutations,
        '隔离运行配置禁止修改真实 Claude Code 插件。',
      ),

    assertRealRuntimeAllowed: (): void =>
      assertRuntimeEffect(
        effects.allowRealRuntimes,
        '隔离运行配置禁止启动真实 PowerShell、Claude Code 或 Codex。',
      ),

    requireApplicationProxyStore: (): ApplicationProxyStore =>
      services.resolve(APPLICATION_PROXY_STORE),

    requireCcSwitchAdapter: (): CcSwitchAdapter => services.resolve(CC_SWITCH_ADAPTER),

    requireClaudeRuntime,

    requireCodexRuntime: (): CodexRuntime => services.resolve(CODEX_RUNTIME),

    requireDownloadEngine: (): DownloadEngine => services.resolve(DOWNLOAD_ENGINE),

    requireManagedChatGptGateway: (): ManagedChatGptGateway =>
      services.resolve(MANAGED_CHATGPT_GATEWAY),

    requireMcpManager: (): McpManager => services.resolve(MCP_MANAGER),

    requireNativeConversationService: (): NativeConversationService =>
      services.resolve(NATIVE_CONVERSATION_SERVICE),

    requireNetworkPreflightService: (): NetworkPreflightService =>
      services.resolve(NETWORK_PREFLIGHT_SERVICE),

    requireProviderAccessGuard,

    validateSender: (event: IpcMainEvent | IpcMainInvokeEvent): void => {
      const mainWindow = services.resolve(MAIN_WINDOW).current;
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame
      ) {
        throw new Error('Rejected IPC from an unknown renderer.');
      }
    },
  };
};
