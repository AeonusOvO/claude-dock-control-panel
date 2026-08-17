import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeClaudeConfig } from '../src/main/claude-configuration';
import { ClaudeRuntime } from '../src/main/claude-runtime';
import { ConversationPreferencesStore } from '../src/main/conversation-preferences-store';
import { modelSpeedTargetKey } from '../src/main/model-speed-capabilities';
import {
  POWERSHELL_STARTUP_COMMAND_ENV,
  POWERSHELL_STARTUP_TRIGGER,
} from '../src/main/terminal-session';
import { SUBMIT_DELAY_MS } from '../src/shared/composer-input';
import type {
  ClaudeContextWindowMode,
  ClaudeEffortCompatibility,
  ClaudeEffortRequest,
  ClaudeMetrics,
  ClaudePermissionMode,
  PtyGeneration,
} from '../src/shared/contracts';

interface TestRuntimeSession {
  active: boolean;
  artifactDirectory?: string;
  claudeContextWindowCustomTokens?: number;
  claudeContextWindowMode?: ClaudeContextWindowMode;
  conversationId?: string;
  cwd: string;
  diagnosticBuffer: string;
  effortCompatibility?: ClaudeEffortCompatibility;
  effortRestoreAfterTurn?: ClaudeEffortRequest;
  effortRestoreInProgress: boolean;
  exitMarker?: string;
  expectedModel?: string;
  lastApiError?: {
    category: 'context-window-exceeded' | 'effort-thinking-disabled' | 'general';
    detectedAt: number;
    detail: string;
  };
  launchGeneration?: number;
  markerRemainder: string;
  metrics?: ClaudeMetrics;
  metricsPath?: string;
  pendingEffortRestore?: ClaudeEffortRequest;
  permissionModeCycle: ClaudePermissionMode[];
  ptyGeneration?: PtyGeneration;
  runtimeModel?: string;
  sessionId: string;
  settingsPath?: string;
  signalPath?: string;
  signalSeenAt?: number;
  thinkingEnabledForHighEffort: boolean;
  turnStopPath?: string;
  turnStopSeenAt?: number;
  waitingForCompact?: (signaledAt: number) => void;
}

interface TestLaunchConfigSnapshot {
  allowBypassPermissions: boolean;
  config: ReturnType<typeof normalizeClaudeConfig>;
  credential?: string;
  storage: Record<string, unknown>;
}

interface ClaudeRuntimeInternals {
  compactAndWait(
    runtime: TestRuntimeSession,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ): Promise<void>;
  configStore: {
    createLaunchSnapshot(cwd: string): TestLaunchConfigSnapshot;
    getCredential(cwd: string): string | undefined;
    launchSnapshotIsCurrent(cwd: string, snapshot: TestLaunchConfigSnapshot): boolean;
  };
  diagnoseInstallation(): Promise<{
    executable: string;
    installationKind: 'native';
    installed: true;
    message: string;
    security: 'ready';
    version: string;
  }>;
  emitState(runtime: TestRuntimeSession): Promise<void>;
  getRouteHealth(...args: unknown[]): Promise<undefined>;
  pollMetricsOnce(): Promise<void>;
  prepareRouteServices(...args: unknown[]): Promise<void>;
  readLaunchArtifact(artifactPath: string): Promise<string>;
  restoreEffortAfterCompatibilityTurn(runtime: TestRuntimeSession): Promise<void>;
  sessions: Map<string, TestRuntimeSession>;
  submitClaudeCommand(runtime: TestRuntimeSession, commandLine: string): Promise<void>;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRuntime = (
  contextWindow: () => { customTokens?: number; mode: ClaudeContextWindowMode } = () => ({
    mode: 'auto',
  }),
) => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-claude-pty-'));
  temporaryRoots.push(root);
  const writes: Array<{
    data: string;
    ptyGeneration: PtyGeneration;
    sessionId: string;
  }> = [];
  const runtime = new ClaudeRuntime(
    root,
    path.join(root, 'statusline.ps1'),
    path.join(root, 'signal.ps1'),
    path.join(root, 'guard.ps1'),
    () => false,
    () => 'standard',
    contextWindow,
    () => undefined,
    (sessionId, ptyGeneration, data) => {
      writes.push({ data, ptyGeneration, sessionId });
      return true;
    },
    async () => undefined,
    async () => undefined,
    () => undefined,
  );
  const internals = runtime as unknown as ClaudeRuntimeInternals;
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
  const session: TestRuntimeSession = {
    active: true,
    cwd: 'D:\\Project',
    diagnosticBuffer: '',
    effortRestoreInProgress: false,
    exitMarker: 'old-exit-marker',
    markerRemainder: '',
    permissionModeCycle: [],
    sessionId: 'session-1',
    thinkingEnabledForHighEffort: false,
  };
  internals.sessions.set(session.sessionId, session);
  return { internals, root, runtime, session, writes };
};

