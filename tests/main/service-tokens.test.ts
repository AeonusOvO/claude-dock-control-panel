import { describe, expect, it } from 'vitest';
import { Registry } from '../../src/main/infra/registry';
import {
  APPLICATION_PROXY_STORE,
  APPLICATION_PROXY_TEST_SESSION,
  APPLICATION_UPDATER_SERVICE,
  BUSY_REGISTRY,
  CC_SWITCH_ADAPTER,
  CLAUDE_PERMISSION_BRIDGE,
  CLAUDE_RUNTIME,
  CLAUDE_STREAM_DIAGNOSTICS_STORE,
  CODEX_RUNTIME,
  CONVERSATION_NETWORK_SESSION,
  DOWNLOAD_ENGINE,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MCP_MANAGER,
  NATIVE_CONVERSATION_SERVICE,
  NETWORK_PREFLIGHT_SERVICE,
  PROVIDER_ACCESS_GUARD,
  registerLifecycleServiceReferences,
  RUNTIME_PROCESS_REGISTRY,
  TRAY,
} from '../../src/main/infra/service-tokens';

const serviceTokens = [
  APPLICATION_PROXY_STORE,
  APPLICATION_PROXY_TEST_SESSION,
  APPLICATION_UPDATER_SERVICE,
  BUSY_REGISTRY,
  CC_SWITCH_ADAPTER,
  CLAUDE_PERMISSION_BRIDGE,
  CLAUDE_RUNTIME,
  CLAUDE_STREAM_DIAGNOSTICS_STORE,
  CODEX_RUNTIME,
  CONVERSATION_NETWORK_SESSION,
  DOWNLOAD_ENGINE,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MCP_MANAGER,
  NATIVE_CONVERSATION_SERVICE,
  NETWORK_PREFLIGHT_SERVICE,
  PROVIDER_ACCESS_GUARD,
  RUNTIME_PROCESS_REGISTRY,
  TRAY,
] as const;

describe('main service tokens', () => {
  it('declares 19 independent typed symbols', () => {
    expect(serviceTokens).toHaveLength(19);
    expect(new Set(serviceTokens).size).toBe(19);
    expect(serviceTokens.every((token) => typeof token === 'symbol')).toBe(true);
  });

  it('keeps window and tray lifecycle state inside registered references', () => {
    const services = new Registry();
    registerLifecycleServiceReferences(services);

    expect(services.resolve(MAIN_WINDOW)).toEqual({ current: null });
    expect(services.resolve(TRAY)).toEqual({ current: null });
  });
});
