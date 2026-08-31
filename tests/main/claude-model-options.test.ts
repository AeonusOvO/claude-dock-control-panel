import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeConfigView,
  ClaudeConnectionHistoryEntry,
  ClaudeModelOption,
  ClaudeModelOptions,
  ClaudeInstallationStatus,
  ClaudePermissionMode,
  PtyGeneration,
} from '../../src/shared/contracts';
import type { NormalizedClaudeConfig } from '../../src/main/claude/configuration';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
interface TestSession {
  active: boolean;
  cwd: string;
  diagnosticBuffer: string;
  effortRestoreInProgress: boolean;
  expectedModel?: string;
  exitMarker?: string;
  launchGeneration?: number;
  markerRemainder: string;
  permissionModeCycle: ClaudePermissionMode[];
  ptyGeneration?: PtyGeneration;
  sessionId: string;
}

interface RuntimeInternals {
  configStore: {
    getConfig(cwd: string): NormalizedClaudeConfig;
    getCredential(cwd: string): string | undefined;
    getView(cwd: string): ClaudeConfigView;
  };
  diagnoseInstallation(): Promise<ClaudeInstallationStatus>;
  sessions: Map<string, TestSession>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const createRuntime = (config: NormalizedClaudeConfig, protocol: ClaudeConfigView['protocol']) => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-model-options-'));
  roots.push(root);
  const runtime = new ClaudeRuntime(
    root,
    path.join(root, 'statusline.ps1'),
    path.join(root, 'signal.ps1'),
    path.join(root, 'guard.ps1'),
    () => false,
    () => 'standard',
    () => ({ mode: 'auto' }),
    () => undefined,
    () => true,
    async () => undefined,
    async () => undefined,
    () => undefined,
  );
  const internals = runtime as unknown as RuntimeInternals;
  const session: TestSession = {
    active: true,
    cwd: 'D:\\ModelOptions',
    diagnosticBuffer: '',
    effortRestoreInProgress: false,
    expectedModel: config.model,
    exitMarker: 'exit-marker',
    launchGeneration: 4,
    markerRemainder: '',
    permissionModeCycle: [],
    ptyGeneration: 9,
    sessionId: 'session-model-options',
  };
  internals.configStore.getConfig = vi.fn(() => config);
  internals.configStore.getCredential = vi.fn(() => 'main-process-secret');
  internals.configStore.getView = vi.fn(
    () =>
      ({
        ...config,
        credentialConfigured: true,
        protocol,
      }) as ClaudeConfigView,
  );
  internals.diagnoseInstallation = vi.fn(async (): Promise<ClaudeInstallationStatus> => ({
    executable: 'C:\\Tools\\claude.exe',
    installationKind: 'native',
    installed: true,
    message: 'Claude Code 已就绪。',
    security: 'ready',
    version: '2.1.221',
  }));
  internals.sessions.set(session.sessionId, session);
  vi.spyOn(runtime, 'getConnectionHistory').mockReturnValue([]);
  return { internals, runtime, session };
};

const baseConfig = (overrides: Partial<NormalizedClaudeConfig> = {}): NormalizedClaudeConfig => ({
  apiKeyHelperPolicy: 'inherit',
  authMode: 'apiKey',
  baseUrl: 'https://api.example.test/v1',
  model: 'configured-model',
  modelFast: 'configured-fast-model',
  preset: 'custom',
  provider: 'gateway',
  ...overrides,
});

const optionSection = (options: ClaudeModelOptions, section: ClaudeModelOption['section']) =>
  options.options.filter((option) => option.section === section);

