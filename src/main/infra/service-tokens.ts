import type { BrowserWindow, Session, Tray } from 'electron';
import type { CcSwitchAdapter } from '../claude/cc-switch-adapter';
import type { ManagedChatGptGateway } from '../claude/managed-chatgpt-gateway';
import type { ClaudePermissionBridge } from '../claude/permission-bridge';
import type { ClaudeRuntime } from '../claude/runtime';
import type { ClaudeStreamDiagnosticsStore } from '../claude/stream-diagnostics-store';
import type { CodexRuntime } from '../codex/runtime';
import type { BusyRegistry } from '../coordination/busy-registry';
import type { NativeConversationService } from '../conversation/service';
import type { DownloadEngine } from '../download/engine';
import type { MainDiagnostics } from './diagnostics';
import type { Logger } from './logger';
import type { McpManager } from '../mcp/manager';
import type { NetworkDiagnosticsStore } from '../network/diagnostics-store';
import type { NetworkPreflightService } from '../network/preflight-service';
import type { ProviderAccessGuard } from '../network/provider-access-guard';
import type { ApplicationProxyStore } from '../proxy/application-proxy-store';
import type { RuntimeProcessRegistry } from '../runtime/process-registry';
import type { ApplicationUpdaterService } from '../updates/application';
import { createRegistryToken, type Registry } from './registry';

export interface ServiceReference<Value> {
  current: Value | null;
}

export const APPLICATION_PROXY_STORE =
  createRegistryToken<ApplicationProxyStore>('application-proxy-store');
export const APPLICATION_PROXY_TEST_SESSION = createRegistryToken<Session>(
  'application-proxy-test-session',
);
export const APPLICATION_UPDATER_SERVICE = createRegistryToken<ApplicationUpdaterService>(
  'application-updater-service',
);
export const BUSY_REGISTRY = createRegistryToken<BusyRegistry>('busy-registry');
export const CC_SWITCH_ADAPTER = createRegistryToken<CcSwitchAdapter>('cc-switch-adapter');
export const CLAUDE_PERMISSION_BRIDGE = createRegistryToken<ClaudePermissionBridge>(
  'claude-permission-bridge',
);
export const CLAUDE_RUNTIME = createRegistryToken<ClaudeRuntime>('claude-runtime');
export const CLAUDE_STREAM_DIAGNOSTICS_STORE = createRegistryToken<ClaudeStreamDiagnosticsStore>(
  'claude-stream-diagnostics-store',
);
export const CODEX_RUNTIME = createRegistryToken<CodexRuntime>('codex-runtime');
export const CONVERSATION_NETWORK_SESSION = createRegistryToken<Session>(
  'conversation-network-session',
);
export const DOWNLOAD_ENGINE = createRegistryToken<DownloadEngine>('download-engine');
export const MAIN_DIAGNOSTICS = createRegistryToken<MainDiagnostics>('main-diagnostics');
export const MAIN_LOGGER = createRegistryToken<Logger>('main-logger');
export const MAIN_WINDOW =
  createRegistryToken<ServiceReference<BrowserWindow>>('main-window-reference');
export const MANAGED_CHATGPT_GATEWAY =
  createRegistryToken<ManagedChatGptGateway>('managed-chatgpt-gateway');
export const MCP_MANAGER = createRegistryToken<McpManager>('mcp-manager');
export const NATIVE_CONVERSATION_SERVICE = createRegistryToken<NativeConversationService>(
  'native-conversation-service',
);
export const NETWORK_DIAGNOSTICS_STORE = createRegistryToken<NetworkDiagnosticsStore>(
  'network-diagnostics-store',
);
export const NETWORK_PREFLIGHT_SERVICE = createRegistryToken<NetworkPreflightService>(
  'network-preflight-service',
);
export const PROVIDER_ACCESS_GUARD =
  createRegistryToken<ProviderAccessGuard>('provider-access-guard');
export const RUNTIME_PROCESS_REGISTRY = createRegistryToken<RuntimeProcessRegistry>(
  'runtime-process-registry',
);
export const TRAY = createRegistryToken<ServiceReference<Tray>>('tray-reference');

export const registerLifecycleServiceReferences = (services: Registry): void => {
  services.register(MAIN_WINDOW, () => ({ current: null }));
  services.register(TRAY, () => ({ current: null }));
};
