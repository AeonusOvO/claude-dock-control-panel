/* eslint-disable max-lines -- This integration specification verifies one cross-feature session-ownership state machine with a shared IPC harness. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeProjectState,
  DevelopmentRuntime,
  NetworkPreflightResult,
  NetworkProviderId,
  TerminalStatus,
} from '../../src/shared/contracts';
import { ClaudeConversationLifecycleCoordinator } from '../../src/main/claude/conversation-lifecycle';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import { connectionFingerprint, projectKey } from '../../src/main/claude/runtime-connection';
import { createDevelopmentSessionCoordination } from '../../src/main/coordination/development-session';
import {
  LAUNCH_PREFLIGHT_DECISION_TTL_MS,
  launchPauseDiagnosticsFromResult,
  LaunchPreflightDecisionCoordinator,
  type ClaudeLaunchDecisionBaseline,
  type ClaudeLaunchDescriptor,
} from '../../src/main/coordination/launch-preflight-decision';
import {
  OwnedConfigTransactionError,
  ProjectRuntimeSwitchCoordinator,
  runOwnedConfigTransaction,
  type RuntimeSwitchSessionSnapshot,
} from '../../src/main/coordination/main-process-operation';
import {
  ProjectDirectoryLifecycleCoordinator,
  runOwnedProjectDirectoryClosure,
} from '../../src/main/coordination/project-directory-lifecycle';
import { SessionOperationCoordinator } from '../../src/main/coordination/session-operation';
import { createDeleteClaudeConversation } from '../../src/main/conversation/deletion';
import { ConversationOwnerRegistry } from '../../src/main/conversation/owner-registry';
import { Registry } from '../../src/main/infra/registry';
import { CODEX_RUNTIME } from '../../src/main/infra/service-tokens';
import type { RestartRuntimeTerminal } from '../../src/main/terminal/lifecycle';
import {
  enteredTerminalFailure,
  TerminalTransitionCoordinator,
} from '../../src/main/terminal/lifecycle';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const projectState = {
  active: true,
  config: { model: 'model' },
  cwd: 'D:\\Project',
  sessionId: 'session-1',
} as unknown as ClaudeProjectState;

const launchDecisionBaseline = (sessionId = 'session-1'): ClaudeLaunchDecisionBaseline =>
  ({
    configuration: {
      cwdKey: 'd:\\project',
      officialNetworkProvider: 'anthropic-claude',
      revision: 'config-revision',
    },
    operation: { revision: 1, sessionId },
    runtime: {
      active: false,
      cwdKey: 'd:\\project',
      exists: true,
      ptyGeneration: 7,
    },
    workspacePtyGeneration: 7,
  }) as unknown as ClaudeLaunchDecisionBaseline;

const launchDecisionDescriptor = (sessionId = 'session-1'): ClaudeLaunchDescriptor => ({
  cwd: 'D:\\Project',
  input: {
    compactFirst: true,
    model: 'claude-opus-5',
    permissionMode: 'plan',
    speed: 'fast',
  },
  kind: 'relaunch',
  sessionId,
});

const launchDecisionBlockedCapture = () =>
  ({
    action: 'cli-launch',
    canonicalCwd: 'D:\\Project',
    configurationRevision: 'route-revision',
    generation: 4,
    mainRunId: 9,
    networkScope: 'application',
    provider: 'anthropic-claude',
    target: { process: 'application', url: 'https://api.anthropic.com/v1/messages' },
  }) as never;

const launchDecisionDiagnostics = () => ({
  action: 'cli-launch' as const,
  checkedAt: 100,
  failedItems: [
    {
      checkedAt: 100,
      detail: 'TLS 证书校验失败。',
      kind: 'tls' as const,
      label: 'TLS handshake',
      process: 'application' as const,
      required: true,
      status: 'failed' as const,
      target: 'https://api.anthropic.com/v1/messages',
    },
  ],
  freshness: 'fresh' as const,
  provider: 'anthropic-claude' as const,
  providerLabel: 'Anthropic Claude Code',
  reasons: ['连接被阻止'],
  scope: 'application' as const,
  status: 'blocked' as const,
  summary: '网络检查未通过，Claude 启动已暂停。',
});

const launchPreflightResult = (
  status: 'allowed' | 'allowed_with_notice' | 'blocked' = 'blocked',
  mainRunId = 9,
  probeDetail = 'https://secret.invalid D:\\Project',
): NetworkPreflightResult => {
  const allowed = status === 'allowed' || status === 'allowed_with_notice';
  const probes = [
    {
      checkedAt: 100,
      detail: probeDetail,
      id: 'tls',
      kind: 'tls' as const,
      label: 'TLS handshake https://secret.invalid',
      process: 'application' as const,
      required: true,
      status: allowed ? ('passed' as const) : ('failed' as const),
      target: 'https://user:password@api.anthropic.com/v1/messages?token=secret-query#fragment',
    },
  ];
  const providerSignals = allowed
    ? []
    : [
        {
          confidence: 'high' as const,
          detail: 'private endpoint and route data',
          id: 'route-blocked',
          label: 'Route blocked',
          observedAt: 100,
          score: 90,
          severity: 'critical' as const,
          source: 'application',
        },
      ];
  const providerConnectivity = {
    featureAccess: [
      {
        action: 'cli-launch' as const,
        allowed,
        ...(allowed ? {} : { reason: 'blocked' }),
      },
    ],
    probes,
    reasons: allowed ? [] : ['raw route unavailable'],
    signals: providerSignals,
    status,
    summary: allowed ? 'allowed' : 'raw blocked summary',
  };
  const advisoryEvidence = {
    paths: [],
    reasons: [],
    riskLevel: 'low' as const,
    riskScore: 0,
    signals: [],
    summary: 'advisory evidence',
  };
  return {
    action: 'cli-launch',
    advisoryEvidence,
    cacheExpiresAt: Number.MAX_SAFE_INTEGER,
    canonicalCwd: 'D:\\Project',
    checkedAt: 100,
    configurationRevision: 'route-revision',
    featureAccess: providerConnectivity.featureAccess,
    generation: 4,
    mainRunId,
    networkScope: 'application',
    paths: advisoryEvidence.paths,
    probes: providerConnectivity.probes,
    provider: 'anthropic-claude',
    providerConnectivity,
    providerLabel: 'Anthropic Claude Code',
    reasons: providerConnectivity.reasons,
    riskLevel: advisoryEvidence.riskLevel,
    riskScore: advisoryEvidence.riskScore,
    schemaVersion: 2,
    signals: providerConnectivity.signals,
    startedAt: 90,
    status: providerConnectivity.status,
    summary: providerConnectivity.summary,
  };
};

const registerLaunchPreflightHarness = async () => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
  const { registerClaudeLaunchIpc } = await import('../../src/main/ipc/claude-launch');
  const { ProviderAccessBlockedError } =
    await import('../../src/main/network/provider-access-guard');
  const operations = new SessionOperationCoordinator(() => true);
  let nextDecision = 0;
  const launchPreflightDecisions = new LaunchPreflightDecisionCoordinator({
    randomId: () => `${String(++nextDecision).padStart(32, '0')}-launch-decision`,
  });
  const blockedResult = launchPreflightResult('blocked');
  const blockedError = new ProviderAccessBlockedError(blockedResult);
  const launchAuthorization = {
    cwdKey: 'd:\\project',
    launchSnapshot: {
      environment: { ANTHROPIC_API_KEY: 'decrypted-secret-must-not-be-retained' },
    },
    officialNetworkProvider: 'anthropic-claude',
  };
  const launchConfigurationBaseline = {
    cwdKey: 'd:\\project',
    officialNetworkProvider: 'anthropic-claude',
    revision: 'configuration-baseline',
  };
  const runtimeLaunchBaseline = {
    active: false,
    cwdKey: 'd:\\project',
    exists: true,
    ptyGeneration: 7,
  };
  const runtime = {
    abortPreparedLaunch: vi.fn(() => true),
    assertLaunchAuthorizationCurrent: vi.fn(),
    assertLaunchConfigurationBaselineCurrent: vi.fn(),
    assertRuntimeLaunchBaselineCurrent: vi.fn(),
    captureLaunchAuthorization: vi.fn(() => launchAuthorization),
    captureLaunchConfigurationBaseline: vi.fn(() => launchConfigurationBaseline),
    captureRuntimeLaunchBaseline: vi.fn(() => runtimeLaunchBaseline),
    cleanupPreparedLaunch: vi.fn(() => true),
    compactBeforeRelaunch: vi.fn(
      async (
        _sessionId: string,
        _cwd: string,
        _compactFirst: boolean,
        assertCurrent: () => void,
      ) => {
        assertCurrent();
      },
    ),
    getState: vi.fn(async () => projectState),
    isActive: vi.fn(() => false),
    officialNetworkProviderForActivePty: vi.fn(() => undefined as NetworkProviderId | undefined),
    prepareLaunch: vi.fn(async () => ({
      command: 'claude',
      environment: {
        ANTHROPIC_API_KEY: 'decrypted-secret-must-not-be-retained',
      } as Record<string, string>,
      token: { id: 'prepared-token' },
    })),
    relaunchInputForModelOption: vi.fn((_sessionId: string, _cwd: string, input: unknown) => input),
    seedActiveLaunchPreflightEvidence: vi.fn(() => true),
    setInactive: vi.fn(() => true),
  };
  const withOfficialProviderAccess = vi.fn(
    async (
      _request: unknown,
      _operation: (result: NetworkPreflightResult) => Promise<unknown>,
      _signal?: AbortSignal,
    ): Promise<unknown> => {
      throw blockedError;
    },
  );
  const providerAccess = {
    bypass: vi.fn(
      async (
        _capture: unknown,
        beforeOperationEntry: () => void,
        operation: () => Promise<unknown>,
        _signal?: AbortSignal,
      ) => {
        beforeOperationEntry();
        return operation();
      },
    ),
    recheck: vi.fn(
      async (
        _capture: unknown,
        operation: (result: NetworkPreflightResult) => Promise<unknown>,
        _signal?: AbortSignal,
      ) => operation(launchPreflightResult('allowed_with_notice', 10)),
    ),
  };
  const workspaceSessionIds = ['session-1'];
  let workspacePtyGeneration = 7;
  const replacePty = (
    sessionId: string,
    replacement: number,
    withExpectedPtyReplacement?: (
      predecessor: number,
      restart: () => TerminalStatus,
    ) => TerminalStatus,
  ): TerminalStatus => {
    const predecessor = workspacePtyGeneration;
    const restart = (): TerminalStatus => {
      const expectedLaunchReplacement = launchPreflightDecisions.consumeExpectedPtyReplacement(
        sessionId,
        predecessor,
        replacement,
      );
      workspacePtyGeneration = replacement;
      if (!expectedLaunchReplacement) launchPreflightDecisions.invalidateSession(sessionId);
      return { phase: 'running', ptyGeneration: replacement } as TerminalStatus;
    };
    return withExpectedPtyReplacement
      ? withExpectedPtyReplacement(predecessor, restart)
      : restart();
  };
  const restartRuntimeTerminal = vi.fn(
    (
      _runtime: unknown,
      sessionId: string,
      _environment: unknown,
      _command: string,
      _failureMessage: string,
      assertCurrent: () => void,
      ownGeneration: (generation: number) => void,
      _launchToken?: object,
      withExpectedPtyReplacement?: (
        predecessor: number,
        restart: () => TerminalStatus,
      ) => TerminalStatus,
    ) => {
      const terminalStatus = replacePty(sessionId, 8, withExpectedPtyReplacement);
      ownGeneration(terminalStatus.ptyGeneration);
      assertCurrent();
      return terminalStatus;
    },
  );
  const runClaudeResumeLaunch = vi.fn(
    async (
      sessionId: string,
      _cwd: string,
      _conversationId: string,
      _failureMessage: string,
      assertCurrent: () => void,
      _launchAuthorization?: object,
      assertPreparationCurrent?: () => void,
      signal?: AbortSignal,
      withExpectedPtyReplacement?: (
        predecessor: number,
        restart: () => TerminalStatus,
      ) => TerminalStatus,
    ) => {
      signal?.throwIfAborted();
      assertPreparationCurrent?.();
      const terminalStatus = replacePty(sessionId, 8, withExpectedPtyReplacement);
      assertCurrent();
      return terminalStatus.ptyGeneration;
    },
  );
  const stopIfGeneration = vi.fn();
  const validateSender = vi.fn();
  const launchAdmission = { allowed: true };
  const assertLaunchAdmissionAllowed = vi.fn(() => {
    if (!launchAdmission.allowed) throw new Error('应用正在退出，无法启动新的 Claude 会话。');
  });
  const claudeFailure = vi.fn((_sessionId: string, error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    ok: false,
  }));
  registerClaudeLaunchIpc({
    agentRuntimeStore: { get: vi.fn(() => 'claude') } as never,
    claudeConversationLifecycle: new ClaudeConversationLifecycleCoordinator(),
    claudeFailure: claudeFailure as never,
    conversationOwnerRegistry: new ConversationOwnerRegistry(),
    developmentSessionOperations: operations,
    failedRuntimeLaunchCleanupDependencies: {
      hasSession: vi.fn(() => true),
      stopIfGeneration,
    },
    guards: {
      assertLaunchAdmissionAllowed,
      requireClaudeRuntime: vi.fn(() => runtime),
      requireProviderAccessGuard: vi.fn(() => providerAccess),
      validateSender,
      withOfficialProviderAccess,
    } as never,
    launchPreflightDecisions,
    releaseTerminalConversationOwner: vi.fn(),
    restartRuntimeTerminal: restartRuntimeTerminal as unknown as RestartRuntimeTerminal,
    runClaudeProjectConfigTransaction: vi.fn() as never,
    runClaudeResumeLaunch: runClaudeResumeLaunch as never,
    terminalConversationOwners: new Map(),
    withDevelopmentSessionOperation: (sessionId, operation) => operations.run(sessionId, operation),
    withDevelopmentSessionOperationIfStampCurrent: (stamp, operation) =>
      operations.runIfStampCurrent(stamp, operation),
    withLaunchDecisionSessionOperation: (sessionId, operation) =>
      operations.run(sessionId, operation),
    workspace: {
      getDevelopmentRuntime: vi.fn(() => 'claude'),
      getStatus: vi.fn(() => ({
        cwd: 'D:\\Project',
        id: 'session-1',
        ptyGeneration: workspacePtyGeneration,
      })),
    } as never,
  });
  return {
    assertLaunchAdmissionAllowed,
    blockedError,
    blockedResult,
    claudeFailure,
    ipc,
    launchAdmission,
    launchAuthorization,
    launchConfigurationBaseline,
    launchPreflightDecisions,
    providerAccess,
    replacePty,
    restartRuntimeTerminal,
    runClaudeResumeLaunch,
    runtime,
    stopIfGeneration,
    validateSender,
    withOfficialProviderAccess,
    workspaceSessionIds,
  };
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
  vi.useRealTimers();
});

describe('main-process session operation ownership', () => {
  it('gives launch decisions exact pending, deciding, consumed, replacement, and superseded semantics', () => {
    let nextId = 0;
    const coordinator = new LaunchPreflightDecisionCoordinator({
      randomId: () => `decision-${++nextId}`,
    });
    const intent = coordinator.beginLaunch('session-1');
    const first = coordinator.pause(
      intent,
      launchDecisionDescriptor(),
      launchDecisionBlockedCapture(),
      launchDecisionDiagnostics(),
      launchDecisionBaseline(),
    );

    const recheck = coordinator.reserve(first.decisionId, 'recheck');
    expect(recheck.status).toBe('reserved');
    if (recheck.status !== 'reserved') throw new Error('Expected a reserved launch decision.');
    expect(coordinator.reserve(first.decisionId, 'recheck')).toEqual({ status: 'consumed' });
    coordinator.consume(recheck.reservation);
    expect(coordinator.reserve(first.decisionId, 'bypass')).toEqual({ status: 'consumed' });

    const replacement = coordinator.pauseAfterRecheck(
      recheck.reservation,
      launchDecisionBlockedCapture(),
      launchDecisionDiagnostics(),
      launchDecisionBaseline(),
    );
    expect(replacement.decisionId).not.toBe(first.decisionId);
    expect(coordinator.hasPending('session-1')).toBe(true);

    coordinator.beginLaunch('session-1');
    expect(coordinator.reserve(replacement.decisionId, 'bypass')).toEqual({ status: 'stale' });
    expect(coordinator.hasPending('session-1')).toBe(false);
  });

  it('consumes only one exact synchronous launch-owned PTY replacement', () => {
    const coordinator = new LaunchPreflightDecisionCoordinator();
    const intent = coordinator.beginLaunch('session-1');

    const status = coordinator.withExpectedPtyReplacement(intent, 7, () => {
      expect(coordinator.consumeExpectedPtyReplacement('session-1', 7, 8)).toBe(true);
      return { phase: 'running', ptyGeneration: 8 } as TerminalStatus;
    });

    expect(status.ptyGeneration).toBe(8);
    expect(() => coordinator.assertIntentCurrent(intent)).not.toThrow();
    expect(coordinator.consumeExpectedPtyReplacement('session-1', 7, 8)).toBe(false);

    coordinator.invalidateSession('session-1');
    expect(() => coordinator.assertIntentCurrent(intent)).toThrow('这次 Claude 启动授权已失效。');
  });

  it('stales mismatched, repeated, and out-of-scope PTY replacements', () => {
    const coordinator = new LaunchPreflightDecisionCoordinator();
    expect(coordinator.consumeExpectedPtyReplacement('session-1', 7, 8)).toBe(false);

    const mismatchedIntent = coordinator.beginLaunch('session-1');
    coordinator.withExpectedPtyReplacement(mismatchedIntent, 7, () => {
      expect(coordinator.consumeExpectedPtyReplacement('session-1', 6, 8)).toBe(false);
      coordinator.invalidateSession('session-1');
      return { phase: 'running', ptyGeneration: 8 } as TerminalStatus;
    });
    expect(() => coordinator.assertIntentCurrent(mismatchedIntent)).toThrow(
      '这次 Claude 启动授权已失效。',
    );

    const repeatedIntent = coordinator.beginLaunch('session-1');
    coordinator.withExpectedPtyReplacement(repeatedIntent, 8, () => {
      expect(coordinator.consumeExpectedPtyReplacement('session-1', 8, 9)).toBe(true);
      expect(coordinator.consumeExpectedPtyReplacement('session-1', 9, 10)).toBe(false);
      coordinator.invalidateSession('session-1');
      return { phase: 'running', ptyGeneration: 9 } as TerminalStatus;
    });
    expect(() => coordinator.assertIntentCurrent(repeatedIntent)).toThrow(
      '这次 Claude 启动授权已失效。',
    );
  });

  it('clears expected PTY replacement scopes on throw, supersede, and global invalidation', () => {
    const coordinator = new LaunchPreflightDecisionCoordinator();
    const expectedReplacements = () =>
      (
        coordinator as unknown as {
          expectedPtyReplacementBySession: Map<string, unknown>;
        }
      ).expectedPtyReplacementBySession;

    const throwingIntent = coordinator.beginLaunch('session-1');
    expect(() =>
      coordinator.withExpectedPtyReplacement(throwingIntent, 7, () => {
        throw new Error('restart failed');
      }),
    ).toThrow('restart failed');
    expect(expectedReplacements().size).toBe(0);
    expect(() => coordinator.assertIntentCurrent(throwingIntent)).toThrow(
      '这次 Claude 启动授权已失效。',
    );

    const supersededIntent = coordinator.beginLaunch('session-1');
    let replacementIntent!: ReturnType<LaunchPreflightDecisionCoordinator['beginLaunch']>;
    coordinator.withExpectedPtyReplacement(supersededIntent, 7, () => {
      replacementIntent = coordinator.beginLaunch('session-1');
      return { phase: 'running', ptyGeneration: 8 } as TerminalStatus;
    });
    expect(expectedReplacements().size).toBe(0);
    expect(() => coordinator.assertIntentCurrent(supersededIntent)).toThrow(
      '这次 Claude 启动授权已失效。',
    );
    expect(() => coordinator.assertIntentCurrent(replacementIntent)).not.toThrow();

    coordinator.withExpectedPtyReplacement(replacementIntent, 8, () => {
      coordinator.invalidateAll();
      return { phase: 'running', ptyGeneration: 9 } as TerminalStatus;
    });
    expect(expectedReplacements().size).toBe(0);
    expect(() => coordinator.assertIntentCurrent(replacementIntent)).toThrow(
      '这次 Claude 启动授权已失效。',
    );
  });

  it('deep-captures immutable decision data and drops it from terminal tombstones on expiry', () => {
    let now = 1_000;
    let expire!: () => void;
    const unref = vi.fn();
    const coordinator = new LaunchPreflightDecisionCoordinator({
      now: () => now,
      randomId: () => 'decision-immutable',
      setTimer: (callback, delay) => {
        expire = callback;
        expect(delay).toBe(LAUNCH_PREFLIGHT_DECISION_TTL_MS);
        return { unref } as unknown as NodeJS.Timeout;
      },
    });
    const descriptor = launchDecisionDescriptor();
    const blocked = {
      action: 'cli-launch',
      canonicalCwd: 'D:\\Project',
      configurationRevision: 'route-revision',
      generation: 4,
      mainRunId: 9,
      networkScope: 'application',
      provider: 'anthropic-claude',
      target: { process: 'application', url: 'https://api.anthropic.com/v1/messages' },
    };
    const diagnostics = launchDecisionDiagnostics();
    const baseline = launchDecisionBaseline();
    const intent = coordinator.beginLaunch('session-1');
    const paused = coordinator.pause(intent, descriptor, blocked as never, diagnostics, baseline);

    if (descriptor.kind !== 'relaunch') throw new Error('Expected a relaunch descriptor.');
    (descriptor.input as { compactFirst: boolean }).compactFirst = false;
    blocked.target.url = 'https://mutated.invalid';
    diagnostics.failedItems[0]!.label = 'mutated';
    (baseline.configuration as { revision: string }).revision = 'mutated';

    const reserved = coordinator.reserve(paused.decisionId, 'bypass');
    expect(reserved.status).toBe('reserved');
    if (reserved.status !== 'reserved') throw new Error('Expected a reserved launch decision.');
    expect(reserved.reservation.descriptor).toMatchObject({
      input: {
        compactFirst: true,
        model: 'claude-opus-5',
        speed: 'fast',
      },
    });
    expect(reserved.reservation.blocked.target).toEqual({
      process: 'application',
      url: 'https://api.anthropic.com/v1/messages',
    });
    expect(reserved.reservation.diagnostics.failedItems[0]?.label).toBe('TLS handshake');
    expect(reserved.reservation.baseline.configuration.revision).toBe('config-revision');
    expect(Object.isFrozen(reserved.reservation)).toBe(true);
    expect(Object.isFrozen(reserved.reservation.descriptor)).toBe(true);
    expect(Object.isFrozen(reserved.reservation.blocked.target)).toBe(true);
    expect(Object.isFrozen(reserved.reservation.diagnostics.failedItems)).toBe(true);
    expect(unref).toHaveBeenCalled();

    now += LAUNCH_PREFLIGHT_DECISION_TTL_MS;
    expire();
    expect(coordinator.reserve(paused.decisionId, 'bypass')).toEqual({ status: 'stale' });
    const records = (
      coordinator as unknown as {
        records: Map<string, Record<string, unknown>>;
      }
    ).records;
    expect(records.get(paused.decisionId)).toEqual({
      decisionId: paused.decisionId,
      finishedAt: now,
      sessionId: 'session-1',
      state: 'stale',
    });
  });

  it('bounds pending decisions and terminal replay tombstones', () => {
    let nextId = 0;
    const coordinator = new LaunchPreflightDecisionCoordinator({
      maxPending: 2,
      maxRecords: 3,
      randomId: () => `decision-${++nextId}`,
    });
    const decisionIds: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
      const sessionId = `session-${index}`;
      const intent = coordinator.beginLaunch(sessionId);
      const paused = coordinator.pause(
        intent,
        launchDecisionDescriptor(sessionId),
        launchDecisionBlockedCapture(),
        launchDecisionDiagnostics(),
        launchDecisionBaseline(sessionId),
      );
      decisionIds.push(paused.decisionId);
      if (index % 2 === 0) {
        const reserved = coordinator.reserve(paused.decisionId, 'cancel');
        if (reserved.status === 'reserved') coordinator.consume(reserved.reservation);
      }
    }

    const records = (
      coordinator as unknown as {
        records: Map<string, { state: string }>;
      }
    ).records;
    expect(records.size).toBeLessThanOrEqual(3);
    expect(
      [...records.values()].filter(({ state }) => state === 'pending' || state === 'deciding'),
    ).toHaveLength(1);
    expect(coordinator.reserve(decisionIds[0]!, 'bypass').status).toMatch(/stale|consumed/u);
  });

  it.each([
    {
      detail: '连接失败：spawn D:\\Project ENOENT',
      expected: '连接失败：spawn [REDACTED_PATH] ENOENT',
      name: 'drive-root path',
    },
    {
      detail: 'EACCES opening C:/workspace/private/config.json',
      expected: 'EACCES opening [REDACTED_PATH]',
      name: 'forward-slash drive path',
    },
    {
      detail: 'connect \\\\fileserver\\private-share\\project ECONNREFUSED',
      expected: 'connect [REDACTED_PATH] ECONNREFUSED',
      name: 'UNC path',
    },
    {
      detail: 'ENOENT opening "D:\\Project Folder\\config.json"',
      expected: 'ENOENT opening "[REDACTED_PATH]"',
      name: 'quoted path with spaces',
    },
    {
      detail: "EACCES at '\\\\?\\UNC\\fileserver\\private-share\\Project Folder\\config.json'",
      expected: "EACCES at '[REDACTED_PATH]'",
      name: 'extended UNC path',
    },
    {
      detail: 'pipe unavailable at \\\\.\\pipe\\private-agent EBUSY',
      expected: 'pipe unavailable at [REDACTED_PATH] EBUSY',
      name: 'Windows device path',
    },
  ])('redacts a $name while preserving its diagnostic classification', ({ detail, expected }) => {
    const diagnostics = launchPauseDiagnosticsFromResult(
      launchPreflightResult('blocked', 9, detail),
    );

    expect(diagnostics.failedItems[0]?.detail).toBe(expected);
  });

  it('pauses before preparation with attributed decision evidence but no private route authority', async () => {
    const harness = await registerLaunchPreflightHarness();

    const outcome = await harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new');
    if (outcome.status !== 'paused') throw new Error('Expected launch to pause.');

    expect(outcome).toMatchObject({
      diagnostics: {
        action: 'cli-launch',
        checkedAt: 100,
        failedItems: [
          {
            checkedAt: 100,
            detail: '网络目标 [REDACTED_PATH]',
            kind: 'tls',
            process: 'application',
            required: true,
            status: 'failed',
            target: 'https://api.anthropic.com/v1/messages',
          },
        ],
        freshness: 'fresh',
        provider: 'anthropic-claude',
        providerLabel: 'Anthropic Claude Code',
        scope: 'application',
        status: 'blocked',
        summary: '网络检查未通过，Claude 启动已暂停。',
      },
      status: 'paused',
    });
    expect(outcome.decisionId).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
    expect(harness.withOfficialProviderAccess).toHaveBeenCalledWith(
      {
        action: 'cli-launch',
        cwd: 'D:\\Project',
        provider: 'anthropic-claude',
      },
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(harness.runtime.prepareLaunch).not.toHaveBeenCalled();
    expect(harness.restartRuntimeTerminal).not.toHaveBeenCalled();
    expect(harness.stopIfGeneration).not.toHaveBeenCalled();
    expect(harness.runtime.cleanupPreparedLaunch).not.toHaveBeenCalled();
    expect(harness.runtime.setInactive).not.toHaveBeenCalled();
    expect(harness.launchPreflightDecisions.hasPending('session-1')).toBe(true);

    const rendererPayload = JSON.stringify(outcome);
    expect(rendererPayload).toContain('anthropic-claude');
    expect(rendererPayload).toContain('api.anthropic.com');
    expect(rendererPayload).not.toContain(JSON.stringify('D:\\Project').slice(1, -1));
    for (const forbidden of [
      'route-revision',
      'mainRunId',
      'generation',
      'decrypted-secret-must-not-be-retained',
      'secret.invalid',
      'secret-query',
      'password@',
    ]) {
      expect(rendererPayload).not.toContain(forbidden);
    }
    const records = (
      harness.launchPreflightDecisions as unknown as {
        records: Map<string, unknown>;
      }
    ).records;
    expect(JSON.stringify([...records.values()])).not.toContain(
      'decrypted-secret-must-not-be-retained',
    );
  });

  it.each(['new', 'continue', 'resume'] as const)(
    'keeps an allowed %s launch current across its synchronous PTY replacement',
    async (mode) => {
      const harness = await registerLaunchPreflightHarness();
      const sessionsBefore = [...harness.workspaceSessionIds];
      harness.withOfficialProviderAccess.mockImplementationOnce(async (_request, operation) =>
        operation(launchPreflightResult('allowed', 12)),
      );

      await expect(
        harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', mode),
      ).resolves.toMatchObject({ result: { ok: true }, status: 'completed' });

      expect(harness.restartRuntimeTerminal).toHaveBeenCalledOnce();
      expect(harness.stopIfGeneration).not.toHaveBeenCalled();
      expect(harness.runtime.abortPreparedLaunch).not.toHaveBeenCalled();
      expect(harness.workspaceSessionIds).toEqual(sessionsBefore);
    },
  );

  it('cleans only the owned PTY generation and exact token after a second replacement stales launch', async () => {
    const harness = await registerLaunchPreflightHarness();
    harness.withOfficialProviderAccess.mockImplementationOnce(async (_request, operation) =>
      operation(launchPreflightResult('allowed', 12)),
    );
    harness.restartRuntimeTerminal.mockImplementationOnce(
      (
        _runtime,
        sessionId,
        _environment,
        _command,
        _failureMessage,
        assertCurrent,
        ownGeneration,
        _launchToken,
        withExpectedPtyReplacement,
      ) => {
        const terminalStatus = harness.replacePty(sessionId, 8, withExpectedPtyReplacement);
        ownGeneration(terminalStatus.ptyGeneration);
        harness.replacePty(sessionId, 9);
        assertCurrent();
        return terminalStatus;
      },
    );

    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new'),
    ).resolves.toMatchObject({ result: { ok: false }, status: 'completed' });

    expect(harness.stopIfGeneration).toHaveBeenCalledOnce();
    expect(harness.stopIfGeneration).toHaveBeenCalledWith('session-1', 8);
    expect(harness.runtime.abortPreparedLaunch).toHaveBeenCalledOnce();
    expect(harness.runtime.abortPreparedLaunch).toHaveBeenCalledWith({ id: 'prepared-token' }, 8);
  });

  it('keeps an exact UUID resume current across its synchronous PTY replacement', async () => {
    const harness = await registerLaunchPreflightHarness();
    const conversationId = '12345678-1234-4234-8234-123456789abc';
    const sessionsBefore = [...harness.workspaceSessionIds];
    harness.withOfficialProviderAccess.mockImplementationOnce(async (_request, operation) =>
      operation(launchPreflightResult('allowed', 12)),
    );

    const outcome = await harness.ipc.invoke(
      CHANNELS.CLAUDE_LAUNCH_WITH_SESSION,
      'session-1',
      conversationId,
    );
    if (outcome.status !== 'completed') throw new Error('Expected the exact resume to complete.');
    if (!outcome.result.ok) throw new Error(outcome.result.error);

    expect(harness.runClaudeResumeLaunch).toHaveBeenCalledOnce();
    expect(harness.runClaudeResumeLaunch.mock.calls[0]?.[2]).toBe(conversationId);
    expect(harness.stopIfGeneration).not.toHaveBeenCalled();
    expect(harness.workspaceSessionIds).toEqual(sessionsBefore);
  });

  it('aborts an admitted terminal launch if quit cleanup starts while preparation is awaiting', async () => {
    const harness = await registerLaunchPreflightHarness();
    const preparation = deferred<{
      command: string;
      environment: Record<string, string>;
      token: { id: string };
    }>();
    harness.withOfficialProviderAccess.mockImplementationOnce(async (_request, operation) =>
      operation(launchPreflightResult('allowed', 12)),
    );
    harness.runtime.prepareLaunch.mockImplementationOnce(() => preparation.promise);

    const launch = harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new');
    await vi.waitFor(() => expect(harness.runtime.prepareLaunch).toHaveBeenCalledOnce());
    harness.launchAdmission.allowed = false;
    preparation.resolve({
      command: 'claude',
      environment: {},
      token: { id: 'late-prepared-token' },
    });

    await expect(launch).resolves.toMatchObject({
      result: { error: '应用正在退出，无法启动新的 Claude 会话。', ok: false },
      status: 'completed',
    });
    expect(harness.restartRuntimeTerminal).not.toHaveBeenCalled();
    expect(harness.runtime.abortPreparedLaunch).toHaveBeenCalledWith(
      {
        id: 'late-prepared-token',
      },
      undefined,
    );
  });

  it('consumes one-shot bypass immediately before exact launch entry and never seeds stale evidence', async () => {
    const harness = await registerLaunchPreflightHarness();
    const paused = await harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new');
    if (paused.status !== 'paused') throw new Error('Expected launch to pause.');
    harness.runtime.prepareLaunch.mockImplementationOnce(async () => {
      const records = (
        harness.launchPreflightDecisions as unknown as {
          records: Map<string, { state: string }>;
        }
      ).records;
      expect(records.get(paused.decisionId)).toEqual({
        decisionId: paused.decisionId,
        finishedAt: expect.any(Number),
        sessionId: 'session-1',
        state: 'consumed',
      });
      return {
        command: 'claude',
        environment: { ANTHROPIC_API_KEY: 'recaptured-only-inside-continuation' },
        token: { id: 'continued-token' },
      };
    });

    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'bypass',
        decisionId: paused.decisionId,
      }),
    ).resolves.toMatchObject({ result: { ok: true }, status: 'completed' });

    expect(harness.providerAccess.bypass).toHaveBeenCalledOnce();
    expect(harness.providerAccess.bypass.mock.calls[0]?.[0]).toStrictEqual(
      harness.blockedError.capture,
    );
    expect(harness.providerAccess.bypass.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
    expect(harness.runtime.prepareLaunch).toHaveBeenCalledOnce();
    expect(harness.restartRuntimeTerminal).toHaveBeenCalledOnce();
    expect(harness.runtime.seedActiveLaunchPreflightEvidence).not.toHaveBeenCalled();
    expect(harness.stopIfGeneration).not.toHaveBeenCalled();
    expect(harness.runtime.cleanupPreparedLaunch).not.toHaveBeenCalled();
    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'bypass',
        decisionId: paused.decisionId,
      }),
    ).resolves.toEqual({ status: 'consumed' });
  });

  it('rechecks inside the exact route and seeds only its exact successful launch evidence', async () => {
    const harness = await registerLaunchPreflightHarness();
    const paused = await harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new');
    if (paused.status !== 'paused') throw new Error('Expected launch to pause.');

    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'recheck',
        decisionId: paused.decisionId,
      }),
    ).resolves.toMatchObject({ result: { ok: true }, status: 'completed' });

    expect(harness.providerAccess.recheck).toHaveBeenCalledOnce();
    expect(harness.providerAccess.recheck.mock.calls[0]?.[0]).toStrictEqual(
      harness.blockedError.capture,
    );
    expect(harness.providerAccess.recheck.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(harness.runtime.seedActiveLaunchPreflightEvidence).toHaveBeenCalledWith('session-1', 8, {
      checkedAt: 100,
      provider: 'anthropic-claude',
      status: 'allowed_with_notice',
    });
    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'recheck',
        decisionId: paused.decisionId,
      }),
    ).resolves.toEqual({ status: 'consumed' });
  });

  it.each(['bypass', 'recheck'] as const)(
    'continues a relaunch when %s applies to its blocked live-provider compaction route',
    async (choice) => {
      const harness = await registerLaunchPreflightHarness();
      const events: string[] = [];
      const modelOptionId = `model-${'c'.repeat(16)}`;
      harness.runtime.relaunchInputForModelOption.mockImplementation(
        (_sessionId, _cwd, input: unknown) => ({
          compactFirst: (input as { compactFirst: boolean }).compactFirst,
          model: 'claude-opus-5',
          speed: 'fast',
        }),
      );
      harness.launchAuthorization.officialNetworkProvider = 'openai-codex';
      harness.launchConfigurationBaseline.officialNetworkProvider = 'openai-codex';
      harness.runtime.isActive.mockReturnValue(true);
      harness.runtime.officialNetworkProviderForActivePty.mockReturnValue('anthropic-claude');
      harness.withOfficialProviderAccess.mockImplementation(async (request, operation, signal) => {
        signal?.throwIfAborted();
        const provider = (request as { provider: NetworkProviderId }).provider;
        events.push(`guard:${provider}`);
        if (provider === 'anthropic-claude') throw harness.blockedError;
        return operation({
          ...launchPreflightResult('allowed', 12),
          provider,
          providerLabel: 'OpenAI Codex',
        } as NetworkPreflightResult);
      });

      const paused = await harness.ipc.invoke(CHANNELS.CLAUDE_RELAUNCH, 'session-1', {
        compactFirst: true,
        entryId: 'history-renderer-entry',
        model: 'renderer-model',
        modelOptionId,
        speed: 'standard',
      });
      if (paused.status !== 'paused') throw new Error('Expected relaunch to pause.');
      expect(harness.runtime.relaunchInputForModelOption).toHaveBeenCalledWith(
        'session-1',
        'D:\\Project',
        {
          compactFirst: true,
          entryId: 'history-renderer-entry',
          modelOptionId,
        },
      );
      expect(events).toEqual(['guard:openai-codex', 'guard:anthropic-claude']);
      expect(harness.runtime.compactBeforeRelaunch).not.toHaveBeenCalled();
      expect(harness.runtime.prepareLaunch).not.toHaveBeenCalled();

      if (choice === 'bypass') {
        harness.providerAccess.bypass.mockImplementationOnce(
          async (_capture, beforeOperationEntry, operation, signal) => {
            beforeOperationEntry();
            signal?.throwIfAborted();
            events.push('bypass-entry');
            return operation();
          },
        );
      } else {
        harness.providerAccess.recheck.mockImplementationOnce(
          async (_capture, operation, signal) => {
            signal?.throwIfAborted();
            events.push('recheck-entry');
            return operation(launchPreflightResult('allowed', 13));
          },
        );
      }
      harness.runtime.compactBeforeRelaunch.mockImplementationOnce(
        async (_sessionId, _cwd, _compactFirst, assertCurrent) => {
          const records = (
            harness.launchPreflightDecisions as unknown as {
              records: Map<string, { state: string }>;
            }
          ).records;
          expect(records.get(paused.decisionId)?.state).toBe('consumed');
          events.push('compact');
          assertCurrent();
        },
      );
      harness.runtime.prepareLaunch.mockImplementationOnce(async () => {
        events.push('prepare');
        return {
          command: 'claude',
          environment: {},
          token: { id: 'continued-relaunch-token' },
        };
      });
      harness.restartRuntimeTerminal.mockImplementationOnce(
        (
          _runtime,
          sessionId,
          _environment,
          _command,
          _failureMessage,
          assertCurrent,
          ownGeneration,
          _launchToken,
          withExpectedPtyReplacement,
        ) => {
          events.push('restart');
          const terminalStatus = harness.replacePty(sessionId, 8, withExpectedPtyReplacement);
          ownGeneration(terminalStatus.ptyGeneration);
          assertCurrent();
          return terminalStatus;
        },
      );

      await expect(
        harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
          choice,
          decisionId: paused.decisionId,
        }),
      ).resolves.toMatchObject({ result: { ok: true }, status: 'completed' });

      expect(harness.runtime.prepareLaunch).toHaveBeenCalledWith(
        'session-1',
        'D:\\Project',
        'continue',
        undefined,
        harness.launchAuthorization,
        { model: 'claude-opus-5', speed: 'fast' },
      );
      expect(events).toEqual([
        'guard:openai-codex',
        'guard:anthropic-claude',
        'guard:openai-codex',
        `${choice}-entry`,
        'compact',
        'prepare',
        'restart',
      ]);
      const providerDecision = harness.providerAccess[choice];
      expect(providerDecision).toHaveBeenCalledOnce();
      expect(providerDecision.mock.calls[0]?.[0]).toStrictEqual(harness.blockedError.capture);
      expect(harness.runtime.seedActiveLaunchPreflightEvidence).toHaveBeenCalledOnce();
      expect(harness.runtime.seedActiveLaunchPreflightEvidence).toHaveBeenCalledWith(
        'session-1',
        8,
        {
          checkedAt: 100,
          provider: 'openai-codex',
          status: 'allowed',
        },
      );
    },
  );

  it('permanently consumes a blocked recheck and issues one replacement decision', async () => {
    const harness = await registerLaunchPreflightHarness();
    const { ProviderAccessBlockedError } =
      await import('../../src/main/network/provider-access-guard');
    const paused = await harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new');
    if (paused.status !== 'paused') throw new Error('Expected launch to pause.');
    const repeatedBlock = new ProviderAccessBlockedError(launchPreflightResult('blocked', 11));
    harness.providerAccess.recheck.mockRejectedValueOnce(repeatedBlock);

    const replacement = await harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
      choice: 'recheck',
      decisionId: paused.decisionId,
    });
    expect(replacement).toMatchObject({ status: 'paused' });
    if (replacement.status !== 'paused') throw new Error('Expected replacement launch decision.');
    expect(replacement.decisionId).not.toBe(paused.decisionId);
    expect(harness.runtime.prepareLaunch).not.toHaveBeenCalled();
    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'bypass',
        decisionId: paused.decisionId,
      }),
    ).resolves.toEqual({ status: 'consumed' });
    expect(harness.launchPreflightDecisions.hasPending('session-1')).toBe(true);
  });

  it('cancels only the exact paused launch and validates sender before decision parsing or lookup', async () => {
    const harness = await registerLaunchPreflightHarness();
    const paused = await harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new');
    if (paused.status !== 'paused') throw new Error('Expected launch to pause.');

    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'cancel',
        decisionId: paused.decisionId,
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(harness.providerAccess.bypass).not.toHaveBeenCalled();
    expect(harness.providerAccess.recheck).not.toHaveBeenCalled();
    expect(harness.runtime.prepareLaunch).not.toHaveBeenCalled();
    expect(harness.launchPreflightDecisions.hasPending('session-1')).toBe(false);

    const reserve = vi.spyOn(harness.launchPreflightDecisions, 'reserve');
    const senderFailure = new Error('invalid top frame');
    harness.validateSender.mockImplementationOnce(() => {
      throw senderFailure;
    });
    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'renderer-authority',
        decisionId: 'short',
        provider: 'openai-codex',
      } as never),
    ).rejects.toThrow(senderFailure.message);
    expect(reserve).not.toHaveBeenCalled();

    await expect(
      harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
        choice: 'cancel',
        decisionId: `${'a'.repeat(31)} `,
      }),
    ).rejects.toThrow('Claude 启动决策标识无效。');
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each(['configuration', 'runtime'] as const)(
    'returns stale without operation entry after %s ownership drifts while paused',
    async (baselineKind) => {
      const harness = await registerLaunchPreflightHarness();
      const paused = await harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH, 'session-1', 'new');
      if (paused.status !== 'paused') throw new Error('Expected launch to pause.');
      const drift = new Error(`${baselineKind} drifted`);
      if (baselineKind === 'configuration') {
        harness.runtime.assertLaunchConfigurationBaselineCurrent.mockImplementation(() => {
          throw drift;
        });
      } else {
        harness.runtime.assertRuntimeLaunchBaselineCurrent.mockImplementation(() => {
          throw drift;
        });
      }

      await expect(
        harness.ipc.invoke(CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE, {
          choice: 'bypass',
          decisionId: paused.decisionId,
        }),
      ).resolves.toEqual({ status: 'stale' });
      expect(harness.providerAccess.bypass).not.toHaveBeenCalled();
      expect(harness.runtime.prepareLaunch).not.toHaveBeenCalled();
      expect(harness.restartRuntimeTerminal).not.toHaveBeenCalled();
    },
  );

  it('recognizes only new terminal failure edges and waits for the cancelled lease before mutation', async () => {
    expect(
      enteredTerminalFailure(
        { phase: 'running', ptyGeneration: 5 },
        { phase: 'error', ptyGeneration: 5 },
      ),
    ).toBe(true);
    expect(
      enteredTerminalFailure(
        { phase: 'error', ptyGeneration: 5 },
        { phase: 'error', ptyGeneration: 5 },
      ),
    ).toBe(false);
    expect(
      enteredTerminalFailure(
        { phase: 'error', ptyGeneration: 5 },
        { phase: 'stopped', ptyGeneration: 6 },
      ),
    ).toBe(true);

    const releaseLease = deferred<void>();
    const calls: string[] = [];
    const transition = new TerminalTransitionCoordinator({
      deactivateRuntimes: (_sessionId, generation) => {
        calls.push(`deactivate:${generation}`);
      },
      discardOutput: (_sessionId, generation) => {
        calls.push(`discard:${generation}`);
      },
      getPtyGeneration: () => 5,
      invalidateAndWait: async () => {
        calls.push('invalidate');
        await releaseLease.promise;
        calls.push('lease-unwound');
      },
      resolveProbes: (_sessionId, generation) => {
        calls.push(`resolve-probes:${generation}`);
      },
      withInvalidationSuppressed: (_sessionId, operation) => {
        calls.push('suppress-invalidation');
        return operation();
      },
    });

    const execution = transition.run('session-1', 5, () => {
      calls.push('mutate-terminal');
      return { phase: 'running', ptyGeneration: 6 } as TerminalStatus;
    });

    await vi.waitFor(() => expect(calls).toEqual(['invalidate', 'resolve-probes:5']));
    expect(calls).not.toContain('discard:5');
    expect(calls).not.toContain('deactivate:5');
    releaseLease.resolve(undefined);

    await expect(execution).resolves.toMatchObject({ ptyGeneration: 6 });
    expect(calls).toEqual([
      'invalidate',
      'resolve-probes:5',
      'lease-unwound',
      'discard:5',
      'deactivate:5',
      'suppress-invalidation',
      'mutate-terminal',
    ]);
  });

  it('waits for every captured session operation before destructive project closure', async () => {
    const coordinator = new ProjectDirectoryLifecycleCoordinator();
    const first = deferred<void>();
    const second = deferred<void>();
    const calls: string[] = [];
    const releases = new Map([
      ['session-1', first],
      ['session-2', second],
    ]);

    const closure = runOwnedProjectDirectoryClosure({
      captureSessionIds: () => ['session-1', 'session-2', 'session-1'],
      closeRuntimeSession: (sessionId) => {
        calls.push(`runtime-close:${sessionId}`);
      },
      closeWorkspaceSession: (sessionId) => {
        calls.push(`workspace-close:${sessionId}`);
      },
      commit: () => {
        calls.push('commit-forget');
      },
      coordinator,
      cwd: 'D:\\Project',
      invalidateAndWait: async (sessionId) => {
        calls.push(`invalidate:${sessionId}`);
        await releases.get(sessionId)?.promise;
        calls.push(`unwound:${sessionId}`);
      },
      isSessionInDirectory: () => true,
      kind: 'forget',
      readState: () => ({ closed: true }),
    });

    await vi.waitFor(() => expect(calls).toEqual(['invalidate:session-1', 'invalidate:session-2']));
    first.resolve(undefined);
    await vi.waitFor(() => expect(calls).toContain('unwound:session-1'));
    expect(calls.some((call) => call.startsWith('runtime-close:'))).toBe(false);
    second.resolve(undefined);

    await expect(closure).resolves.toEqual({ closed: true });
    expect(calls.indexOf('unwound:session-2')).toBeLessThan(
      calls.indexOf('runtime-close:session-1'),
    );
    expect(calls.slice(-5)).toEqual([
      'runtime-close:session-1',
      'runtime-close:session-2',
      'workspace-close:session-1',
      'workspace-close:session-2',
      'commit-forget',
    ]);
  });

  it('does not start a project-runtime transition when provider authorization is blocked', async () => {
    const cwd = 'D:\\Project';
    const releaseOperation = deferred<void>();
    const setRuntime = vi.fn();
    const stopUnusedRoutingServices = vi.fn(async () => undefined);
    const withOfficialProviderAccess = vi.fn(async () => {
      throw new Error('network blocked');
    });
    const status = {
      cwd,
      id: 'session-1',
      ptyGeneration: 7,
    } as TerminalStatus;
    const coordination = createDevelopmentSessionCoordination({
      agentRuntimeStore: {
        get: vi.fn(() => 'claude'),
        set: setRuntime,
      } as never,
      guards: {
        requireClaudeRuntime: vi.fn(() => ({
          isActive: vi.fn(() => false),
          officialNetworkProvider: vi.fn(() => 'anthropic-claude'),
          stopUnusedRoutingServices,
        })),
        requireCodexRuntime: vi.fn(() => ({ isActive: vi.fn(() => false) })),
        withOfficialProviderAccess,
      } as never,
      resolvePendingPermissionModeProbes: vi.fn(),
      services: {} as never,
      terminalOperationInvalidationSuppressions: new Set(),
      terminalOutputBatcher: {} as never,
      workspace: {
        getStatus: vi.fn(() => status),
        hasSession: vi.fn(() => true),
        sessionIdsForDirectory: vi.fn(() => ['session-1']),
      } as never,
    });
    let operationAborted = false;
    const activeOperation = coordination.developmentSessionOperations.run(
      'session-1',
      async (_assertCurrent, signal) => {
        signal.addEventListener('abort', () => {
          operationAborted = true;
        });
        await releaseOperation.promise;
      },
    );
    await vi.waitFor(() =>
      expect(coordination.developmentSessionOperations.isBusy('session-1')).toBe(true),
    );

    await expect(
      coordination.projectRuntimeSwitchOperations.switchRuntime('session-1', cwd, 'codex'),
    ).rejects.toThrow('network blocked');

    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      { action: 'provider-switch', cwd, provider: 'openai-codex' },
      expect.any(Function),
    );
    expect(operationAborted).toBe(false);
    expect(coordination.developmentSessionOperations.isBusy('session-1')).toBe(true);
    expect(stopUnusedRoutingServices).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();

    releaseOperation.resolve(undefined);
    await activeOperation;
  });

  it('keeps cleanup, currentness checks, and the runtime commit inside provider access', async () => {
    const cwd = 'D:\\Project';
    const events: string[] = [];
    let currentRuntime: DevelopmentRuntime = 'claude';
    let leaseActive = false;
    const status = {
      cwd,
      id: 'session-1',
      ptyGeneration: 7,
    } as TerminalStatus;
    const withOfficialProviderAccess = vi.fn(
      async (
        _request: { provider: string },
        operation: () => Promise<DevelopmentRuntime>,
      ): Promise<DevelopmentRuntime> => {
        events.push('lease:start');
        leaseActive = true;
        try {
          return await operation();
        } finally {
          leaseActive = false;
          events.push('lease:end');
        }
      },
    );
    const getRuntime = vi.fn(() => {
      events.push(`runtime:get:${leaseActive}`);
      return currentRuntime;
    });
    const setRuntime = vi.fn((_projectPath: string, selected: DevelopmentRuntime) => {
      events.push(`runtime:commit:${leaseActive}`);
      expect(leaseActive).toBe(true);
      currentRuntime = selected;
    });
    const isClaudeActive = vi.fn(() => {
      events.push(`claude:active:${leaseActive}`);
      expect(leaseActive).toBe(true);
      return false;
    });
    const isCodexActive = vi.fn(() => {
      events.push(`codex:active:${leaseActive}`);
      expect(leaseActive).toBe(true);
      return false;
    });
    const stopUnusedRoutingServices = vi.fn(async () => {
      events.push(`cleanup:${leaseActive}`);
      expect(leaseActive).toBe(true);
    });
    const getStatus = vi.fn(() => {
      events.push(`session:get:${leaseActive}`);
      return status;
    });
    const sessionIdsForDirectory = vi.fn(() => {
      events.push(`sessions:list:${leaseActive}`);
      return ['session-1'];
    });
    const coordination = createDevelopmentSessionCoordination({
      agentRuntimeStore: {
        get: getRuntime,
        set: setRuntime,
      } as never,
      guards: {
        requireClaudeRuntime: vi.fn(() => ({
          isActive: isClaudeActive,
          officialNetworkProvider: vi.fn(() => 'anthropic-claude'),
          stopUnusedRoutingServices,
        })),
        requireCodexRuntime: vi.fn(() => ({ isActive: isCodexActive })),
        withOfficialProviderAccess,
      } as never,
      resolvePendingPermissionModeProbes: vi.fn(),
      services: {} as never,
      terminalOperationInvalidationSuppressions: new Set(),
      terminalOutputBatcher: {} as never,
      workspace: {
        getStatus,
        hasSession: vi.fn(() => true),
        sessionIdsForDirectory,
      } as never,
    });

    await expect(
      coordination.projectRuntimeSwitchOperations.switchRuntime('session-1', cwd, 'codex'),
    ).resolves.toBe('codex');

    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      { action: 'provider-switch', cwd, provider: 'openai-codex' },
      expect.any(Function),
    );
    expect(currentRuntime).toBe('codex');
    const leaseStart = events.indexOf('lease:start');
    const leaseEnd = events.indexOf('lease:end');
    expect(leaseStart).toBeGreaterThanOrEqual(0);
    expect(leaseEnd).toBeGreaterThan(leaseStart);
    for (const event of [
      'session:get:true',
      'sessions:list:true',
      'runtime:get:true',
      'claude:active:true',
      'codex:active:true',
      'cleanup:true',
      'runtime:commit:true',
    ]) {
      expect(events.indexOf(event)).toBeGreaterThan(leaseStart);
      expect(events.indexOf(event)).toBeLessThan(leaseEnd);
    }
  });

  it('switches to a custom Claude provider without requesting official access', async () => {
    const cwd = 'D:\\Project';
    let currentRuntime: DevelopmentRuntime = 'codex';
    const status = {
      cwd,
      id: 'session-1',
      ptyGeneration: 7,
    } as TerminalStatus;
    const withOfficialProviderAccess = vi.fn();
    const setRuntime = vi.fn((_projectPath: string, selected: DevelopmentRuntime) => {
      currentRuntime = selected;
    });
    const coordination = createDevelopmentSessionCoordination({
      agentRuntimeStore: {
        get: vi.fn(() => currentRuntime),
        set: setRuntime,
      } as never,
      guards: {
        requireClaudeRuntime: vi.fn(() => ({
          isActive: vi.fn(() => false),
          officialNetworkProvider: vi.fn(() => undefined),
          stopUnusedRoutingServices: vi.fn(async () => undefined),
        })),
        requireCodexRuntime: vi.fn(() => ({ isActive: vi.fn(() => false) })),
        withOfficialProviderAccess,
      } as never,
      resolvePendingPermissionModeProbes: vi.fn(),
      services: {} as never,
      terminalOperationInvalidationSuppressions: new Set(),
      terminalOutputBatcher: {} as never,
      workspace: {
        getStatus: vi.fn(() => status),
        hasSession: vi.fn(() => true),
        sessionIdsForDirectory: vi.fn(() => ['session-1']),
      } as never,
    });

    await expect(
      coordination.projectRuntimeSwitchOperations.switchRuntime('session-1', cwd, 'claude'),
    ).resolves.toBe('claude');

    expect(withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(setRuntime).toHaveBeenCalledWith(cwd, 'claude');
    expect(currentRuntime).toBe('claude');
  });

  it('rejects a switch during tentative provider commit and retries against the restored provider', async () => {
    const cwd = 'D:\\Project';
    const releaseCompletion = deferred<void>();
    const tentativeCommitted = deferred<void>();
    const authorizedProviders: NetworkProviderId[] = [];
    let currentRuntime: DevelopmentRuntime = 'codex';
    let provider: NetworkProviderId = 'anthropic-claude';
    let transactionAborted = false;
    const status = {
      cwd,
      id: 'session-1',
      ptyGeneration: 7,
    } as TerminalStatus;
    const setRuntime = vi.fn((_projectPath: string, selected: DevelopmentRuntime) => {
      currentRuntime = selected;
    });
    const isClaudeActive = vi.fn(() => false);
    const isCodexActive = vi.fn(() => false);
    const withOfficialProviderAccess = vi.fn(
      async (
        request: { provider: NetworkProviderId },
        operation: () => Promise<DevelopmentRuntime>,
      ): Promise<DevelopmentRuntime> => {
        authorizedProviders.push(request.provider);
        return operation();
      },
    );
    const coordination = createDevelopmentSessionCoordination({
      agentRuntimeStore: {
        get: vi.fn(() => currentRuntime),
        set: setRuntime,
      } as never,
      guards: {
        requireClaudeRuntime: vi.fn(() => ({
          isActive: isClaudeActive,
          officialNetworkProvider: vi.fn(() => provider),
          stopUnusedRoutingServices: vi.fn(async () => undefined),
        })),
        requireCodexRuntime: vi.fn(() => ({ isActive: isCodexActive })),
        withOfficialProviderAccess,
      } as never,
      resolvePendingPermissionModeProbes: vi.fn(),
      services: {} as never,
      terminalOperationInvalidationSuppressions: new Set(),
      terminalOutputBatcher: {} as never,
      workspace: {
        getStatus: vi.fn(() => status),
        hasSession: vi.fn(() => true),
        sessionIdsForDirectory: vi.fn(() => ['session-1']),
      } as never,
    });

    const transaction = coordination.developmentSessionOperations.run(
      'session-1',
      (assertCurrent, signal) =>
        runOwnedConfigTransaction({
          acquireIsolation: () => coordination.acquireConfigTransactionIsolation('session-1', cwd),
          assertOperationOwnership: assertCurrent,
          commit: () => {
            provider = 'openai-codex';
            tentativeCommitted.resolve(undefined);
          },
          complete: async () => {
            signal.addEventListener(
              'abort',
              () => {
                transactionAborted = true;
              },
              { once: true },
            );
            await releaseCompletion.promise;
            throw new Error('completion failed');
          },
          coordinator: coordination.managedConfigTransactions,
          createSnapshot: () => provider,
          cwd,
          prepare: () => undefined,
          readState: async () => provider,
          restoreSnapshot: (snapshot) => {
            provider = snapshot;
          },
          sessionId: 'session-1',
        }),
    );
    const transactionOutcome = transaction.catch((error: unknown) => error);
    await tentativeCommitted.promise;
    expect(provider).toBe('openai-codex');

    expect(() =>
      coordination.projectRuntimeSwitchOperations.switchRuntime('session-1', cwd, 'claude'),
    ).toThrow('当前项目正在保存并验证接入配置，请等待操作完成。');

    expect(withOfficialProviderAccess).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();
    expect(isClaudeActive).not.toHaveBeenCalled();
    expect(isCodexActive).not.toHaveBeenCalled();
    expect(transactionAborted).toBe(false);
    expect(coordination.developmentSessionOperations.isBusy('session-1')).toBe(true);
    expect(provider).toBe('openai-codex');

    releaseCompletion.resolve(undefined);
    const transactionError = await transactionOutcome;
    expect(transactionError).toBeInstanceOf(OwnedConfigTransactionError);
    expect(transactionError).toMatchObject({ restored: true });
    expect(provider).toBe('anthropic-claude');
    expect(transactionAborted).toBe(false);

    await expect(
      coordination.projectRuntimeSwitchOperations.switchRuntime('session-1', cwd, 'claude'),
    ).resolves.toBe('claude');

    expect(authorizedProviders).toEqual(['anthropic-claude']);
    expect(setRuntime).toHaveBeenCalledOnce();
    expect(setRuntime).toHaveBeenCalledWith(cwd, 'claude');
    expect(currentRuntime).toBe('claude');
  });

  it('keeps Codex preparation and PTY replacement under one cancellable session lease', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcMain: ipc.ipcMain,
      shell: { openExternal: vi.fn(async () => undefined) },
    }));
    const { registerCodexIpc } = await import('../../src/main/ipc/codex');
    const preparation = deferred<{
      command: string;
      environment: Record<string, string>;
      predecessorPtyGeneration: number;
    }>();
    const providerAccessCalls: string[] = [];
    const withOfficialProviderAccess = vi.fn(
      async (
        request: { provider: string },
        operation: () => Promise<unknown> | unknown,
      ): Promise<unknown> => {
        providerAccessCalls.push(`lease:${request.provider}:start`);
        try {
          return await operation();
        } finally {
          providerAccessCalls.push(`lease:${request.provider}:end`);
        }
      },
    );
    const operations = new SessionOperationCoordinator(() => true);
    const restartRuntimeTerminal = vi.fn() as unknown as RestartRuntimeTerminal;
    const stopIfGeneration = vi.fn();
    const runtime = {
      cleanupPreparedLaunch: vi.fn(() => true),
      getState: vi.fn(async () => projectState),
      prepareLaunch: vi.fn(() => preparation.promise),
      setInactive: vi.fn(() => true),
    };
    registerCodexIpc({
      failedRuntimeLaunchCleanupDependencies: {
        hasSession: vi.fn(() => true),
        stopIfGeneration,
      },
      guards: {
        assertApplicationUpdatesAllowed: vi.fn(),
        assertRealRuntimeAllowed: vi.fn(),
        withOfficialProviderAccess,
        requireCodexRuntime: vi.fn(() => runtime),
        validateSender: vi.fn(),
      } as never,
      restartRuntimeTerminal,
      withDevelopmentSessionOperation: (sessionId, operation) =>
        operations.run(sessionId, operation),
      workspace: {
        getDevelopmentRuntime: vi.fn(() => 'codex'),
        getStatus: vi.fn(() => ({ cwd: 'D:\\Project', ptyGeneration: 7 })),
      } as never,
    });

    const launch = ipc.invoke(CHANNELS.CODEX_LAUNCH, 'session-1', 'new');
    await vi.waitFor(() => expect(runtime.prepareLaunch).toHaveBeenCalledOnce());
    expect(withOfficialProviderAccess).toHaveBeenCalledWith(
      { action: 'cli-launch', cwd: 'D:\\Project', provider: 'openai-codex' },
      expect.any(Function),
    );
    expect(providerAccessCalls).toEqual(['lease:openai-codex:start']);
    expect(operations.isBusy('session-1')).toBe(true);

    const invalidated = operations.invalidateAndWait('session-1');
    preparation.resolve({
      command: 'codex',
      environment: { CODEX_HOME: 'D:\\Codex' },
      predecessorPtyGeneration: 7,
    });

    await expect(launch).resolves.toMatchObject({ ok: false });
    await invalidated;
    expect(providerAccessCalls).toEqual(['lease:openai-codex:start', 'lease:openai-codex:end']);
    expect(restartRuntimeTerminal).not.toHaveBeenCalled();
    expect(stopIfGeneration).toHaveBeenCalledWith('session-1', 7);
    expect(runtime.setInactive).toHaveBeenCalledWith('session-1', 7);
    expect(runtime.cleanupPreparedLaunch).not.toHaveBeenCalled();
    expect(operations.isBusy('session-1')).toBe(false);
  });

  it('rejects stale session writes and allows only the latest project-runtime switch to commit', async () => {
    const sessionOperations = new SessionOperationCoordinator(() => true);
    const releaseStalePreparation = deferred<void>();
    const writes: string[] = [];
    const staleOperation = sessionOperations.run('session-1', async (assertCurrent) => {
      await releaseStalePreparation.promise;
      assertCurrent();
      writes.push('stale-resume-write');
    });
    sessionOperations.invalidate('session-1');
    releaseStalePreparation.resolve(undefined);
    await expect(staleOperation).rejects.toThrow('这个启动操作已被新的终端或会话操作取消。');
    expect(writes).toEqual([]);

    const releaseFirstPreparation = deferred<void>();
    const calls: string[] = [];
    let currentRuntime: 'claude' | 'codex' = 'claude';
    let prepareCount = 0;
    const session: RuntimeSwitchSessionSnapshot = {
      cwd: 'D:\\Project',
      id: 'session-1',
      ptyGeneration: 7,
    };
    const switches = new ProjectRuntimeSwitchCoordinator({
      assertSwitchAllowed: () => undefined,
      cleanupBeforeCommit: async () => {
        calls.push('cleanup');
      },
      commitRuntime: (_cwd, selected) => {
        calls.push(`commit:${selected}`);
        currentRuntime = selected;
      },
      getCurrentRuntime: () => currentRuntime,
      getSession: () => session,
      hasActiveRuntime: () => false,
      invalidateAndWait: async () => {
        calls.push('invalidate');
      },
      sessionsForDirectory: () => [session],
      withProviderAccess: async (_cwd, _selected, operation) => {
        prepareCount += 1;
        calls.push(`prepare:${prepareCount}`);
        if (prepareCount === 1) await releaseFirstPreparation.promise;
        return operation();
      },
    });

    const first = switches.switchRuntime('session-1', 'D:\\Project', 'codex');
    await vi.waitFor(() => expect(calls).toContain('prepare:1'));
    const second = switches.switchRuntime('session-1', 'd:\\project\\.', 'codex');
    releaseFirstPreparation.resolve(undefined);

    await expect(first).rejects.toThrow('这次开发引擎切换已被同一项目的更新选择取代。');
    await expect(second).resolves.toBe('codex');
    expect(calls.filter((call) => call.startsWith('commit:'))).toEqual(['commit:codex']);
    expect(calls.indexOf('prepare:2')).toBeLessThan(calls.indexOf('cleanup'));
    expect(calls.indexOf('cleanup')).toBeLessThan(calls.indexOf('commit:codex'));
    expect(currentRuntime).toBe('codex');
  });

  it('gives permanent deletion ownership above pending and future resume launches', async () => {
    const cwd = 'D:\\Project';
    const conversationId = '12345678-1234-1234-1234-123456789abc';
    const calls: string[] = [];
    const liveSessions = new Set(['session-1']);
    const releaseLeaseCleanup = deferred<void>();
    const releaseResume = deferred<void>();
    const developmentSessionOperations = new SessionOperationCoordinator((sessionId) =>
      liveSessions.has(sessionId),
    );
    const activeLease = developmentSessionOperations.run(
      'session-1',
      async (_assertCurrent, signal) => {
        calls.push('lease:start');
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              calls.push('lease:aborted');
              resolve();
            },
            { once: true },
          );
        });
        await releaseLeaseCleanup.promise;
        calls.push('lease:unwound');
      },
    );
    const lifecycle = new ClaudeConversationLifecycleCoordinator();
    const pendingResume = lifecycle.runResume(
      cwd,
      conversationId,
      'session-1',
      async (ownership) => {
        calls.push('resume:start');
        await releaseResume.promise;
        ownership.assertCurrent();
        calls.push('resume:write');
      },
    );
    const pendingResumeOutcome = pendingResume.catch((error: unknown) => error);
    const runtime = {
      closeSession: vi.fn((sessionId: string) => calls.push(`runtime-close:${sessionId}`)),
      removeConversationPreferences: vi.fn(() => calls.push('preferences:remove')),
      sessionIdsForConversation: vi.fn(() => ['session-1']),
      sessionOwnsConversation: vi.fn(() => true),
    };
    const services = new Registry();
    services.register(
      CODEX_RUNTIME,
      () =>
        ({
          closeSession: vi.fn((sessionId: string) => calls.push(`codex-close:${sessionId}`)),
        }) as never,
    );
    const deleteConversation = createDeleteClaudeConversation({
      claudeConversationLifecycle: lifecycle,
      describeWorkspace: () => ({ activeSessionId: '', projects: [], sessions: [] }),
      developmentSessionOperations,
      guards: { requireClaudeRuntime: vi.fn(() => runtime) } as never,
      services,
      sessionManager: {
        deleteSession: vi.fn(() => {
          calls.push('transcript:delete');
          return true;
        }),
      } as never,
      workspace: {
        close: vi.fn((sessionId: string) => {
          calls.push(`workspace-close:${sessionId}`);
          liveSessions.delete(sessionId);
        }),
        getStatus: vi.fn(() => ({ cwd })),
        hasSession: vi.fn((sessionId: string) => liveSessions.has(sessionId)),
      } as never,
    });

    await vi.waitFor(() => expect(calls).toEqual(['lease:start', 'resume:start']));
    const deletion = deleteConversation(cwd, conversationId);
    await vi.waitFor(() => expect(calls).toContain('lease:aborted'));
    expect(() => lifecycle.assertLaunchAllowed(cwd, 'resume', conversationId)).toThrow(
      '这个历史对话正在永久删除，请等待删除完成后再恢复。',
    );
    expect(calls).not.toContain('transcript:delete');

    releaseLeaseCleanup.resolve(undefined);
    await expect(deletion).resolves.toMatchObject({ deleted: true, ok: true });
    await activeLease;
    expect(calls.indexOf('lease:unwound')).toBeLessThan(calls.indexOf('runtime-close:session-1'));
    expect(calls.indexOf('workspace-close:session-1')).toBeLessThan(
      calls.indexOf('transcript:delete'),
    );
    expect(calls.indexOf('transcript:delete')).toBeLessThan(calls.indexOf('preferences:remove'));

    releaseResume.resolve(undefined);
    await expect(pendingResumeOutcome).resolves.toMatchObject({
      message: '这次历史对话恢复已被永久删除操作取消。',
    });
    expect(calls).not.toContain('resume:write');
    expect(() => lifecycle.assertLaunchAllowed(cwd, 'resume', conversationId)).not.toThrow();
  });

  it('cleans the exact resumed PTY generation when cancellation wins a late state read', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const { registerClaudeLaunchIpc } = await import('../../src/main/ipc/claude-launch');
    const conversationId = '12345678-1234-4234-8234-123456789abc';
    const stateRead = deferred<ClaudeProjectState>();
    const operations = new SessionOperationCoordinator(() => true);
    const ownerRegistry = new ConversationOwnerRegistry();
    const terminalConversationOwners = new Map();
    const updatePhase = vi.spyOn(ownerRegistry, 'updatePhase');
    const stopIfGeneration = vi.fn();
    const cleanupPreparedLaunch = vi.fn(() => true);
    const setInactive = vi.fn(() => true);
    const launchAuthorization = {
      cwdKey: 'd:\\project',
      launchSnapshot: {},
      officialNetworkProvider: undefined,
    };
    const runtime = {
      assertLaunchAuthorizationCurrent: vi.fn(),
      assertLaunchConfigurationBaselineCurrent: vi.fn(),
      assertRuntimeLaunchBaselineCurrent: vi.fn(),
      captureLaunchAuthorization: vi.fn(() => launchAuthorization),
      captureLaunchConfigurationBaseline: vi.fn(() => ({})),
      captureRuntimeLaunchBaseline: vi.fn(() => ({})),
      cleanupPreparedLaunch,
      getState: vi.fn(() => stateRead.promise),
      setInactive,
    };
    const runClaudeResumeLaunch = vi.fn(async () => 8);
    const releaseTerminalConversationOwner = vi.fn((sessionId: string) => {
      const owner = terminalConversationOwners.get(sessionId);
      if (!owner) return;
      ownerRegistry.release(owner, owner.ownerId, owner.generation);
      terminalConversationOwners.delete(sessionId);
    });
    const claudeFailure = vi.fn((_sessionId: string, error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    }));
    registerClaudeLaunchIpc({
      agentRuntimeStore: { get: vi.fn(() => 'claude') } as never,
      claudeConversationLifecycle: new ClaudeConversationLifecycleCoordinator(),
      claudeFailure: claudeFailure as never,
      conversationOwnerRegistry: ownerRegistry,
      developmentSessionOperations: operations,
      failedRuntimeLaunchCleanupDependencies: {
        hasSession: vi.fn(() => true),
        stopIfGeneration,
      },
      guards: {
        assertLaunchAdmissionAllowed: vi.fn(),
        requireClaudeRuntime: vi.fn(() => runtime),
        validateSender: vi.fn(),
        withOfficialProviderAccess: vi.fn(async (_request, operation) => operation()),
      } as never,
      launchPreflightDecisions: new LaunchPreflightDecisionCoordinator(),
      releaseTerminalConversationOwner,
      restartRuntimeTerminal: vi.fn() as unknown as RestartRuntimeTerminal,
      runClaudeProjectConfigTransaction: vi.fn() as never,
      runClaudeResumeLaunch,
      terminalConversationOwners,
      withDevelopmentSessionOperation: (sessionId, operation) =>
        operations.run(sessionId, operation),
      withDevelopmentSessionOperationIfStampCurrent: (stamp, operation) =>
        operations.runIfStampCurrent(stamp, operation),
      withLaunchDecisionSessionOperation: (sessionId, operation) =>
        operations.run(sessionId, operation),
      workspace: {
        getDevelopmentRuntime: vi.fn(() => 'claude'),
        getStatus: vi.fn(() => ({ cwd: 'D:\\Project', ptyGeneration: 7 })),
      } as never,
    });

    const launch = ipc.invoke(CHANNELS.CLAUDE_LAUNCH_WITH_SESSION, 'session-1', conversationId);
    await vi.waitFor(() => expect(runtime.getState).toHaveBeenCalledOnce());
    const invalidated = operations.invalidateAndWait('session-1');
    stateRead.resolve(projectState);

    await expect(launch).resolves.toMatchObject({ result: { ok: false }, status: 'completed' });
    await invalidated;
    expect(runClaudeResumeLaunch).toHaveBeenCalledOnce();
    expect(stopIfGeneration).toHaveBeenCalledTimes(1);
    expect(stopIfGeneration).toHaveBeenCalledWith('session-1', 8);
    expect(setInactive).toHaveBeenCalledTimes(1);
    expect(setInactive).toHaveBeenCalledWith('session-1', 8);
    expect(cleanupPreparedLaunch).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    expect(releaseTerminalConversationOwner).not.toHaveBeenCalled();
    expect(
      ownerRegistry.ownerFor({ conversationId, projectPath: 'D:\\Project', runtime: 'claude' }),
    ).toBeUndefined();
    expect(operations.isBusy('session-1')).toBe(false);
  });

  it('rejects a model-speed success completed after its session lease is cancelled', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const { registerClaudeControlsIpc } = await import('../../src/main/ipc/claude-controls');
    const preferenceCommit = deferred<ClaudeProjectState>();
    const operations = new SessionOperationCoordinator(() => true);
    const stopIfGeneration = vi.fn();
    const cleanupPreparedLaunch = vi.fn(() => true);
    const setInactive = vi.fn(() => true);
    const launchToken = {};
    const abortPreparedLaunch = vi.fn(() => true);
    const launchAuthorization = {
      cwdKey: 'd:\\project',
      launchSnapshot: {},
      officialNetworkProvider: undefined,
    };
    const runtime = {
      abortPreparedLaunch,
      assertLaunchAuthorizationCurrent: vi.fn(),
      captureLaunchAuthorization: vi.fn(() => launchAuthorization),
      cleanupPreparedLaunch,
      commitModelSpeedPreference: vi.fn(() => preferenceCommit.promise),
      isActive: vi.fn(() => true),
      prepareModelSpeedRelaunch: vi.fn(async () => ({
        command: 'claude --resume conversation',
        environment: { CLAUDE_SPEED: 'fast' },
        predecessorPtyGeneration: 7,
        preference: 'fast',
        targetKey: 'target-model',
        token: launchToken,
      })),
      setInactive,
    };
    const claudeFailure = vi.fn((_sessionId: string, error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    }));
    const restartRuntimeTerminal: RestartRuntimeTerminal = (
      _runtime,
      _sessionId,
      _environment,
      _command,
      _failureMessage,
      _assertCurrent,
      ownGeneration,
    ) => {
      ownGeneration(8);
      return { phase: 'running', ptyGeneration: 8 } as TerminalStatus;
    };
    registerClaudeControlsIpc({
      claudeFailure: claudeFailure as never,
      failedRuntimeLaunchCleanupDependencies: {
        hasSession: vi.fn(() => true),
        stopIfGeneration,
      },
      guards: {
        assertLaunchAdmissionAllowed: vi.fn(),
        requireClaudeRuntime: vi.fn(() => runtime),
        validateSender: vi.fn(),
        withOfficialProviderAccess: vi.fn(async (_request, operation) => operation()),
      } as never,
      pendingPermissionModeProbes: new Map(),
      restartRuntimeTerminal,
      services: new Registry(),
      withDevelopmentSessionOperation: (sessionId, operation) =>
        operations.run(sessionId, operation),
      workspace: {
        getStatus: vi.fn(() => ({ cwd: 'D:\\Project', ptyGeneration: 7 })),
      } as never,
    });

    const relaunch = ipc.invoke(CHANNELS.CLAUDE_SET_MODEL_SPEED, 'session-1', 'fast');
    await vi.waitFor(() => expect(runtime.commitModelSpeedPreference).toHaveBeenCalledOnce());
    const invalidated = operations.invalidateAndWait('session-1');
    preferenceCommit.resolve(projectState);

    await expect(relaunch).resolves.toMatchObject({ ok: false });
    await invalidated;
    expect(claudeFailure).toHaveBeenCalledOnce();
    expect(stopIfGeneration).toHaveBeenCalledWith('session-1', 8);
    expect(abortPreparedLaunch).toHaveBeenCalledWith(launchToken, 8);
    expect(setInactive).not.toHaveBeenCalled();
    expect(cleanupPreparedLaunch).not.toHaveBeenCalled();
    expect(operations.isBusy('session-1')).toBe(false);
  });

  it('threads lease ownership into model commands and blocks a late submit after cancellation', async () => {
    const runtime = Object.create(ClaudeRuntime.prototype) as ClaudeRuntime;
    const runtimeSession = { sessionId: 'session-1' };
    const assertCurrent = vi.fn();
    const submitClaudeCommand = vi.fn(async () => undefined);
    const switchInternals = runtime as unknown as {
      assertRuntimePty: () => void;
      captureConversationPreferences: () => void;
      configStore: {
        getConfig: () => {
          apiKeyHelperPolicy: 'inherit' | 'prefer-claudedock';
          authMode: 'apiKey' | 'authToken' | 'existing' | 'none';
          baseUrl: string;
          model: string;
          modelFast?: string;
          preset: 'anthropic';
          provider: 'anthropic';
        };
        getCredential: () => string | undefined;
      };
      diagnoseInstallation: () => Promise<{ version: string }>;
      ensureSession: () => typeof runtimeSession;
      modelOptionRegistry: Map<
        string,
        {
          configFingerprint: string;
          configScope: string;
          cwdKey: string;
          expiresAt: number;
          launchGeneration: number;
          option: { id: string; model: string; requiresRelaunch: boolean };
          sessionId: string;
        }
      >;
      sessions: Map<string, typeof runtimeSession>;
      getModelOptions: () => Promise<{
        options: Array<{
          id: string;
          model: string;
          requiresRelaunch: boolean;
        }>;
      }>;
      getState: () => Promise<ClaudeProjectState>;
      onState: () => void;
      requireBoundPty: () => number;
      resolveModelSpeed: () => {
        preference: string;
        signature: string;
        targetKey: string;
      };
      submitClaudeCommand: typeof submitClaudeCommand;
    };
    switchInternals.ensureSession = vi.fn(() => runtimeSession);
    switchInternals.requireBoundPty = vi.fn(() => 9);
    switchInternals.assertRuntimePty = vi.fn();
    switchInternals.diagnoseInstallation = vi.fn(async () => ({ version: '2.1.221' }));
    const switchConfig = {
      apiKeyHelperPolicy: 'prefer-claudedock' as const,
      authMode: 'existing' as const,
      baseUrl: '',
      model: 'old-model',
      preset: 'anthropic' as const,
      provider: 'anthropic' as const,
    };
    switchInternals.configStore = {
      getConfig: () => switchConfig,
      getCredential: () => undefined,
    };
    switchInternals.sessions = new Map([['session-1', runtimeSession]]);
    switchInternals.modelOptionRegistry = new Map([
      [
        'current',
        {
          configFingerprint: connectionFingerprint(switchConfig),
          configScope: 'D:\\Project',
          cwdKey: projectKey('D:\\Project'),
          expiresAt: Date.now() + 120_000,
          launchGeneration: 0,
          option: { id: 'current', model: 'target-model', requiresRelaunch: false },
          sessionId: 'session-1',
        },
      ],
    ]);
    switchInternals.resolveModelSpeed = vi.fn(() => ({
      preference: 'standard',
      signature: 'standard',
      targetKey: 'target-model',
    }));
    switchInternals.submitClaudeCommand = submitClaudeCommand;
    switchInternals.captureConversationPreferences = vi.fn();
    switchInternals.getState = vi.fn(async () => projectState);
    switchInternals.onState = vi.fn();

    await expect(
      runtime.switchModel('session-1', 'D:\\Project', 'current', assertCurrent),
    ).resolves.toBe(projectState);
    expect(submitClaudeCommand).toHaveBeenCalledWith(
      runtimeSession,
      '/model target-model',
      assertCurrent,
    );

    const queuedRuntime = Object.create(ClaudeRuntime.prototype) as ClaudeRuntime;
    const writes: string[] = [];
    let ownershipCurrent = true;
    const queuedInternals = queuedRuntime as unknown as {
      commandSubmissionQueues: Map<string, Promise<void>>;
      isRuntimePtyCurrent: () => boolean;
      requireBoundPty: () => number;
      writeToTerminal: (_sessionId: string, _generation: number, data: string) => boolean;
    };
    queuedInternals.commandSubmissionQueues = new Map();
    queuedInternals.requireBoundPty = vi.fn(() => 9);
    queuedInternals.isRuntimePtyCurrent = vi.fn(() => true);
    queuedInternals.writeToTerminal = vi.fn((_sessionId, _generation, data) => {
      writes.push(data);
      if (data !== '\r') ownershipCurrent = false;
      return true;
    });
    const submitFromPrototype = (
      ClaudeRuntime.prototype as unknown as {
        submitClaudeCommand: (
          session: { sessionId: string },
          command: string,
          assertOwnership: () => void,
        ) => Promise<void>;
      }
    ).submitClaudeCommand;
    const queued = submitFromPrototype.call(
      queuedRuntime,
      runtimeSession,
      '/model target-model',
      () => {
        if (!ownershipCurrent) throw new Error('lease cancelled');
      },
    );

    await expect(queued).rejects.toThrow('Claude Code 会话已停止或重启，已取消这次命令。');
    expect(writes).toEqual(['/model target-model', '\x15']);
  });
});