describe('Claude model option discovery', () => {
  it('uses the bounded generic resolver for OpenAI-compatible current platforms', async () => {
    const { runtime, session } = createRuntime(baseConfig(), 'openai');
    const generic = vi.fn(async () => ['discovered-model', 'discovered-model', 'invalid model']);
    const managedChatGpt = vi.fn(async () => ['managed-model']);
    const subscription = vi.fn(async () => ['subscription-model']);
    runtime.setModelDiscoveryResolvers({ generic, managedChatGpt, subscription });

    try {
      const result = await runtime.getModelOptions(session.cwd, session.sessionId);

      expect(generic).toHaveBeenCalledWith(
        session.cwd,
        { endpoint: 'https://api.example.test/v1/models' },
        'main-process-secret',
      );
      expect(managedChatGpt).not.toHaveBeenCalled();
      expect(subscription).not.toHaveBeenCalled();
      expect(result.sections).toMatchObject([
        { id: 'current-platform', status: 'discovered' },
        { id: 'history', status: 'history' },
      ]);
      expect(optionSection(result, 'current-platform').map((option) => option.model)).toEqual([
        'configured-model',
        'discovered-model',
        'configured-fast-model',
        'default',
      ]);
      expect(optionSection(result, 'history')).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain('main-process-secret');
    } finally {
      runtime.shutdown();
    }
  });

  it('uses the managed ChatGPT gateway model list for subscription access', async () => {
    const { runtime, session } = createRuntime(
      baseConfig({
        authMode: 'authToken',
        baseUrl: 'http://127.0.0.1:8317',
        model: 'gpt-5.6-sol',
        modelFast: undefined,
        preset: 'chatgpt-subscription',
        provider: 'gateway',
      }),
      'anthropic',
    );
    const managedChatGpt = vi.fn(async () => ['gpt-5.6-sol', 'gpt-5.5']);
    const generic = vi.fn(async () => ['wrong-generic-model']);
    const subscription = vi.fn(async () => ['wrong-subscription-model']);
    runtime.setModelDiscoveryResolvers({ generic, managedChatGpt, subscription });

    try {
      const result = await runtime.getModelOptions(session.cwd, session.sessionId);

      expect(managedChatGpt).toHaveBeenCalledOnce();
      expect(generic).not.toHaveBeenCalled();
      expect(subscription).not.toHaveBeenCalled();
      expect(result.sections?.[0]).toMatchObject({ id: 'current-platform', status: 'discovered' });
      expect(optionSection(result, 'current-platform').map((option) => option.model)).toEqual([
        'gpt-5.6-sol',
        'gpt-5.5',
        'gpt-5.4-mini',
      ]);
    } finally {
      runtime.shutdown();
    }
  });

  it('uses the subscription relay resolver for an account-bound local endpoint', async () => {
    const baseUrl = `http://127.0.0.1:18520/s/${'a'.repeat(32)}`;
    const { runtime, session } = createRuntime(
      baseConfig({
        baseUrl,
        model: 'kimi-model',
        modelFast: undefined,
        preset: 'kimi-subscription',
        provider: 'gateway',
      }),
      'anthropic',
    );
    const subscription = vi.fn(async () => ['kimi-model', 'kimi-next']);
    const generic = vi.fn(async () => ['wrong-generic-model']);
    const managedChatGpt = vi.fn(async () => ['wrong-managed-model']);
    runtime.setModelDiscoveryResolvers({ generic, managedChatGpt, subscription });

    try {
      const result = await runtime.getModelOptions(session.cwd, session.sessionId);

      expect(subscription).toHaveBeenCalledWith('kimi-subscription', baseUrl);
      expect(generic).not.toHaveBeenCalled();
      expect(managedChatGpt).not.toHaveBeenCalled();
      expect(result.sections?.[0]).toMatchObject({ id: 'current-platform', status: 'discovered' });
      expect(optionSection(result, 'current-platform').map((option) => option.model)).toEqual([
        'kimi-model',
        'kimi-next',
        'kimi-for-coding',
      ]);
    } finally {
      runtime.shutdown();
    }
  });

  it('keeps configured models and marks discovery degraded when a resolver fails', async () => {
    const { runtime, session } = createRuntime(baseConfig(), 'openai');
    runtime.setModelDiscoveryResolvers({
      generic: vi.fn(async () => {
        throw new Error('upstream unavailable');
      }),
      managedChatGpt: vi.fn(async () => []),
      subscription: vi.fn(async () => []),
    });

    try {
      const result = await runtime.getModelOptions(session.cwd, session.sessionId);

      expect(result.sections?.[0]).toMatchObject({ id: 'current-platform', status: 'degraded' });
      expect(result.sections?.[0]?.detail).toContain('upstream unavailable');
      expect(optionSection(result, 'current-platform').map((option) => option.model)).toEqual([
        'configured-model',
        'configured-fast-model',
        'default',
      ]);
    } finally {
      runtime.shutdown();
    }
  });

  it('deduplicates a discovered context suffix against the canonical active model', async () => {
    const { runtime, session } = createRuntime(baseConfig({ model: 'glm-5.2' }), 'openai');
    runtime.setModelDiscoveryResolvers({
      generic: vi.fn(async () => ['glm-5.2[1m]', 'other-model']),
      managedChatGpt: vi.fn(async () => []),
      subscription: vi.fn(async () => []),
    });

    try {
      const result = await runtime.getModelOptions(session.cwd, session.sessionId);
      const current = optionSection(result, 'current-platform');

      expect(current.map((option) => option.model)).toEqual([
        'glm-5.2',
        'other-model',
        'configured-fast-model',
        'default',
      ]);
      expect(current.filter((option) => option.model === 'glm-5.2')).toHaveLength(1);
      expect(current[0]).toMatchObject({ source: 'active', model: 'glm-5.2' });
    } finally {
      runtime.shutdown();
    }
  });
});

describe('Claude model option history identity', () => {
  it('preserves distinct historical entries that happen to use the same model', async () => {
    const { runtime, session } = createRuntime(baseConfig(), 'openai');
    const entry = (id: string, baseUrl: string): ClaudeConnectionHistoryEntry => ({
      apiKeyHelperPolicy: 'inherit',
      authMode: 'apiKey',
      baseUrl,
      credentialConfigured: true,
      gatewayState: 'unknown',
      id,
      model: 'historical-model',
      preset: 'custom',
      protocol: 'openai',
      provider: 'gateway',
      savedAt: 1,
    });
    vi.spyOn(runtime, 'getConnectionHistory').mockReturnValue([
      entry('history-one', 'https://first.example.test/v1'),
      entry('history-two', 'https://second.example.test/v1'),
    ]);
    vi.spyOn(runtime, 'connectionHistoryEndpointFingerprint').mockImplementation((_cwd, id) => id);

    try {
      const result = await runtime.getModelOptions(session.cwd, session.sessionId);
      const history = optionSection(result, 'history');

      expect(history).toHaveLength(2);
      expect(history.map((option) => option.model)).toEqual([
        'historical-model',
        'historical-model',
      ]);
      expect(history.every((option) => option.section === 'history')).toBe(true);
      expect(new Set(history.map((option) => option.id)).size).toBe(2);
    } finally {
      runtime.shutdown();
    }
  });
});
