/* eslint-disable max-lines -- This integration specification keeps runtime diagnostic races together. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedClaudeConfig } from '../../src/main/claude/configuration';
import { parseClaudePermissionMode } from '../../src/shared/claude/permission-mode';
import {
  ClaudeRuntime,
  claudeResourceUsage,
  connectionProtocolForRouterProvider,
  defaultConnectionProtocolForPreset,
  effectiveClaudeMetrics,
  mergeClaudeResourceUsage,
  parseClaudeEffortThinkingDisabledError,
  parseClaudeContextWindowError,
  parseClaudeMetrics,
  parseClaudeRuntimeApiError,
  routerRepairInputForProject,
  routerBlockingDetail,
  usesDefaultClaudeRouter,
} from '../../src/main/claude/runtime';
import { POWERSHELL_STARTUP_COMMAND_ENV } from '../../src/main/terminal/session';
import { SUBMIT_DELAY_MS } from '../../src/shared/conversation/composer-input';
import { CHANNELS } from '../../src/shared/ipc/channels';
import type {
  ClaudeConnectionState,
  ClaudeConnectionTestResult,
  ClaudeEffortCompatibility,
  ClaudeEffortRequest,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudeProjectState,
  ClaudeRouterManagementState,
  PtyGeneration,
  SaveClaudeConfigInput,
} from '../../src/shared/contracts';
import type { PendingPermissionModeProbe } from '../../src/main/claude/permission-mode-probe';
import { connectionFingerprint, projectKey } from '../../src/main/claude/runtime-connection';
import { createIpcHarness } from '../helpers/ipc-harness';
import { createTestMainServiceRegistry } from '../helpers/main-service-registry';

interface RuntimeTestSession {
  active: boolean;
  cwd: string;
  diagnosticBuffer: string;
  effortCompatibility?: ClaudeEffortCompatibility;
  effortRequest?: ClaudeEffortRequest;
  effortRestoreAfterTurn?: ClaudeEffortRequest;
  effortRestoreInProgress: boolean;
  exitMarker?: string;
  launchedConfigFingerprint?: string;
  launchGeneration?: number;
  markerRemainder: string;
  permissionMode?: ClaudePermissionMode;
  permissionModeCycle: ClaudePermissionMode[];
  permissionModeRequest?: ClaudePermissionMode;
  ptyGeneration?: PtyGeneration;
  sessionId: string;
  settingsPath?: string;
  signalPath?: string;
  signalSeenAt?: number;
  thinkingEnabledForHighEffort: boolean;
  turnStopPath?: string;
  turnStopSeenAt?: number;
  waitingForCompact?: (signaledAt: number) => void;
}

interface RuntimeTestInternals {
  connectionState(
    runtime: RuntimeTestSession,
    fingerprint: string,
    matchingCheck: ClaudeConnectionTestResult | undefined,
  ): ClaudeConnectionState;
  configStore: {
    createLaunchSnapshot(cwd: string): RuntimeLaunchSnapshot;
    getAllowBypassPermissions(cwd: string): boolean;
    getConfig(cwd: string): NormalizedClaudeConfig;
    getCredential(cwd: string): string | undefined;
    launchSnapshotIsCurrent(cwd: string, snapshot: RuntimeLaunchSnapshot): boolean;
  };
  diagnoseInstallation(): Promise<{
    executable: string;
    installationKind: 'native';
    installed: true;
    message: string;
    security: 'ready';
    version: string;
  }>;
  emitState(runtime: RuntimeTestSession): Promise<void>;
  modelOptionRegistry: Map<
    string,
    {
      configFingerprint: string;
      configScope: string;
      cwdKey: string;
      entryId?: string;
      expiresAt: number;
      launchGeneration: number;
      option: ClaudeModelOption;
      ptyGeneration?: PtyGeneration;
      sessionId: string;
      targetSpeed?: 'fast' | 'standard';
    }
  >;
  pollMetricsOnce(): Promise<void>;
  preparedLaunches: Map<object, { replacement?: RuntimeTestSession }>;
  prepareRouteServices(...args: unknown[]): Promise<void>;
  readLaunchArtifact(artifactPath: string): Promise<string>;
  sessions: Map<string, RuntimeTestSession>;
  submitClaudeCommand(
    runtime: RuntimeTestSession,
    commandLine: string,
    assertCurrent?: () => void,
  ): Promise<void>;
}

interface RuntimeLaunchSnapshot {
  allowBypassPermissions: boolean;
  config: NormalizedClaudeConfig;
  credential?: string;
  storage: Record<string, unknown>;
}

interface RuntimeHarnessOptions {
  active?: boolean;
  readPermissionModeFromScreen?: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
  ) => Promise<ClaudePermissionMode | undefined>;
  webResearchIsolation?: () => boolean;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('electron');
  vi.resetModules();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRuntime = (options: RuntimeHarnessOptions = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-runtime-diagnostics-'));
  temporaryRoots.push(root);
  const writes: Array<{ data: string; ptyGeneration: PtyGeneration; sessionId: string }> = [];
  const runtime = new ClaudeRuntime(
    root,
    path.join(root, 'statusline.ps1'),
    path.join(root, 'signal.ps1'),
    path.join(root, 'web-search-guard.ps1'),
    options.webResearchIsolation ?? (() => false),
    () => 'standard',
    () => ({ mode: 'auto' }),
    () => undefined,
    (sessionId, ptyGeneration, data) => {
      writes.push({ data, ptyGeneration, sessionId });
      return true;
    },
    options.readPermissionModeFromScreen ?? (async () => undefined),
    async () => undefined,
    () => undefined,
  );
  const internals = runtime as unknown as RuntimeTestInternals;
  internals.diagnoseInstallation = vi.fn(
    async () =>
      ({
        executable: 'C:\\Tools\\claude.exe',
        installationKind: 'native',
        installed: true,
        message: 'Claude Code 已就绪。',
        security: 'ready',
        version: '2.1.221',
      }) as const,
  );
  internals.emitState = vi.fn(async () => undefined);
  internals.prepareRouteServices = vi.fn(async () => undefined);
  const session: RuntimeTestSession = {
    active: options.active ?? true,
    cwd: 'D:\\Project',
    diagnosticBuffer: '',
    effortRestoreInProgress: false,
    exitMarker: 'exit-marker',
    markerRemainder: '',
    permissionModeCycle: [],
    sessionId: 'session-1',
    thinkingEnabledForHighEffort: false,
  };
  internals.sessions.set(session.sessionId, session);
  return { internals, root, runtime, session, writes };
};

const launchConfig = (
  apiKeyHelperPolicy: NormalizedClaudeConfig['apiKeyHelperPolicy'],
): NormalizedClaudeConfig => ({
  apiKeyHelperPolicy,
  authMode: 'apiKey',
  baseUrl: '',
  model: 'claude-sonnet-5',
  modelFast: 'claude-sonnet-5',
  preset: 'anthropic',
  provider: 'anthropic',
});

const useLaunchConfig = (internals: RuntimeTestInternals, config: NormalizedClaudeConfig): void => {
  const snapshot: RuntimeLaunchSnapshot = {
    allowBypassPermissions: false,
    config,
    credential: 'project-secret',
    storage: {},
  };
  internals.configStore.createLaunchSnapshot = vi.fn(() => snapshot);
  internals.configStore.launchSnapshotIsCurrent = vi.fn(() => true);
  internals.configStore.getAllowBypassPermissions = vi.fn(() => false);
  internals.configStore.getConfig = vi.fn(() => config);
  internals.configStore.getCredential = vi.fn(() => snapshot.credential);
};

const preparedSession = (internals: RuntimeTestInternals, token: object): RuntimeTestSession => {
  const replacement = internals.preparedLaunches.get(token)?.replacement;
  if (!replacement) throw new Error('Missing prepared runtime session.');
  return replacement;
};

interface RuntimeSettings {
  alwaysThinkingEnabled?: boolean;
  apiKeyHelper?: string;
  hooks?: {
    PreToolUse?: Array<{
      hooks: Array<{ command: string }>;
      matcher: string;
    }>;
  };
}

const readSettings = (session: RuntimeTestSession): RuntimeSettings => {
  if (!session.settingsPath) throw new Error('Missing runtime settings path.');
  return JSON.parse(readFileSync(session.settingsPath, 'utf8')) as RuntimeSettings;
};

const projectState = (session: RuntimeTestSession): ClaudeProjectState =>
  ({
    active: session.active,
    cwd: session.cwd,
    sessionId: session.sessionId,
  }) as ClaudeProjectState;

/** Mirrors the rolling window `consumeTerminalOutput` keeps for diagnostics. */
const DIAGNOSTIC_BUFFER_LIMIT = 4_000;

