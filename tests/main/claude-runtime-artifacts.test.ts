import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeExecutionLaunchInput,
  ClaudeExecutionLaunchResolution,
  ClaudeExecutionSettingsLaunchResolver,
} from '../../src/main/claude/execution-settings-service';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import type { RuntimeSession } from '../../src/main/claude/runtime-types';
import type { PtyGeneration } from '../../src/shared/contracts';

interface ClaudeRuntimeInternals {
  diagnoseInstallation(): Promise<{
    executable: string;
    installationKind: 'native';
    installed: true;
    message: string;
    security: 'ready';
    version: string;
  }>;
  emitState(runtime: RuntimeSession): Promise<void>;
  pollMetricsOnce(): Promise<void>;
  preparedLaunches: Map<object, { replacement?: RuntimeSession }>;
  prepareRouteServices(...args: unknown[]): Promise<void>;
  readLaunchArtifact(artifactPath: string): Promise<string>;
  restoreEffortAfterCompatibilityTurn(runtime: RuntimeSession): Promise<void>;
  sessions: Map<string, RuntimeSession>;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRuntime = (executionSettingsLaunchResolver?: ClaudeExecutionSettingsLaunchResolver) => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-claude-artifacts-'));
  temporaryRoots.push(root);
  const runtime = new ClaudeRuntime(
    root,
    path.join(root, 'statusline.ps1'),
    path.join(root, 'signal.ps1'),
    path.join(root, 'guard.ps1'),
    () => false,
    () => 'standard',
    () => ({ mode: 'auto' }),
    () => undefined,
    (_sessionId: string, _ptyGeneration: PtyGeneration, _data: string) => true,
    async () => undefined,
    async () => undefined,
    () => undefined,
    fetch,
    undefined,
    undefined,
    undefined,
    undefined,
    executionSettingsLaunchResolver,
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
  const session: RuntimeSession = {
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
  return { internals, root, runtime, session };
};

const launchArtifacts = (session: RuntimeSession) => {
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

const preparedRuntime = (internals: ClaudeRuntimeInternals, token: object): RuntimeSession => {
  const replacement = internals.preparedLaunches.get(token)?.replacement;
  if (!replacement) {
    throw new Error('Claude replacement runtime was not prepared.');
  }
  return replacement;
};

const deferredString = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Claude runtime launch-owned artifacts', () => {
  it('materializes execution settings exactly once from frozen main-owned input for each new launch', async () => {
    let launchSequence = 0;
    const inputs: ClaudeExecutionLaunchInput[] = [];
    const resolveLaunch = vi.fn(
      async (input: ClaudeExecutionLaunchInput): Promise<ClaudeExecutionLaunchResolution> => {
        inputs.push(input);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.processEnvironment)).toBe(true);
        expect(Object.isFrozen(input.route)).toBe(true);
        expect(Object.isFrozen(input.settingsEnvironment)).toBe(true);
        launchSequence += 1;
        const value = `launch-${launchSequence}`;
        return {
          environments: Object.freeze({
            processEnvironment: Object.freeze({
              ...input.processEnvironment,
              CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: value,
            }) as Readonly<Record<string, null | string>>,
            settingsEnvironment: Object.freeze({
              ...input.settingsEnvironment,
              CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: value,
            }) as Readonly<Record<string, string>>,
          }),
        } as ClaudeExecutionLaunchResolution;
      },
    );
    const { runtime, session } = createRuntime({ resolveLaunch });

    try {
      const terminal = await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      expect(resolveLaunch).toHaveBeenCalledTimes(1);
      expect(terminal.environment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('launch-1');
      expect(terminal.environment.ANTHROPIC_API_KEY).toBeNull();

      const native = await runtime.prepareNativeConversation(
        'native-execution-settings',
        session.cwd,
        'claude-opus-5',
      );
      expect(resolveLaunch).toHaveBeenCalledTimes(2);
      expect(native.environment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('launch-2');
      expect(native.settingsEnvironment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('launch-2');
      expect(terminal.environment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('launch-1');

      const terminalRoute = JSON.parse(inputs[0]?.route?.routeId ?? '{}') as {
        cwd?: string;
        officialNetworkProvider?: string;
        preset?: string;
        provider?: string;
      };
      expect(inputs[0]?.route?.model).toBe('default');
      expect(inputs[1]?.route?.model).toBe('claude-opus-5');
      expect(terminalRoute).toMatchObject({
        cwd: path.resolve(session.cwd).toLocaleLowerCase('en-US'),
        officialNetworkProvider: 'anthropic-claude',
        preset: 'anthropic',
        provider: 'anthropic',
      });
    } finally {
      runtime.releaseNativeConversation('native-execution-settings');
      runtime.shutdown();
    }
  });

  it('writes launch-scoped activity and PermissionRequest hooks with a bounded native fallback', async () => {
    const { internals, root, runtime, session } = createRuntime();
    const activityEvents: string[] = [];
    runtime.setRuntimeActivityHandler(path.join(root, 'activity.ps1'), (event) => {
      activityEvents.push(event.event);
    });
    runtime.setPermissionRequestHook(path.join(root, 'permission.ps1'), () => ({
      pipeName: 'claudedock-test-pipe',
      token: 'test-token',
    }));
    try {
      const prepared = await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      const replacement = preparedRuntime(internals, prepared.token);
      const settings = JSON.parse(
        readFileSync(launchArtifacts(replacement).settingsPath, 'utf8'),
      ) as {
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
      expect(permission?.command).toContain(`-LaunchGeneration ${replacement.launchGeneration}`);
      runtime.bindPty(session.sessionId, 15, prepared.token);
      expect(activityEvents).toContain('SessionStart');
    } finally {
      runtime.shutdown();
    }
  });

  it('keeps delayed G1 signal, turn-stop, and metrics writes isolated from bound G2', async () => {
    const { internals, runtime, session } = createRuntime();
    try {
      const firstPrepared = await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      const firstRuntime = preparedRuntime(internals, firstPrepared.token);
      const first = launchArtifacts(firstRuntime);
      const firstSettings = JSON.parse(readFileSync(first.settingsPath, 'utf8')) as {
        hooks: unknown;
        statusLine: { command: string };
      };
      expect(firstSettings.statusLine.command).toContain(first.metricsPath.replaceAll('\\', '/'));
      expect(JSON.stringify(firstSettings.hooks)).toContain(first.signalPath.replaceAll('\\', '/'));
      expect(JSON.stringify(firstSettings.hooks)).toContain(
        first.turnStopPath.replaceAll('\\', '/'),
      );
      runtime.bindPty(session.sessionId, 11, firstPrepared.token);

      const secondPrepared = await runtime.prepareLaunch(
        session.sessionId,
        session.cwd,
        'continue',
      );
      const secondRuntime = preparedRuntime(internals, secondPrepared.token);
      const second = launchArtifacts(secondRuntime);
      runtime.bindPty(session.sessionId, 12, secondPrepared.token);
      const current = internals.sessions.get(session.sessionId);
      if (!current) throw new Error('Replacement runtime was not bound.');
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
      current.waitingForCompact = waitingForCompact;
      current.effortCompatibility = {
        detectedAt: Date.now() - 1_000,
        maximum: 'high',
        recovery: 'recovered',
        rejectedLevel: 'max',
      };
      current.effortRestoreAfterTurn = 'max';
      current.pendingEffortRestore = 'max';
      current.lastApiError = {
        category: 'general',
        detectedAt: Date.now() - 1_000,
        detail: 'G2 error',
      };

      await internals.pollMetricsOnce();

      expect(waitingForCompact).not.toHaveBeenCalled();
      expect(restoreEffort).not.toHaveBeenCalled();
      expect(current.metrics).toBeUndefined();
      expect(current.turnStopSeenAt).toBeUndefined();
      expect(current.effortRestoreAfterTurn).toBe('max');
      expect(current.pendingEffortRestore).toBe('max');
      expect(current.lastApiError?.detail).toBe('G2 error');

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
      current.pendingEffortRestore = undefined;
      await internals.pollMetricsOnce();

      expect(waitingForCompact).toHaveBeenCalledTimes(1);
      expect(current.metrics?.modelId).toBe('current-g2-model');
    } finally {
      runtime.shutdown();
    }
  });

  it('discards G1 artifact reads that finish after G2 prepare and bind', async () => {
    const { internals, runtime, session } = createRuntime();
    try {
      const firstPrepared = await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      const firstRuntime = preparedRuntime(internals, firstPrepared.token);
      const first = launchArtifacts(firstRuntime);
      runtime.bindPty(session.sessionId, 21, firstPrepared.token);
      firstRuntime.waitingForCompact = vi.fn();
      firstRuntime.effortCompatibility = {
        detectedAt: Date.now() - 1_000,
        maximum: 'high',
        recovery: 'recovered',
        rejectedLevel: 'max',
      };
      firstRuntime.effortRestoreAfterTurn = 'max';

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

      const secondPrepared = await runtime.prepareLaunch(
        session.sessionId,
        session.cwd,
        'continue',
      );
      const secondRuntime = preparedRuntime(internals, secondPrepared.token);
      const second = launchArtifacts(secondRuntime);
      runtime.bindPty(session.sessionId, 22, secondPrepared.token);
      const current = internals.sessions.get(session.sessionId);
      if (!current) throw new Error('Replacement runtime was not bound.');
      const waitingForCompact = vi.fn();
      const restoreEffort = vi.fn(async () => undefined);
      internals.restoreEffortAfterCompatibilityTurn = restoreEffort;
      current.waitingForCompact = waitingForCompact;
      current.effortCompatibility = {
        detectedAt: Date.now() - 500,
        maximum: 'high',
        recovery: 'recovered',
        rejectedLevel: 'xhigh',
      };
      current.effortRestoreAfterTurn = 'xhigh';
      current.pendingEffortRestore = 'xhigh';
      current.lastApiError = {
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
      expect(current.metrics).toBeUndefined();
      expect(current.turnStopSeenAt).toBeUndefined();
      expect(current.effortRestoreAfterTurn).toBe('xhigh');
      expect(current.pendingEffortRestore).toBe('xhigh');
      expect(current.lastApiError?.detail).toBe('replacement error');
    } finally {
      runtime.shutdown();
    }
  });
});
