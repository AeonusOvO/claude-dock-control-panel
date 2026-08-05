import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRuntime } from '../src/main/claude-runtime';
import { SUBMIT_DELAY_MS } from '../src/shared/composer-input';
import type {
  ClaudeEffortCompatibility,
  ClaudeEffortRequest,
  ClaudeMetrics,
  ClaudePermissionMode,
  PtyGeneration,
} from '../src/shared/contracts';

interface TestRuntimeSession {
  active: boolean;
  artifactDirectory?: string;
  cwd: string;
  diagnosticBuffer: string;
  effortCompatibility?: ClaudeEffortCompatibility;
  effortRestoreAfterTurn?: ClaudeEffortRequest;
  effortRestoreInProgress: boolean;
  exitMarker?: string;
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
  sessionId: string;
  settingsPath?: string;
  signalPath?: string;
  signalSeenAt?: number;
  thinkingEnabledForHighEffort: boolean;
  turnStopPath?: string;
  turnStopSeenAt?: number;
  waitingForCompact?: (signaledAt: number) => void;
}

interface ClaudeRuntimeInternals {
  diagnoseInstallation(): Promise<{
    executable: string;
    installationKind: 'native';
    installed: true;
    message: string;
    security: 'ready';
    version: string;
  }>;
  emitState(runtime: TestRuntimeSession): Promise<void>;
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

const createRuntime = () => {
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
  return { internals, runtime, session, writes };
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

const deferredString = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Claude runtime PTY ownership', () => {
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
});

describe('Claude runtime launch-owned artifacts', () => {
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
