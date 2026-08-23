import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeExecutionSettingsRequest,
  ClaudeExecutionSettingsView,
} from '../../src/shared/contracts/claude-execution-settings';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { claudeExecutionSettingsRequestSchema as aggregateExecutionSettingsRequestSchema } from '../../src/shared/ipc/schema';
import { claudeExecutionSettingsRequestSchema as dedicatedExecutionSettingsRequestSchema } from '../../src/shared/ipc/claude-execution-settings-schema';
import { createIpcHarness } from '../helpers/ipc-harness';

const view = (): ClaudeExecutionSettingsView => ({
  catalogVersion: 1,
  effective: {
    concurrentSubagents: {
      defaultValue: 4,
      effectiveValue: 8,
      envKey: 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
      operation: { kind: 'set', value: '8' },
      reason: '并发子代理设置已应用。',
      requestedValue: 8,
      source: {
        kind: 'version-matrix',
        reference: 'main-only-reference',
      },
      status: 'supported',
    },
    spawnDepth: {
      defaultValue: 1,
      effectiveValue: 2,
      envKey: 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
      operation: { kind: 'set', value: '2' },
      reason: '子代理深度设置已应用。',
      requestedValue: 2,
      source: {
        kind: 'version-matrix',
        reference: 'main-only-reference',
      },
      status: 'supported',
    },
    toolSearch: {
      defaultValue: 'auto',
      effectiveValue: 'auto:25',
      envKey: 'ENABLE_TOOL_SEARCH',
      operation: { kind: 'set', value: 'auto:25' },
      reason: '工具搜索设置已应用。',
      requestedValue: 'auto:25',
      source: {
        expiresAt: 2_000,
        kind: 'verified-evidence',
        reference: 'main-only-evidence',
        verifiedAt: 1_000,
      },
      status: 'supported',
    },
    toolUseConcurrency: {
      defaultValue: 4,
      effectiveValue: 8,
      envKey: 'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
      operation: { kind: 'set', value: '8' },
      reason: '工具并发设置已应用。',
      requestedValue: 8,
      source: {
        kind: 'version-matrix',
        reference: 'main-only-reference',
      },
      status: 'supported',
    },
  },
  installation: { installed: true, version: '2.1.0' },
  requested: { mode: 'profile', profileId: 'balanced' },
  version: 1,
});

const createService = () => ({
  get: vi.fn(async () => view()),
  resetToClaudeDefault: vi.fn(async () => ({
    ...view(),
    requested: { mode: 'claude-default' as const },
  })),
  update: vi.fn(async (requested: ClaudeExecutionSettingsRequest) => ({
    ...view(),
    requested,
  })),
  useRecommended: vi.fn(async () => view()),
});

const registerHarness = async () => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
  const { registerClaudeExecutionSettingsIpc } =
    await import('../../src/main/ipc/claude-execution-settings');
  const service = createService();
  const requireClaudeExecutionSettingsService = vi.fn(() => service as never);
  const validateSender = vi.fn();
  registerClaudeExecutionSettingsIpc({
    guards: { requireClaudeExecutionSettingsService, validateSender },
  });
  return {
    ipc,
    requireClaudeExecutionSettingsService,
    service,
    validateSender,
  };
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('Claude execution-settings IPC', () => {
  it('re-exports the dedicated strict request schema from the aggregate IPC module', () => {
    expect(aggregateExecutionSettingsRequestSchema).toBe(dedicatedExecutionSettingsRequestSchema);
    expect(
      dedicatedExecutionSettingsRequestSchema.parse({
        mode: 'profile',
        profileId: 'balanced',
      }),
    ).toEqual({ mode: 'profile', profileId: 'balanced' });
    expect(() =>
      dedicatedExecutionSettingsRequestSchema.parse({
        environment: {},
        mode: 'profile',
        profileId: 'balanced',
      }),
    ).toThrow();
  });

  it('registers all four operations and returns only the renderer allowlist', async () => {
    const { ipc, service, validateSender } = await registerHarness();

    const getResult = await ipc.invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_GET);
    const updated = await ipc.invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE, {
      mode: 'profile',
      profileId: 'high-throughput',
    });
    await ipc.invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED);
    const restored = await ipc.invoke(CHANNELS.CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT);

    expect(validateSender).toHaveBeenCalledTimes(4);
    expect(service.get).toHaveBeenCalledOnce();
    expect(service.update).toHaveBeenCalledExactlyOnceWith({
      mode: 'profile',
      profileId: 'high-throughput',
    });
    expect(service.useRecommended).toHaveBeenCalledOnce();
    expect(service.resetToClaudeDefault).toHaveBeenCalledOnce();
    expect(updated.requested).toEqual({
      mode: 'profile',
      profileId: 'high-throughput',
    });
    expect(restored.requested).toEqual({ mode: 'claude-default' });

    const serialized = JSON.stringify(getResult);
    expect(serialized).not.toMatch(/envKey|operation|reference|main-only/iu);
    expect(getResult.effective.toolSearch.source).toEqual({
      expiresAt: 2_000,
      kind: 'verified-evidence',
      verifiedAt: 1_000,
    });
  });

  it('validates the sender before parsing input or resolving the service', async () => {
    const { ipc, requireClaudeExecutionSettingsService, validateSender } = await registerHarness();
    const rejection = new Error('Rejected IPC from an unknown renderer.');
    validateSender.mockImplementation(() => {
      throw rejection;
    });
    const handler = ipc.handlers.get(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE);

    expect(() =>
      handler?.({} as never, {
        environment: { ANTHROPIC_AUTH_TOKEN: 'secret' },
        mode: 'profile',
        profileId: 'balanced',
      }),
    ).toThrow(rejection);
    expect(requireClaudeExecutionSettingsService).not.toHaveBeenCalled();
  });

  it('rejects authority fields and extra arguments before service access', async () => {
    const { ipc, requireClaudeExecutionSettingsService, service } = await registerHarness();
    const updateHandler = ipc.handlers.get(CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE);
    const recommendedHandler = ipc.handlers.get(CHANNELS.CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED);
    const restoreHandler = ipc.handlers.get(CHANNELS.CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT);

    expect(() =>
      updateHandler?.({} as never, {
        credentials: 'secret',
        mode: 'profile',
        profileId: 'balanced',
      }),
    ).toThrow();
    expect(() => recommendedHandler?.({} as never, 'unexpected')).toThrow();
    expect(() => restoreHandler?.({} as never, 'unexpected')).toThrow();

    expect(requireClaudeExecutionSettingsService).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.useRecommended).not.toHaveBeenCalled();
    expect(service.resetToClaudeDefault).not.toHaveBeenCalled();
  });
});