const launchArtifacts = (session: TestRuntimeSession) => {
  if (
    !session.artifactDirectory ||
    session.launchGeneration === undefined ||
    !session.metricsPath ||
    !session.settingsPath ||
    !session.signalPath ||
    !session.turnStopPath
  ) {
    throw new Error('Claude launch artifacts were not prepared.');
  }
  return {
    artifactDirectory: session.artifactDirectory,
    launchGeneration: session.launchGeneration,
    metricsPath: session.metricsPath,
    settingsPath: session.settingsPath,
    signalPath: session.signalPath,
    turnStopPath: session.turnStopPath,
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const deferredString = () => deferred<string>();
const CONVERSATION_A = '8f9aa605-adb6-4e2b-a25a-607e14bad666';
const CONVERSATION_B = '53b9f42a-a26a-4ce6-a6d3-82d783c8bdde';

describe('Claude runtime PTY ownership', () => {
  it('finds every exact conversation owner before renderer metrics are available', () => {
    const { internals, runtime, session } = createRuntime();
    try {
      session.conversationId = CONVERSATION_A.toUpperCase();
      internals.sessions.set('metrics-owner', {
        ...session,
        conversationId: undefined,
        cwd: 'd:\\project',
        metrics: { capturedAt: 1, sessionId: CONVERSATION_A },
        sessionId: 'metrics-owner',
      });
      internals.sessions.set('other-conversation', {
        ...session,
        conversationId: CONVERSATION_B,
        sessionId: 'other-conversation',
      });
      internals.sessions.set('other-project', {
        ...session,
        conversationId: CONVERSATION_A,
        cwd: 'D:\\Other Project',
        sessionId: 'other-project',
      });
      internals.sessions.set('inactive-owner', {
        ...session,
        active: false,
        conversationId: CONVERSATION_A,
        metrics: { capturedAt: 1, sessionId: CONVERSATION_A },
        sessionId: 'inactive-owner',
      });

      expect(runtime.sessionIdsForConversation('D:\\PROJECT', CONVERSATION_A)).toEqual([
        'session-1',
        'metrics-owner',
      ]);
      expect(runtime.sessionOwnsConversation('inactive-owner', 'D:\\PROJECT', CONVERSATION_A)).toBe(
        false,
      );
    } finally {
      runtime.shutdown();
    }
  });

  it('removes persisted preferences only through the explicit conversation API', () => {
    const { root, runtime } = createRuntime();
    try {
      const preferences = new ConversationPreferencesStore(root);
      preferences.record(CONVERSATION_A, { model: 'claude-opus-5' });
      expect(preferences.get(CONVERSATION_A)?.model).toBe('claude-opus-5');

      runtime.removeConversationPreferences(CONVERSATION_A.toUpperCase());

      expect(new ConversationPreferencesStore(root).get(CONVERSATION_A)).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it('runs the main-owned conversation guard before committing a resume launch', async () => {
    const { runtime, session } = createRuntime();
    const guard = vi.fn(() => {
      throw new Error('conversation deletion owns this resume');
    });
    session.active = false;
    runtime.setConversationLaunchGuard(guard);

    try {
      await expect(
        runtime.prepareLaunchWithSession(session.sessionId, session.cwd, CONVERSATION_A),
      ).rejects.toThrow('conversation deletion owns this resume');
      expect(guard).toHaveBeenCalledWith(session.cwd, 'resume', CONVERSATION_A);
      expect(runtime.isActive(session.sessionId)).toBe(false);
    } finally {
      runtime.shutdown();
    }
  });

  it('routes writes and exit markers only through the exact bound generation', () => {
    const { runtime, session, writes } = createRuntime();
    try {
      runtime.bindPty(session.sessionId, 4);
      expect(runtime.writeTerminal(session.sessionId, 4, 'launch\r')).toBe(true);
      expect(runtime.writeTerminal(session.sessionId, 3, 'stale\r')).toBe(false);
      expect(writes).toEqual([
        { data: 'launch\r', ptyGeneration: 4, sessionId: session.sessionId },
      ]);

      expect(
        runtime.consumeTerminalOutput(session.sessionId, 3, `before${session.exitMarker}after`),
      ).toContain('old-exit-marker');
      expect(runtime.isBoundToPty(session.sessionId, 4)).toBe(true);

      expect(
        runtime.consumeTerminalOutput(session.sessionId, 4, 'beforeold-exit-markerafter'),
      ).toBe('beforeafter');
      expect(runtime.isActive(session.sessionId)).toBe(false);
    } finally {
      runtime.shutdown();
    }
  });

  it('separates prepared cleanup from exact-generation deactivation', () => {
    const { runtime, session } = createRuntime();
    try {
      expect(Reflect.apply(runtime.setInactive, runtime, [session.sessionId])).toBe(false);
      expect(runtime.isActive(session.sessionId)).toBe(true);
      expect(runtime.cleanupPreparedLaunch(session.sessionId)).toBe(true);
      expect(runtime.isActive(session.sessionId)).toBe(false);

      session.active = true;
      session.exitMarker = 'bound-exit-marker';
      runtime.bindPty(session.sessionId, 5);
      expect(Reflect.apply(runtime.setInactive, runtime, [session.sessionId])).toBe(false);
      expect(runtime.cleanupPreparedLaunch(session.sessionId)).toBe(false);
      expect(runtime.setInactive(session.sessionId, 4)).toBe(false);
      expect(runtime.isBoundToPty(session.sessionId, 5)).toBe(true);
      expect(runtime.setInactive(session.sessionId, 5)).toBe(true);

      session.active = true;
      session.exitMarker = 'new-exit-marker';
      runtime.bindPty(session.sessionId, 6);
      expect(runtime.setInactive(session.sessionId, 5)).toBe(false);
      expect(runtime.cleanupPreparedLaunch(session.sessionId)).toBe(false);
      expect(runtime.isBoundToPty(session.sessionId, 6)).toBe(true);
    } finally {
      runtime.shutdown();
    }
  });

  it('returns the predecessor generation when preparation unbinds a running PTY', async () => {
    const { runtime, session } = createRuntime();
    try {
      runtime.bindPty(session.sessionId, 7);

      const prepared = await runtime.prepareLaunch(session.sessionId, session.cwd, 'continue');

      expect(prepared.predecessorPtyGeneration).toBe(7);
      expect(runtime.isBoundToPty(session.sessionId, 7)).toBe(false);
      expect(runtime.cleanupPreparedLaunch(session.sessionId)).toBe(true);
    } finally {
      runtime.shutdown();
    }
  });

  it('drops a delayed command return after the PTY generation changes', async () => {
    vi.useFakeTimers();
    const { internals, runtime, session, writes } = createRuntime();
    try {
      runtime.bindPty(session.sessionId, 7);
      const pending = internals.submitClaudeCommand(session, '/model claude-opus-5');
      const rejection = expect(pending).rejects.toThrow('会话已停止或重启');
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual([
        {
          data: '/model claude-opus-5',
          ptyGeneration: 7,
          sessionId: session.sessionId,
        },
      ]);

      expect(runtime.setInactive(session.sessionId, 7)).toBe(true);
      session.active = true;
      session.exitMarker = 'replacement-exit-marker';
      runtime.bindPty(session.sessionId, 8);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);

      await rejection;
      expect(writes).toHaveLength(1);
      expect(runtime.isBoundToPty(session.sessionId, 8)).toBe(true);
    } finally {
      runtime.shutdown();
    }
  });

  it('retries a delayed G1 state read against the current G2 owner', async () => {
    const { internals, runtime, session } = createRuntime();
    let resolveFirstRoute!: () => void;
    const firstRoute = new Promise<undefined>((resolve) => {
      resolveFirstRoute = () => resolve(undefined);
    });
    const getRouteHealth = vi
      .fn<ClaudeRuntimeInternals['getRouteHealth']>()
      .mockImplementationOnce(() => firstRoute)
      .mockResolvedValue(undefined);
    internals.getRouteHealth = getRouteHealth;
    session.launchGeneration = 1;
    session.ptyGeneration = 21;
    session.metrics = { capturedAt: 1, modelId: 'g1-model' };

    try {
      const pending = runtime.getState(session.sessionId, session.cwd);
      await vi.waitFor(() => {
        expect(getRouteHealth).toHaveBeenCalledTimes(1);
      });

      session.launchGeneration = 2;
      session.ptyGeneration = 22;
      session.metrics = { capturedAt: 2, modelId: 'g2-model' };
      resolveFirstRoute();

      await expect(pending).resolves.toMatchObject({
        metrics: { capturedAt: 2, modelId: 'g2-model' },
        ptyGeneration: 22,
        stateRevision: 2,
      });
      expect(getRouteHealth).toHaveBeenCalledTimes(2);
    } finally {
      runtime.shutdown();
    }
  });

  it('aborts a compact-first relaunch without waiting for the compact timeout', async () => {
    vi.useFakeTimers();
    const { runtime, session, writes } = createRuntime();
    const controller = new AbortController();
    const cancellation = new Error('cancel compact relaunch');
    const assertCurrent = (): void => {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
    };
    try {
      runtime.bindPty(session.sessionId, 31);
      const baselineTimerCount = vi.getTimerCount();
      const pending = runtime.compactBeforeRelaunch(
        session.sessionId,
        session.cwd,
        true,
        assertCurrent,
        controller.signal,
      );

      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      expect(writes[0]?.data).toContain('/compact');
      expect(writes[1]?.data).toBe('\r');
      expect(session.waitingForCompact).toBeTypeOf('function');

      controller.abort(cancellation);

      await expect(pending).rejects.toBe(cancellation);
      expect(session.waitingForCompact).toBeUndefined();
      expect(vi.getTimerCount()).toBe(baselineTimerCount);
    } finally {
      runtime.shutdown();
    }
  });

  it('never writes a queued compact command after its relaunch is cancelled', async () => {
    vi.useFakeTimers();
    const { internals, runtime, session, writes } = createRuntime();
    const controller = new AbortController();
    const cancellation = new Error('cancel queued compact');
    const assertCurrent = (): void => {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
    };
    try {
      runtime.bindPty(session.sessionId, 32);
      const blockingSubmission = internals.submitClaudeCommand(session, '/model current-model');
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.map(({ data }) => data)).toEqual(['/model current-model']);

      const pending = runtime.compactBeforeRelaunch(
        session.sessionId,
        session.cwd,
        true,
        assertCurrent,
        controller.signal,
      );
      const rejection = expect(pending).rejects.toBe(cancellation);
      controller.abort(cancellation);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);

      await expect(blockingSubmission).resolves.toBeUndefined();
      await rejection;
      expect(writes.map(({ data }) => data)).toEqual(['/model current-model', '\r']);
      expect(session.waitingForCompact).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it('does not let a late old PostCompact waiter settle its replacement', async () => {
    vi.useFakeTimers();
    const { internals, runtime, session } = createRuntime();
    const firstController = new AbortController();
    const cancellation = new Error('replace compact waiter');
    const assertFirstCurrent = (): void => {
      if (firstController.signal.aborted) {
        throw firstController.signal.reason;
      }
    };
    try {
      runtime.bindPty(session.sessionId, 33);
      const first = internals.compactAndWait(session, assertFirstCurrent, firstController.signal);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      const oldWaiter = session.waitingForCompact;
      if (!oldWaiter) {
        throw new Error('The first compact waiter was not installed.');
      }

      firstController.abort(cancellation);
      await expect(first).rejects.toBe(cancellation);

      const replacement = internals.compactAndWait(session, () => undefined);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      const replacementWaiter = session.waitingForCompact;
      if (!replacementWaiter) {
        throw new Error('The replacement compact waiter was not installed.');
      }
      let replacementSettled = false;
      void replacement.then(() => {
        replacementSettled = true;
      });

      oldWaiter(1);
      await Promise.resolve();
      expect(replacementSettled).toBe(false);
      expect(session.waitingForCompact).toBe(replacementWaiter);

      replacementWaiter(2);
      await expect(replacement).resolves.toBeUndefined();
      expect(session.waitingForCompact).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });
});

describe('Claude runtime launch configuration snapshots', () => {
  it.each([
    [
      'gateway',
      normalizeClaudeConfig({
        authMode: 'authToken',
        baseUrl: 'https://relay.example.com',
        credentialAction: 'keep',
        model: 'claude-opus-5',
        preset: 'custom',
        provider: 'gateway',
      }),
      'snapshot-token',
      'ANTHROPIC_AUTH_TOKEN',
      '0',
      '0',
    ],
    [
      'official',
      normalizeClaudeConfig({
        authMode: 'apiKey',
        baseUrl: '',
        credentialAction: 'keep',
        model: 'claude-opus-5',
        preset: 'anthropic-api',
        provider: 'anthropic',
      }),
      'snapshot-api-key',
      'ANTHROPIC_API_KEY',
      null,
      '',
    ],
  ] as const)(
    'prepares matching process and non-secret inline settings for %s native launches',
    async (route, config, credential, credentialKey, processAttribution, settingsAttribution) => {
      const { internals, runtime, session } = createRuntime();
      const launchSnapshot: TestLaunchConfigSnapshot = {
        allowBypassPermissions: false,
        config,
        credential,
        storage: { revision: `${route}-snapshot` },
      };
      const createLaunchSnapshot = vi.fn(() => launchSnapshot);
      internals.configStore.createLaunchSnapshot = createLaunchSnapshot;
      internals.configStore.launchSnapshotIsCurrent = vi.fn(
        (_cwd, candidate) => candidate === launchSnapshot,
      );
      const ownerId = `native-route:${route}`;

      try {
        const prepared = await runtime.prepareNativeConversation(
          ownerId,
          session.cwd,
          'claude-opus-5',
        );

        expect(createLaunchSnapshot).toHaveBeenCalledTimes(1);
        expect(prepared.environment[credentialKey]).toBe(credential);
        expect(prepared.environment.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe(processAttribution);
        expect(prepared.settingsEnvironment.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe(
          settingsAttribution,
        );
        expect(prepared.settingsEnvironment).not.toHaveProperty(credentialKey);
      } finally {
        runtime.releaseNativeConversation(ownerId);
        runtime.shutdown();
      }
    },
  );

  it('uses the 1M suffix only at the Claude Code launch boundary', async () => {
    const { internals, runtime, session } = createRuntime(() => ({ mode: 'extended' }));
    const launchSnapshot: TestLaunchConfigSnapshot = {
      allowBypassPermissions: false,
      config: normalizeClaudeConfig({
        authMode: 'authToken',
        baseUrl: 'https://relay.example.com',
        credentialAction: 'keep',
        model: 'claude-opus-5',
        preset: 'custom',
        provider: 'gateway',
      }),
      credential: 'snapshot-token',
      storage: { revision: 'snapshot' },
    };
    internals.configStore.createLaunchSnapshot = vi.fn(() => launchSnapshot);
    internals.configStore.launchSnapshotIsCurrent = vi.fn(
      (_cwd, candidate) => candidate === launchSnapshot,
    );

    try {
      const prepared = await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      const settings = JSON.parse(readFileSync(launchArtifacts(session).settingsPath, 'utf8')) as {
        env: Record<string, string>;
        model: string;
      };

      expect(settings.model).toBe('claude-opus-5[1m]');
      expect(settings.env).toMatchObject({
        ANTHROPIC_MODEL: 'claude-opus-5[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      });
      expect(prepared.environment).toMatchObject({
        ANTHROPIC_MODEL: 'claude-opus-5[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      });
      expect(session.expectedModel).toBe('claude-opus-5');
      expect(session.runtimeModel).toBe('claude-opus-5[1m]');
      expect(launchSnapshot.config.model).toBe('claude-opus-5');
    } finally {
      runtime.shutdown();
    }
  });

  it('uses config and credential from one snapshot without rereading storage', async () => {
    const { internals, runtime, session } = createRuntime();
    const launchSnapshot: TestLaunchConfigSnapshot = {
      allowBypassPermissions: false,
      config: normalizeClaudeConfig({
        authMode: 'authToken',
        baseUrl: 'https://snapshot.example.com',
        credentialAction: 'keep',
        model: 'snapshot-model',
        preset: 'custom',
        provider: 'gateway',
      }),
      credential: 'snapshot-token',
      storage: { revision: 'snapshot' },
    };
    const createLaunchSnapshot = vi.fn(() => launchSnapshot);
    const getCredential = vi.fn(() => 'replacement-token');
    internals.configStore.createLaunchSnapshot = createLaunchSnapshot;
    internals.configStore.getCredential = getCredential;
    internals.configStore.launchSnapshotIsCurrent = vi.fn(
      (_cwd, candidate) => candidate === launchSnapshot,
    );

    try {
      const prepared = await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');

      expect(createLaunchSnapshot).toHaveBeenCalledTimes(1);
      expect(getCredential).not.toHaveBeenCalled();
      expect(prepared.command).toBe(POWERSHELL_STARTUP_TRIGGER);
      expect(prepared.environment).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: 'snapshot-token',
        ANTHROPIC_BASE_URL: 'https://snapshot.example.com',
        ANTHROPIC_MODEL: 'snapshot-model',
      });
      const launchCommand = prepared.environment[POWERSHELL_STARTUP_COMMAND_ENV];
      expect(launchCommand).toContain('& claude ');
      expect(launchCommand).toContain('--settings');
      expect(launchCommand).not.toContain('--no-chrome');
      expect(launchCommand).not.toContain('--model');
    } finally {
      runtime.shutdown();
    }
  });

  it('rejects a launch when the snapshot changes during route preparation', async () => {
    const { internals, runtime, session } = createRuntime();
    const launchSnapshot: TestLaunchConfigSnapshot = {
      allowBypassPermissions: true,
      config: normalizeClaudeConfig({
        authMode: 'authToken',
        baseUrl: 'https://snapshot.example.com',
        credentialAction: 'keep',
        model: 'snapshot-model',
        preset: 'custom',
        provider: 'gateway',
      }),
      credential: 'snapshot-token',
      storage: { revision: 'snapshot' },
    };
    let snapshotCurrent = true;
    const routePreparation = deferred<void>();
    internals.configStore.createLaunchSnapshot = vi.fn(() => launchSnapshot);
    internals.configStore.launchSnapshotIsCurrent = vi.fn(() => snapshotCurrent);
    internals.prepareRouteServices = vi.fn(() => routePreparation.promise);
    session.artifactDirectory = 'D:\\Existing\\launch-41';
    session.launchGeneration = 41;
    session.ptyGeneration = 9;
    session.exitMarker = 'existing-exit-marker';

    try {
      const pending = runtime.prepareLaunch(session.sessionId, session.cwd, 'continue');
      const rejection = expect(pending).rejects.toThrow('Claude 接入配置在启动准备期间已更新');
      await vi.waitFor(() => {
        expect(internals.prepareRouteServices).toHaveBeenCalledTimes(1);
      });

      snapshotCurrent = false;
      routePreparation.resolve(undefined);
      await rejection;

      expect(session).toMatchObject({
        active: true,
        artifactDirectory: 'D:\\Existing\\launch-41',
        exitMarker: 'existing-exit-marker',
        launchGeneration: 41,
        ptyGeneration: 9,
      });
    } finally {
      runtime.shutdown();
    }
  });

  it('derives a speed target and relaunch environment from the same snapshot', async () => {
    const { internals, runtime, session } = createRuntime();
    const conversationId = '00000000-0000-4000-8000-000000000001';
    const launchSnapshot: TestLaunchConfigSnapshot = {
      allowBypassPermissions: true,
      config: normalizeClaudeConfig({
        authMode: 'apiKey',
        baseUrl: '',
        credentialAction: 'keep',
        model: 'claude-opus-5',
        preset: 'anthropic-api',
        provider: 'anthropic',
      }),
      credential: 'snapshot-api-key',
      storage: { revision: 'snapshot' },
    };
    const createLaunchSnapshot = vi.fn(() => launchSnapshot);
    const getCredential = vi.fn(() => 'replacement-api-key');
    internals.configStore.createLaunchSnapshot = createLaunchSnapshot;
    internals.configStore.getCredential = getCredential;
    internals.configStore.launchSnapshotIsCurrent = vi.fn(
      (_cwd, candidate) => candidate === launchSnapshot,
    );
    session.metrics = {
      capturedAt: 1,
      modelId: 'claude-opus-5',
      sessionId: conversationId,
    };

    try {
      const prepared = await runtime.prepareModelSpeedRelaunch(
        session.sessionId,
        session.cwd,
        'fast',
      );
      const settings = JSON.parse(readFileSync(launchArtifacts(session).settingsPath, 'utf8')) as {
        fastMode: boolean;
        model: string;
      };

      expect(createLaunchSnapshot).toHaveBeenCalledTimes(1);
      expect(getCredential).not.toHaveBeenCalled();
      expect(prepared).toMatchObject({
        environment: { ANTHROPIC_API_KEY: 'snapshot-api-key' },
        preference: 'fast',
        targetKey: modelSpeedTargetKey({
          authMode: launchSnapshot.config.authMode,
          baseUrl: launchSnapshot.config.baseUrl,
          model: 'claude-opus-5',
          preset: launchSnapshot.config.preset,
          provider: launchSnapshot.config.provider,
        }),
      });
      expect(prepared.command).toBe(POWERSHELL_STARTUP_TRIGGER);
      expect(prepared.environment[POWERSHELL_STARTUP_COMMAND_ENV]).toContain(conversationId);
      expect(settings).toMatchObject({ fastMode: true, model: 'claude-opus-5' });
    } finally {
      runtime.shutdown();
    }
  });
});

describe('Claude runtime live model context', () => {
  it('keeps a live extended session on the 1M runtime model after /model', async () => {
    const { internals, runtime, session } = createRuntime();
    session.claudeContextWindowMode = 'extended';
    session.expectedModel = 'claude-opus-5';
    session.runtimeModel = 'claude-opus-5[1m]';
    runtime.bindPty(session.sessionId, 17);
    const targetState = {
      active: true,
      cwd: session.cwd,
      sessionId: session.sessionId,
    } as Awaited<ReturnType<ClaudeRuntime['getState']>>;
    vi.spyOn(runtime, 'getModelOptions').mockResolvedValue({
      activeModel: 'claude-opus-5',
      options: [
        {
          id: 'same-endpoint-sonnet',
          label: 'claude-sonnet-5',
          model: 'claude-sonnet-5',
          providerLabel: '当前接入',
          requiresRelaunch: false,
          sameEndpoint: true,
        },
      ],
    });
    vi.spyOn(runtime, 'getState').mockResolvedValue(targetState);
    const submit = vi.spyOn(internals, 'submitClaudeCommand').mockResolvedValue(undefined);

    try {
      await runtime.switchModel(session.sessionId, session.cwd, 'same-endpoint-sonnet');

      expect(submit).toHaveBeenCalledWith(
        session,
        '/model claude-sonnet-5[1m]',
        expect.any(Function),
      );
      expect(session.expectedModel).toBe('claude-sonnet-5');
      expect(session.runtimeModel).toBe('claude-sonnet-5[1m]');
    } finally {
      runtime.shutdown();
    }
  });
});

describe('Claude runtime launch-owned artifacts', () => {
  it('writes launch-scoped activity and PermissionRequest hooks with a bounded native fallback', async () => {
    const { root, runtime, session } = createRuntime();
    const activityEvents: string[] = [];
    runtime.setRuntimeActivityHandler(path.join(root, 'activity.ps1'), (event) => {
      activityEvents.push(event.event);
    });
    runtime.setPermissionRequestHook(path.join(root, 'permission.ps1'), () => ({
      pipeName: 'claudedock-test-pipe',
      token: 'test-token',
    }));
    try {
      await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      const settings = JSON.parse(readFileSync(launchArtifacts(session).settingsPath, 'utf8')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; timeout?: number; type: string }> }>
        >;
      };
      for (const event of [
        'PermissionRequest',
        'SessionEnd',
        'Stop',
        'StopFailure',
        'SubagentStart',
        'SubagentStop',
        'TaskCreated',
        'TaskCompleted',
        'UserPromptSubmit',
      ]) {
        expect(settings.hooks[event]).toBeDefined();
      }
      const permission = settings.hooks.PermissionRequest?.[0]?.hooks[0];
      expect(permission).toMatchObject({ timeout: 600, type: 'command' });
      expect(permission?.command).toContain('-PipeName "claudedock-test-pipe"');
      expect(permission?.command).toContain(`-LaunchGeneration ${session.launchGeneration}`);
      runtime.bindPty(session.sessionId, 15);
      expect(activityEvents).toContain('SessionStart');
    } finally {
      runtime.shutdown();
    }
  });

  it('keeps delayed G1 signal, turn-stop, and metrics writes isolated from bound G2', async () => {
    const { internals, runtime, session } = createRuntime();
    try {
      await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      const first = launchArtifacts(session);
      const firstSettings = JSON.parse(readFileSync(first.settingsPath, 'utf8')) as {
        hooks: unknown;
        statusLine: { command: string };
      };
      expect(firstSettings.statusLine.command).toContain(first.metricsPath.replaceAll('\\', '/'));
      expect(JSON.stringify(firstSettings.hooks)).toContain(first.signalPath.replaceAll('\\', '/'));
      expect(JSON.stringify(firstSettings.hooks)).toContain(
        first.turnStopPath.replaceAll('\\', '/'),
      );
      runtime.bindPty(session.sessionId, 11);

      await runtime.prepareLaunch(session.sessionId, session.cwd, 'continue');
      const second = launchArtifacts(session);
      runtime.bindPty(session.sessionId, 12);
      expect(second.launchGeneration).toBeGreaterThan(first.launchGeneration);
      expect(second.artifactDirectory).not.toBe(first.artifactDirectory);
      expect(second.metricsPath).not.toBe(first.metricsPath);
      expect(second.signalPath).not.toBe(first.signalPath);
      expect(second.turnStopPath).not.toBe(first.turnStopPath);

      writeFileSync(
        first.signalPath,
        JSON.stringify({ event: 'PostCompact', signaledAt: Date.now() }),
        'utf8',
      );
      writeFileSync(
        first.turnStopPath,
        JSON.stringify({ event: 'Stop', signaledAt: Date.now() }),
        'utf8',
      );
      writeFileSync(
        first.metricsPath,
        JSON.stringify({
          capturedAt: Date.now(),
          effortLevel: 'max',
          modelId: 'stale-g1-model',
        }),
        'utf8',
      );

      const waitingForCompact = vi.fn();
      const restoreEffort = vi.fn(async () => undefined);
      internals.restoreEffortAfterCompatibilityTurn = restoreEffort;
      session.waitingForCompact = waitingForCompact;
      session.effortCompatibility = {
        detectedAt: Date.now() - 1_000,
        maximum: 'high',
        recovery: 'recovered',
        rejectedLevel: 'max',
      };
      session.effortRestoreAfterTurn = 'max';
      session.pendingEffortRestore = 'max';
      session.lastApiError = {
        category: 'general',
        detectedAt: Date.now() - 1_000,
        detail: 'G2 error',
      };

      await internals.pollMetricsOnce();

      expect(waitingForCompact).not.toHaveBeenCalled();
      expect(restoreEffort).not.toHaveBeenCalled();
      expect(session.metrics).toBeUndefined();
      expect(session.turnStopSeenAt).toBeUndefined();
      expect(session.effortRestoreAfterTurn).toBe('max');
      expect(session.pendingEffortRestore).toBe('max');
      expect(session.lastApiError?.detail).toBe('G2 error');

      writeFileSync(
        second.signalPath,
        JSON.stringify({ event: 'PostCompact', signaledAt: Date.now() + 1 }),
        'utf8',
      );
      writeFileSync(
        second.metricsPath,
        JSON.stringify({ capturedAt: Date.now() + 1, modelId: 'current-g2-model' }),
        'utf8',
      );
      session.pendingEffortRestore = undefined;
      await internals.pollMetricsOnce();

      expect(waitingForCompact).toHaveBeenCalledTimes(1);
      expect(session.metrics?.modelId).toBe('current-g2-model');
    } finally {
      runtime.shutdown();
    }
  });

  it('discards G1 artifact reads that finish after G2 prepare and bind', async () => {
    const { internals, runtime, session } = createRuntime();
    try {
      await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      const first = launchArtifacts(session);
      runtime.bindPty(session.sessionId, 21);
      session.waitingForCompact = vi.fn();
      session.effortCompatibility = {
        detectedAt: Date.now() - 1_000,
        maximum: 'high',
        recovery: 'recovered',
        rejectedLevel: 'max',
      };
      session.effortRestoreAfterTurn = 'max';

      const pendingReads = new Map(
        [first.signalPath, first.turnStopPath, first.metricsPath].map((artifactPath) => [
          artifactPath,
          deferredString(),
        ]),
      );
      const readLaunchArtifact = vi.fn((artifactPath: string) => {
        const pending = pendingReads.get(artifactPath);
        return pending
          ? pending.promise
          : Promise.reject(new Error(`Unexpected artifact read: ${artifactPath}`));
      });
      internals.readLaunchArtifact = readLaunchArtifact;
      const stalePoll = internals.pollMetricsOnce();
      await vi.waitFor(() => {
        expect(readLaunchArtifact).toHaveBeenCalledTimes(3);
      });

      await runtime.prepareLaunch(session.sessionId, session.cwd, 'continue');
      const second = launchArtifacts(session);
      runtime.bindPty(session.sessionId, 22);
      const waitingForCompact = vi.fn();
      const restoreEffort = vi.fn(async () => undefined);
      internals.restoreEffortAfterCompatibilityTurn = restoreEffort;
      session.waitingForCompact = waitingForCompact;
      session.effortCompatibility = {
        detectedAt: Date.now() - 500,
        maximum: 'high',
        recovery: 'recovered',
        rejectedLevel: 'xhigh',
      };
      session.effortRestoreAfterTurn = 'xhigh';
      session.pendingEffortRestore = 'xhigh';
      session.lastApiError = {
        category: 'general',
        detectedAt: Date.now() - 500,
        detail: 'replacement error',
      };

      pendingReads
        .get(first.signalPath)
        ?.resolve(JSON.stringify({ event: 'PostCompact', signaledAt: Date.now() }));
      pendingReads
        .get(first.turnStopPath)
        ?.resolve(JSON.stringify({ event: 'Stop', signaledAt: Date.now() }));
      pendingReads.get(first.metricsPath)?.resolve(
        JSON.stringify({
          capturedAt: Date.now(),
          effortLevel: 'max',
          modelId: 'in-flight-g1-model',
        }),
      );
      await stalePoll;

      expect(second.launchGeneration).toBeGreaterThan(first.launchGeneration);
      expect(waitingForCompact).not.toHaveBeenCalled();
      expect(restoreEffort).not.toHaveBeenCalled();
      expect(session.metrics).toBeUndefined();
      expect(session.turnStopSeenAt).toBeUndefined();
      expect(session.effortRestoreAfterTurn).toBe('xhigh');
      expect(session.pendingEffortRestore).toBe('xhigh');
      expect(session.lastApiError?.detail).toBe('replacement error');
    } finally {
      runtime.shutdown();
    }
  });
});