const feedChunks = (chunks: readonly string[]): string => {
  let buffer = '';
  for (const chunk of chunks) {
    buffer = `${buffer}${chunk}`.slice(-DIAGNOSTIC_BUFFER_LIMIT);
  }
  return buffer;
};

describe('connection history protocol metadata', () => {
  it('maps both OpenAI router variants without guessing unknown manual router state', () => {
    expect(connectionProtocolForRouterProvider('anthropic_messages')).toBe('anthropic');
    expect(connectionProtocolForRouterProvider('openai_chat_completions')).toBe('openai');
    expect(connectionProtocolForRouterProvider('openai_responses')).toBe('openai');
    expect(defaultConnectionProtocolForPreset('gateway')).toBe('unknown');
    expect(defaultConnectionProtocolForPreset('custom')).toBe('anthropic');
  });

  it('does not turn warning-only connection checks into a failed model connection', () => {
    const { internals, runtime, session } = createRuntime();
    const warning: ClaudeConnectionTestResult = {
      message: '需要启动会话后确认。',
      ok: false,
      stages: [],
      testedAt: 1,
      tone: 'warning',
    };

    try {
      expect(internals.connectionState(session, 'matching', warning)).toEqual({
        detail: warning.message,
        observedAt: warning.testedAt,
        readiness: 'unknown',
        source: 'connection-test',
      });
    } finally {
      runtime.shutdown();
    }
  });
});

const routerConfig: NormalizedClaudeConfig = {
  apiKeyHelperPolicy: 'prefer-claudedock',
  authMode: 'authToken',
  baseUrl: 'http://127.0.0.1:3456',
  model: 'relay/claude-sonnet-4-5',
  preset: 'gateway',
  provider: 'gateway',
};

const routerState: ClaudeRouterManagementState = {
  canUninstall: true,
  checkedAt: Date.now(),
  endpoint: 'http://127.0.0.1:3456',
  gatewayState: 'error',
  installed: true,
  installationKind: 'npm',
  manageable: true,
  managementAvailable: true,
  message: 'No available models.',
  providers: [],
  serviceRunning: true,
  version: '3.0.15',
};

describe('Claude runtime route diagnostics', () => {
  it('keeps live context metrics when provider balance data is merged', () => {
    const checkedAt = Date.now();
    const merged = mergeClaudeResourceUsage(
      {
        availability: 'available',
        autoCompactAtTokens: 206_720,
        capabilities: { balance: false, context: true, windows: true },
        checkedAt,
        contextUsedPercent: 25,
        contextUsedTokens: 64_600,
        contextWindowTokens: 258_400,
        source: 'claude-statusline',
        windows: [{ label: '5 hours', usedPercent: 30 }],
      },
      {
        availability: 'available',
        balance: { balances: [{ amount: 12.5, currency: 'USD' }] },
        capabilities: { balance: true, context: false, windows: false },
        checkedAt: checkedAt + 1,
        source: 'openrouter-key',
      },
    );

    expect(merged).toMatchObject({
      autoCompactAtTokens: 206_720,
      balance: { balances: [{ amount: 12.5, currency: 'USD' }] },
      capabilities: { balance: true, context: true, windows: true },
      contextUsedPercent: 25,
      contextUsedTokens: 64_600,
      contextWindowTokens: 258_400,
      source: 'openrouter-key',
      windows: [{ label: '5 hours', usedPercent: 30 }],
    });
  });

  it('reports the Codex 95% effective window only for the matching managed model', () => {
    const metrics = { capturedAt: Date.now(), contextWindowSize: 272_000 };
    const managed: NormalizedClaudeConfig = {
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: 'authToken',
      baseUrl: 'http://127.0.0.1:8317',
      model: 'gpt-5.6-sol',
      preset: 'chatgpt-subscription',
      provider: 'gateway',
    };

    expect(effectiveClaudeMetrics(metrics, managed)?.contextWindowSize).toBe(258_400);
    expect(
      effectiveClaudeMetrics({ ...metrics, contextWindowSize: 1_050_000 }, managed, 'extended')
        ?.contextWindowSize,
    ).toBe(997_500);
    expect(
      effectiveClaudeMetrics(metrics, { ...managed, model: 'gpt-5.4-mini' })?.contextWindowSize,
    ).toBe(272_000);
  });

  it('uses the live smaller window when Claude Code does not accept the requested override', () => {
    const managed: NormalizedClaudeConfig = {
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: 'authToken',
      baseUrl: 'http://127.0.0.1:8317',
      model: 'gpt-5.6-sol',
      preset: 'chatgpt-subscription',
      provider: 'gateway',
    };

    expect(
      claudeResourceUsage(
        { capturedAt: Date.now(), contextWindowSize: 200_000, contextWindowUsed: 50_000 },
        managed,
        'extended',
      ),
    ).toMatchObject({
      autoCompactAtTokens: 160_000,
      contextUsedPercent: 25,
      contextWindowTokens: 200_000,
    });
  });

  it('reports the real ratio when the status line clamps usage to an undersized window', () => {
    const gateway: NormalizedClaudeConfig = {
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: 'authToken',
      baseUrl: 'https://gateway.example',
      model: 'claude-opus-5',
      preset: 'custom',
      provider: 'gateway',
    };

    // The exact shape observed in a real session: a 1M-capable endpoint behind a plain model name,
    // so Claude Code assumed 200k, pinned `contextWindowUsed` at the window, and the bar froze.
    const usage = claudeResourceUsage(
      {
        capturedAt: Date.now(),
        contextWindowSize: 200_000,
        contextWindowUsed: 200_000,
        inputTokens: 301_260,
      },
      gateway,
      'standard',
    );

    expect(usage.contextCountingAnomaly).toEqual({
      reportedTokens: 301_260,
      windowTokens: 200_000,
    });
    expect(usage.contextUsedTokens).toBe(301_260);
    expect(usage.contextUsedPercent).toBeCloseTo(150.63, 1);
  });

  it('does not flag an anomaly while usage sits below the declared window', () => {
    const gateway: NormalizedClaudeConfig = {
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: 'authToken',
      baseUrl: 'https://gateway.example',
      model: 'claude-opus-5',
      preset: 'custom',
      provider: 'gateway',
    };

    const usage = claudeResourceUsage(
      {
        capturedAt: Date.now(),
        contextWindowSize: 1_000_000,
        contextWindowUsed: 250_000,
        inputTokens: 250_000,
      },
      gateway,
      'standard',
    );

    expect(usage.contextCountingAnomaly).toBeUndefined();
    expect(usage.contextUsedPercent).toBe(25);
  });

  it('treats a shortened gateway context-window rejection as a context error', () => {
    expect(parseClaudeContextWindowError('API Error: 400 prompt is too long')).toBe(true);
    expect(parseClaudeContextWindowError('API Error: 400 Prompt too long')).toBe(true);
    expect(parseClaudeContextWindowError('API Error: 401 invalid api key')).toBe(false);
  });

  it('keeps the official status-line session title for workspace synchronization', () => {
    const metrics = parseClaudeMetrics(
      JSON.stringify({
        capturedAt: Date.now(),
        fastMode: true,
        modelId: 'claude-sonnet',
        sessionId: 'conversation-id',
        sessionName: '修复登录重定向',
      }),
    );

    expect(metrics).toMatchObject({
      fastMode: true,
      sessionId: 'conversation-id',
      sessionName: '修复登录重定向',
    });
    expect(
      parseClaudeMetrics(JSON.stringify({ capturedAt: Date.now(), fastMode: 'true' }))?.fastMode,
    ).toBeUndefined();
  });

  it('recognizes the real Claude Code ConnectionRefused output without echoing raw details', () => {
    expect(
      parseClaudeRuntimeApiError(
        '\u001B[31mAPI Error: Unable to connect to API (ConnectionRefused)\u001B[0m\r\n',
      ),
    ).toContain('无法连接');
    expect(
      parseClaudeRuntimeApiError(
        '\u001B[31mAPI Error: Unable to connect to API (ConnectionRefused)\u001B[0m\r\n',
      ),
    ).not.toContain('ConnectionRefused');
    expect(parseClaudeRuntimeApiError('Claude Code ready')).toBeUndefined();
  });

  it('redacts credential-shaped values from generic API errors', () => {
    const result = parseClaudeRuntimeApiError(
      'API Error: upstream rejected Bearer sk-example-sensitive-token',
    );

    expect(result).toContain('接口请求失败');
    expect(result).not.toContain('upstream rejected');
    expect(result).not.toContain('sk-example-sensitive-token');
  });

  it('classifies an upstream context overflow and gives a recoverable next step', () => {
    const error =
      'Error during compaction: API Error: 400 Your input exceeds the context window of this model. Please adjust your input and try again.';

    expect(parseClaudeContextWindowError(error)).toBe(true);
    expect(parseClaudeRuntimeApiError(error)).toContain('新建对话');
    expect(parseClaudeRuntimeApiError(error)).toContain('按模型与窗口模式');
  });

  it('recognizes wrapped effort errors only when high effort conflicts with disabled thinking', () => {
    const wrappedMax =
      "API Error: 400 output_config.effort 'max' is not supported when thinking is\r\n" +
      'disabled on this model. Use effort high or below, or enable thinking.';
    const wrappedXhigh =
      "API Error: 400 output_config.effort 'xhigh' is not supported when thinking is\n" +
      'disabled on this model.';

    expect(parseClaudeEffortThinkingDisabledError(wrappedMax)).toBe('max');
    expect(parseClaudeEffortThinkingDisabledError(wrappedXhigh)).toBe('xhigh');
    expect(parseClaudeRuntimeApiError(wrappedMax)).toContain('自动降到“均衡”');
    expect(
      parseClaudeEffortThinkingDisabledError(
        "API Error: 400 output_config.effort 'high' is not supported by this relay.",
      ),
    ).toBeUndefined();
    expect(
      parseClaudeEffortThinkingDisabledError('API Error: 500 upstream unavailable'),
    ).toBeUndefined();
  });

  it('blocks a project that points at CCR while its Provider list is empty', () => {
    expect(usesDefaultClaudeRouter(routerConfig)).toBe(true);
    expect(routerBlockingDetail(routerConfig, routerState)).toContain('没有任何服务提供方');
  });

  it('does not apply an unrelated CCR failure to a direct remote endpoint', () => {
    const directConfig: NormalizedClaudeConfig = {
      ...routerConfig,
      baseUrl: 'https://gateway.example.com',
      preset: 'custom',
    };

    expect(usesDefaultClaudeRouter(directConfig)).toBe(false);
    expect(routerBlockingDetail(directConfig, routerState)).toBeUndefined();
  });

  it('builds a secret-preserving one-click repair input from a direct Anthropic project', () => {
    const directConfig: NormalizedClaudeConfig = {
      apiKeyHelperPolicy: 'prefer-claudedock',
      authMode: 'apiKey',
      baseUrl: 'https://gateway.example.com/team',
      model: 'team-opus',
      preset: 'custom',
      provider: 'gateway',
    };

    expect(routerRepairInputForProject(directConfig, 'stored-project-key')).toEqual({
      apiKey: 'stored-project-key',
      baseUrl: 'https://gateway.example.com/team/v1/messages',
      credentialAction: 'replace',
      makePreferred: true,
      models: ['team-opus'],
      name: 'claudedock-gateway.example.com',
      protocol: 'anthropic_messages',
      useForCurrentProject: false,
    });
    expect(() =>
      routerRepairInputForProject({ ...directConfig, authMode: 'authToken' }, 'bearer-token'),
    ).toThrow('接口密钥');
  });

  it('isolates inherited helpers per launch and includes the policy in launch ownership', async () => {
    const { internals, runtime } = createRuntime({ active: false });
    const preferConfig = launchConfig('prefer-claudedock');
    useLaunchConfig(internals, preferConfig);

    try {
      const preferLaunch = await runtime.prepareLaunch('prefer-session', 'D:\\Project', 'new');
      const preferSession = preparedSession(internals, preferLaunch.token);
      const preferSettings = readSettings(preferSession);
      expect(preferSettings.apiKeyHelper).toBe('');

      const inheritedConfig = launchConfig('inherit');
      useLaunchConfig(internals, inheritedConfig);
      const inheritLaunch = await runtime.prepareLaunch('inherit-session', 'D:\\Project', 'new');
      const inheritSession = preparedSession(internals, inheritLaunch.token);
      const inheritSettings = readSettings(inheritSession);
      expect(Object.hasOwn(inheritSettings, 'apiKeyHelper')).toBe(false);
      expect(inheritSession.launchedConfigFingerprint).not.toBe(
        preferSession.launchedConfigFingerprint,
      );
    } finally {
      runtime.shutdown();
    }
  });

  it('enables thinking, narrows a rejected effort for one turn, then restores it on Stop', async () => {
    vi.useFakeTimers();
    const { internals, root, runtime, session, writes } = createRuntime();
    session.launchGeneration = 1;
    session.settingsPath = path.join(root, 'settings.json');
    session.turnStopPath = path.join(root, 'turn-stop.json');
    writeFileSync(session.settingsPath, '{}\n', 'utf8');
    session.ptyGeneration = 7;
    vi.spyOn(runtime, 'getState').mockResolvedValue(projectState(session));

    try {
      const setMaximum = runtime.setEffort(session.sessionId, session.cwd, 'max');
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      await setMaximum;
      expect(readSettings(session).alwaysThinkingEnabled).toBe(true);
      expect(writes.map(({ data }) => data)).toEqual(['/effort max', '\r']);

      runtime.consumeTerminalOutput(
        session.sessionId,
        7,
        "API Error: 400 output_config.effort 'max' is not supported when thinking is disabled on this model.",
      );
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      await Promise.resolve();
      expect(writes.map(({ data }) => data)).toEqual(['/effort max', '\r', '/effort high', '\r']);
      expect(session.effortCompatibility).toMatchObject({
        maximum: 'high',
        recovery: 'recovered',
        rejectedLevel: 'max',
      });
      expect(session.effortRestoreAfterTurn).toBe('max');
      await expect(runtime.setEffort(session.sessionId, session.cwd, 'xhigh')).rejects.toThrow(
        '只能选择“均衡”或更低档位',
      );

      let signaledAt = session.effortCompatibility?.detectedAt ?? 0;
      internals.readLaunchArtifact = vi.fn(async () =>
        JSON.stringify({ event: 'Stop', signaledAt }),
      );
      await internals.pollMetricsOnce();
      expect(writes).toHaveLength(4);

      signaledAt += 1;
      await internals.pollMetricsOnce();
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      await Promise.resolve();
      expect(writes.map(({ data }) => data)).toEqual([
        '/effort max',
        '\r',
        '/effort high',
        '\r',
        '/effort max',
        '\r',
      ]);
      expect(session.effortCompatibility).toBeUndefined();
      expect(session.effortRestoreAfterTurn).toBeUndefined();
      expect(session.diagnosticBuffer).toBe('');
    } finally {
      runtime.shutdown();
    }
  });

  it('adds and removes web-research isolation on the next launch only', async () => {
    let isolated = true;
    const { internals, runtime } = createRuntime({
      active: false,
      webResearchIsolation: () => isolated,
    });
    useLaunchConfig(internals, launchConfig('prefer-claudedock'));

    try {
      const enabledLaunch = await runtime.prepareLaunch('isolated-session', 'D:\\Project', 'new');
      const enabledSettings = readSettings(preparedSession(internals, enabledLaunch.token));
      expect(enabledSettings.hooks?.PreToolUse?.[0]?.matcher).toBe('WebSearch|WebFetch');
      expect(enabledSettings.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toContain(
        'claudedock-web-research',
      );
      expect(enabledLaunch.environment[POWERSHELL_STARTUP_COMMAND_ENV]).toContain('--agents');
      expect(enabledLaunch.environment[POWERSHELL_STARTUP_COMMAND_ENV]).toContain(
        'claudedock-web-research',
      );

      isolated = false;
      const plainLaunch = await runtime.prepareLaunch('plain-session', 'D:\\Project', 'new');
      const plainSettings = readSettings(preparedSession(internals, plainLaunch.token));
      expect(plainSettings.hooks?.PreToolUse).toBeUndefined();
      expect(plainLaunch.environment[POWERSHELL_STARTUP_COMMAND_ENV]).not.toContain('--agents');
    } finally {
      runtime.shutdown();
    }
  });
});

describe('Claude runtime permission mode observation', () => {
  it('surfaces the provider model error instead of misclassifying or silently falling back', () => {
    expect(
      parseClaudeRuntimeApiError(
        'API Error: 404 {"error":{"message":"model deepseek-does-not-exist not found"}}',
      ),
    ).toContain('model deepseek-does-not-exist not found');
  });

  it('reads the badge even when a repaint straddles two PTY chunks', () => {
    expect(parseClaudePermissionMode(feedChunks(['⏵⏵ accept ', 'edits on']))).toBe('acceptEdits');
    expect(
      parseClaudePermissionMode(feedChunks(['\u001b[38;5;208m⏸ pl', 'an mo', 'de on\u001b[39m'])),
    ).toBe('plan');
  });

  it('does not mistake a cursor-movement delta for a complete mode badge', () => {
    const rawDelta = '\u001b[23;3H⏵⏵ \u001b[1Cccept e\u001b[1Cits on (shift+tab to cycle)';

    expect(parseClaudePermissionMode(rawDelta)).toBeUndefined();
  });

  it('follows the mode forward as the session repaints new badges', () => {
    const chunks = ['⏸ manual mode on', '\r\n⏵⏵ accept edits on', '\r\n⏸ plan mode on'];
    expect(parseClaudePermissionMode(feedChunks(chunks.slice(0, 1)))).toBe('default');
    expect(parseClaudePermissionMode(feedChunks(chunks.slice(0, 2)))).toBe('acceptEdits');
    expect(parseClaudePermissionMode(feedChunks(chunks))).toBe('plan');
  });

  it('keeps reading the badge after the rolling buffer has scrolled past the older ones', () => {
    const overflowed = feedChunks([
      '⏸ plan mode on',
      'x'.repeat(DIAGNOSTIC_BUFFER_LIMIT),
      '⏵⏵ bypass permissions on',
    ]);

    expect(overflowed.length).toBeLessThanOrEqual(DIAGNOSTIC_BUFFER_LIMIT);
    expect(overflowed).not.toContain('plan mode on');
    expect(parseClaudePermissionMode(overflowed)).toBe('bypassPermissions');
  });

  it('steps the observed Shift+Tab cycle, stops on repetition, and releases its lock', async () => {
    let modes: Array<ClaudePermissionMode | undefined> = ['default', 'acceptEdits', 'default'];
    const readPermissionModeFromScreen = vi.fn(async () => modes.shift());
    const { internals, runtime, session, writes } = createRuntime({
      readPermissionModeFromScreen,
    });
    const requestedModes: Array<ClaudePermissionMode | undefined> = [];
    internals.emitState = vi.fn(async (current) => {
      requestedModes.push(current.permissionModeRequest);
    });
    session.ptyGeneration = 9;
    vi.spyOn(runtime, 'getState').mockResolvedValue(projectState(session));

    try {
      await expect(
        runtime.setPermissionMode(session.sessionId, session.cwd, 'plan'),
      ).rejects.toThrow('不在当前会话的可用循环中');
      expect(writes.map(({ data }) => data)).toEqual(['\u001b[Z', '\u001b[Z']);
      expect(session.permissionModeRequest).toBeUndefined();
      expect(requestedModes).toContain('plan');
      expect(requestedModes.at(-1)).toBeUndefined();

      runtime.observePermissionModeFromScreen(session.sessionId, session.cwd, 9, 'acceptEdits');
      runtime.consumeTerminalOutput(session.sessionId, 9, '⏸ plan mode on');
      expect(session.permissionMode).toBe('acceptEdits');

      modes = ['default', 'acceptEdits'];
      await expect(
        runtime.setPermissionMode(session.sessionId, session.cwd, 'acceptEdits'),
      ).resolves.toMatchObject({ sessionId: session.sessionId });
      expect(writes.map(({ data }) => data)).toEqual(['\u001b[Z', '\u001b[Z', '\u001b[Z']);
    } finally {
      runtime.shutdown();
    }
  });

  it('round-trips a fresh xterm permission-mode probe through main and preload', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain, ipcRenderer: ipc.ipcRenderer }));
    const [probeModule, controlsModule, bridgeModule] = await Promise.all([
      import('../../src/main/claude/permission-mode-probe'),
      import('../../src/main/ipc/claude-controls'),
      import('../../src/preload/bridges/claude'),
    ]);
    const pending = new Map<number, PendingPermissionModeProbe>();
    const order: string[] = [];
    const workspace = {
      getStatus: vi.fn(() => ({ cwd: 'D:\\Project', ptyGeneration: 7 })),
      hasSession: vi.fn(() => true),
    };
    const services = await createTestMainServiceRegistry();
    const { MAIN_WINDOW } = await import('../../src/main/infra/service-tokens');
    services.resolve(MAIN_WINDOW).current = {
      webContents: ipc.webContents,
    } as Electron.BrowserWindow;
    controlsModule.registerClaudeControlsIpc({
      claudeFailure: vi.fn() as never,
      failedRuntimeLaunchCleanupDependencies: {} as never,
      guards: {
        withOfficialProviderAccess: vi.fn(async (_request, operation) => operation()),
        requireClaudeRuntime: vi.fn(() => ({}) as never),
        validateSender: vi.fn(),
      },
      pendingPermissionModeProbes: pending,
      restartRuntimeTerminal: vi.fn() as never,
      services,
      withDevelopmentSessionOperation: vi.fn() as never,
      workspace: workspace as never,
    });
    const probes = probeModule.createPermissionModeProbes({
      pendingPermissionModeProbes: pending,
      services,
      state: { nextPermissionModeProbeId: 1 } as never,
      terminalOutputBatcher: {
        flush: vi.fn(() => {
          order.push('flush');
        }),
      } as never,
      workspace: workspace as never,
    });
    const listener = vi.fn((sessionId: string, ptyGeneration: number, probeId: number) => {
      order.push('renderer');
      bridgeModule.claudeBridge.reportClaudePermissionModeProbe(
        sessionId,
        ptyGeneration,
        probeId,
        'acceptEdits',
      );
    });
    const unsubscribe = bridgeModule.claudeBridge.onClaudePermissionModeProbe(listener);

    await expect(probes.requestPermissionModeFromScreen('session-1', 7)).resolves.toBe(
      'acceptEdits',
    );
    expect(order).toEqual(['flush', 'renderer']);
    expect(listener).toHaveBeenCalledWith('session-1', 7, 1);
    expect(pending.size).toBe(0);

    unsubscribe();
    ipc.emitFromMain(CHANNELS.CLAUDE_PERMISSION_MODE_PROBE, 'session-1', 7, 2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('rejects relaunch-only modes and keeps bypass behind the project gate', async () => {
    const { runtime, session, writes } = createRuntime({
      readPermissionModeFromScreen: async () => 'bypassPermissions',
    });
    session.ptyGeneration = 10;
    vi.spyOn(runtime, 'getState').mockResolvedValue(projectState(session));

    try {
      await expect(
        runtime.setPermissionMode(session.sessionId, session.cwd, 'dontAsk'),
      ).rejects.toThrow('不在 Shift+Tab 循环内');
      runtime.commitAllowBypassPermissions(session.cwd, false);
      await expect(
        runtime.setPermissionMode(session.sessionId, session.cwd, 'bypassPermissions'),
      ).rejects.toThrow('当前项目关闭了「完全允许」预置');
      expect(writes).toEqual([]);

      runtime.commitAllowBypassPermissions(session.cwd, true);
      await expect(
        runtime.setPermissionMode(session.sessionId, session.cwd, 'bypassPermissions'),
      ).resolves.toMatchObject({ sessionId: session.sessionId });
      expect(writes).toEqual([]);
    } finally {
      runtime.shutdown();
    }
  });

  it('validates opaque model options before writing to the live shell', async () => {
    const { internals, runtime, session } = createRuntime();
    session.ptyGeneration = 12;
    useLaunchConfig(internals, launchConfig('prefer-claudedock'));
    vi.spyOn(runtime, 'getState').mockResolvedValue(projectState(session));
    const submit = vi.fn(async () => undefined);
    internals.submitClaudeCommand = submit;
    type TestModelOptionRecord = {
      configFingerprint: string;
      configScope: string;
      cwdKey: string;
      expiresAt: number;
      launchGeneration: number;
      option: ClaudeModelOption;
      ptyGeneration?: PtyGeneration;
      sessionId: string;
    };
    const registry = (
      runtime as unknown as { modelOptionRegistry: Map<string, TestModelOptionRecord> }
    ).modelOptionRegistry;
    const option = (overrides: Partial<ClaudeModelOption> = {}): ClaudeModelOption => ({
      id: 'selected',
      label: 'Claude Sonnet 5',
      model: 'claude-sonnet-5',
      providerLabel: '当前接入',
      requiresRelaunch: false,
      sameEndpoint: true,
      ...overrides,
    });
    const registerOption = (modelOption: ClaudeModelOption): void => {
      const configScope = runtime.connectionConfigScope(session.sessionId, session.cwd);
      const config = internals.configStore.getConfig(configScope);
      registry.set(modelOption.id, {
        configFingerprint: connectionFingerprint(
          config,
          internals.configStore.getCredential(configScope),
        ),
        configScope,
        cwdKey: projectKey(session.cwd),
        expiresAt: Date.now() + 120_000,
        launchGeneration: session.launchGeneration ?? 0,
        option: modelOption,
        ptyGeneration: session.ptyGeneration,
        sessionId: session.sessionId,
      });
    };

    try {
      await expect(runtime.switchModel(session.sessionId, session.cwd, 'selected')).rejects.toThrow(
        '模型选项已经失效',
      );

      registerOption(option({ relaunchReason: 'connection', requiresRelaunch: true }));
      await expect(runtime.switchModel(session.sessionId, session.cwd, 'selected')).rejects.toThrow(
        '其他接入端点',
      );

      registerOption(option({ relaunchReason: 'speed-profile', requiresRelaunch: true }));
      await expect(runtime.switchModel(session.sessionId, session.cwd, 'selected')).rejects.toThrow(
        '服务速度配置',
      );

      registerOption(option({ model: 'bad model' }));
      await expect(runtime.switchModel(session.sessionId, session.cwd, 'selected')).rejects.toThrow(
        '模型标识不合法',
      );

      registerOption(option());
      await runtime.switchModel(session.sessionId, session.cwd, 'selected');
      expect(submit).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledWith(session, '/model claude-sonnet-5', expect.any(Function));
    } finally {
      runtime.shutdown();
    }
  });

  it('invalidates opaque model options across every session and runtime binding fence', () => {
    const { internals, runtime, session } = createRuntime();
    session.launchGeneration = 4;
    session.ptyGeneration = 12;
    useLaunchConfig(internals, launchConfig('prefer-claudedock'));
    const configScope = runtime.connectionConfigScope(session.sessionId, session.cwd);
    const optionId = `model-${'b'.repeat(16)}`;
    const validRecord = (): RuntimeTestInternals['modelOptionRegistry'] extends Map<
      string,
      infer Record
    >
      ? Record
      : never => ({
      configFingerprint: connectionFingerprint(
        internals.configStore.getConfig(configScope),
        internals.configStore.getCredential(configScope),
      ),
      configScope,
      cwdKey: projectKey(session.cwd),
      expiresAt: Date.now() + 120_000,
      launchGeneration: session.launchGeneration ?? 0,
      option: {
        action: 'relaunch',
        id: optionId,
        label: 'Claude Opus 5',
        model: 'claude-opus-5',
        providerLabel: '当前平台',
        relaunchReason: 'speed-profile',
        requiresRelaunch: true,
        sameEndpoint: true,
        section: 'current-platform',
        source: 'discovered',
      },
      ptyGeneration: session.ptyGeneration,
      sessionId: session.sessionId,
      targetSpeed: 'fast',
    });
    const resolve = (sessionId = session.sessionId, cwd = session.cwd): void => {
      runtime.relaunchInputForModelOption(sessionId, cwd, {
        compactFirst: false,
        modelOptionId: optionId,
      });
    };
    const expectStale = (record: ReturnType<typeof validRecord>, invoke = resolve): void => {
      internals.modelOptionRegistry.set(optionId, record);
      expect(invoke).toThrow('模型选项已经失效');
    };

    try {
      expectStale({ ...validRecord(), expiresAt: Date.now() - 1 });
      expectStale(validRecord(), () => resolve('other-session'));
      expectStale(validRecord(), () => resolve(session.sessionId, 'D:\\OtherProject'));
      expectStale({ ...validRecord(), configFingerprint: 'stale-configuration' });
      expectStale({ ...validRecord(), launchGeneration: (session.launchGeneration ?? 0) - 1 });
      expectStale({ ...validRecord(), ptyGeneration: (session.ptyGeneration ?? 0) - 1 });
    } finally {
      runtime.shutdown();
    }
  });

  it('resolves a current-platform relaunch token to its main-owned model and speed', () => {
    const { internals, runtime, session } = createRuntime();
    session.ptyGeneration = 12;
    useLaunchConfig(internals, launchConfig('prefer-claudedock'));
    const configScope = runtime.connectionConfigScope(session.sessionId, session.cwd);
    const optionId = `model-${'a'.repeat(16)}`;
    internals.modelOptionRegistry.set(optionId, {
      configFingerprint: connectionFingerprint(
        internals.configStore.getConfig(configScope),
        internals.configStore.getCredential(configScope),
      ),
      configScope,
      cwdKey: projectKey(session.cwd),
      expiresAt: Date.now() + 120_000,
      launchGeneration: session.launchGeneration ?? 0,
      option: {
        action: 'relaunch',
        id: optionId,
        label: 'Claude Opus 5',
        model: 'claude-opus-5',
        providerLabel: '当前平台',
        relaunchReason: 'speed-profile',
        requiresRelaunch: true,
        sameEndpoint: true,
        section: 'current-platform',
        source: 'discovered',
      },
      ptyGeneration: session.ptyGeneration,
      sessionId: session.sessionId,
      targetSpeed: 'fast',
    });

    try {
      expect(
        runtime.relaunchInputForModelOption(session.sessionId, session.cwd, {
          compactFirst: true,
          entryId: 'renderer-entry',
          model: 'renderer-model',
          modelOptionId: optionId,
          permissionMode: 'plan',
          speed: 'standard',
        }),
      ).toEqual({
        compactFirst: true,
        model: 'claude-opus-5',
        permissionMode: 'plan',
        speed: 'fast',
      });
    } finally {
      runtime.shutdown();
    }
  });

  it('runs route readiness and official network guards before real connection tests', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const { registerClaudeStateIpc } = await import('../../src/main/ipc/claude-state');
    const calls: string[] = [];
    const result: ClaudeConnectionTestResult = {
      message: '连接成功。',
      ok: true,
      stages: [],
      testedAt: 1,
      tone: 'success',
    };
    const testConnection = vi.fn(async (_cwd: string, input: SaveClaudeConfigInput) => {
      calls.push(`test:${input.preset}`);
      return result;
    });
    const ensureRunning = vi.fn(async () => {
      calls.push('gateway');
    });
    const withOfficialProviderAccess = vi.fn(async (request, operation) => {
      calls.push(`lease:${request.provider}:start`);
      return operation().finally(() => calls.push(`lease:${request.provider}:end`));
    });
    registerClaudeStateIpc({
      guards: {
        withOfficialProviderAccess: withOfficialProviderAccess as never,
        requireClaudeRuntime: vi.fn(() => ({ testConnection }) as never),
        requireManagedChatGptGateway: vi.fn(() => ({ ensureRunning }) as never),
        validateSender: vi.fn(),
      },
      workspace: {
        getStatus: vi.fn(() => ({ cwd: 'D:\\Project', ptyGeneration: 7 })),
      } as never,
    });

    const officialInput: SaveClaudeConfigInput = {
      authMode: 'existing',
      baseUrl: '',
      credentialAction: 'keep',
      model: 'default',
      preset: 'anthropic',
      provider: 'anthropic',
    };
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_TEST_CONNECTION, 'session-1', officialInput),
    ).resolves.toEqual(result);
    expect(calls).toEqual([
      'lease:anthropic-claude:start',
      'test:anthropic',
      'lease:anthropic-claude:end',
    ]);

    calls.length = 0;
    const subscriptionInput: SaveClaudeConfigInput = {
      authMode: 'authToken',
      baseUrl: 'http://127.0.0.1:8317',
      credential: 'local-token',
      credentialAction: 'replace',
      model: 'gpt-5.6-sol',
      modelFast: 'gpt-5.4-mini',
      preset: 'chatgpt-subscription',
      provider: 'gateway',
    };
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_TEST_CONNECTION, 'session-1', subscriptionInput),
    ).resolves.toEqual(result);
    expect(calls).toEqual([
      'lease:openai-codex:start',
      'gateway',
      'test:chatgpt-subscription',
      'lease:openai-codex:end',
    ]);

    withOfficialProviderAccess.mockRejectedValueOnce(new Error('network blocked'));
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_TEST_CONNECTION, 'session-1', subscriptionInput),
    ).resolves.toMatchObject({ ok: false });
    expect(withOfficialProviderAccess.mock.calls.map(([request]) => request)).toEqual([
      { action: 'first-request', cwd: 'D:\\Project', provider: 'anthropic-claude' },
      { action: 'first-request', cwd: 'D:\\Project', provider: 'openai-codex' },
      { action: 'first-request', cwd: 'D:\\Project', provider: 'openai-codex' },
    ]);
    expect(ensureRunning).toHaveBeenCalledOnce();
    expect(testConnection).toHaveBeenCalledTimes(2);
  });

  it('publishes one restoral event through the preload bridge only when visibility changes', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      app: { getAppPath: vi.fn(() => 'D:\\ClaudeDock'), isPackaged: false },
      BrowserWindow: class {},
      ipcRenderer: ipc.ipcRenderer,
      webUtils: { getPathForFile: vi.fn(() => '') },
    }));
    const [{ createWindowController }, { appBridge }] = await Promise.all([
      import('../../src/main/app/window'),
      import('../../src/preload/bridges/app'),
    ]);
    let visible = false;
    let minimized = false;
    const fakeWindow = {
      focus: vi.fn(),
      isMinimized: vi.fn(() => minimized),
      isVisible: vi.fn(() => visible),
      restore: vi.fn(() => {
        minimized = false;
      }),
      show: vi.fn(() => {
        visible = true;
      }),
      webContents: ipc.webContents,
    };
    const services = await createTestMainServiceRegistry();
    const { MAIN_WINDOW } = await import('../../src/main/infra/service-tokens');
    services.resolve(MAIN_WINDOW).current = fakeWindow as unknown as Electron.BrowserWindow;
    const controller = createWindowController({
      appPreferencesStore: {} as never,
      invalidateLaunchPreflightDecisions: vi.fn(),
      requestQuit: vi.fn(),
      services,
      state: {} as never,
      workspaceStore: {} as never,
    });
    const restored = vi.fn();
    const unsubscribe = appBridge.onAppWindowRestored(restored);

    controller.showMainWindow();
    controller.showMainWindow();
    expect(restored).toHaveBeenCalledOnce();

    minimized = true;
    controller.showMainWindow();
    expect(fakeWindow.restore).toHaveBeenCalledOnce();
    expect(restored).toHaveBeenCalledTimes(2);

    unsubscribe();
    visible = false;
    controller.showMainWindow();
    expect(restored).toHaveBeenCalledTimes(2);
  });

  it('serializes slash commands as separate body and return writes with a lease recheck', async () => {
    vi.useFakeTimers();
    const { runtime, session, writes } = createRuntime();
    session.ptyGeneration = 15;
    vi.spyOn(runtime, 'getState').mockResolvedValue(projectState(session));

    try {
      const first = runtime.runCommand(session.sessionId, session.cwd, '/model claude-sonnet-5');
      const second = runtime.runCommand(session.sessionId, session.cwd, '/doctor');
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.map(({ data }) => data)).toEqual(['/model claude-sonnet-5']);

      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      expect(writes.map(({ data }) => data)).toEqual(['/model claude-sonnet-5', '\r', '/doctor']);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      await Promise.all([first, second]);
      expect(writes.map(({ data }) => data)).toEqual([
        '/model claude-sonnet-5',
        '\r',
        '/doctor',
        '\r',
      ]);

      const stale = runtime.runCommand(session.sessionId, session.cwd, '/compact');
      const rejection = expect(stale).rejects.toThrow('会话已停止或重启');
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.at(-1)?.data).toBe('/compact');
      expect(runtime.setInactive(session.sessionId, 15)).toBe(true);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      await rejection;
      expect(writes.at(-1)?.data).toBe('/compact');
    } finally {
      runtime.shutdown();
    }
  });

  it('ignores an in-flight stale PostCompact read and deduplicates fresh stamps', async () => {
    const { internals, root, runtime, session } = createRuntime();
    session.ptyGeneration = 19;
    session.launchGeneration = 1;
    session.signalPath = path.join(root, 'signal.json');
    const waitingForCompact = vi.fn();
    session.waitingForCompact = waitingForCompact;
    let resolveStale!: (value: string) => void;
    const staleRead = new Promise<string>((resolve) => {
      resolveStale = resolve;
    });
    const readArtifact = vi.fn(async () => staleRead);
    internals.readLaunchArtifact = readArtifact;

    try {
      const stalePoll = internals.pollMetricsOnce();
      await vi.waitFor(() => {
        expect(readArtifact).toHaveBeenCalledOnce();
      });
      session.launchGeneration = 2;
      resolveStale(JSON.stringify({ event: 'PostCompact', signaledAt: 100 }));
      await stalePoll;
      expect(waitingForCompact).not.toHaveBeenCalled();

      let artifact = JSON.stringify({ event: 'PostCompact', signaledAt: 101 });
      internals.readLaunchArtifact = vi.fn(async () => artifact);
      await internals.pollMetricsOnce();
      await internals.pollMetricsOnce();
      expect(waitingForCompact).toHaveBeenCalledTimes(1);
      expect(waitingForCompact).toHaveBeenCalledWith(101);

      artifact = JSON.stringify({ event: 'Stop', signaledAt: 102 });
      await internals.pollMetricsOnce();
      expect(waitingForCompact).toHaveBeenCalledTimes(1);
    } finally {
      runtime.shutdown();
    }
  });
});
