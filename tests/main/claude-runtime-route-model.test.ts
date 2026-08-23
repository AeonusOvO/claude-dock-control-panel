import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import type { ClaudePermissionMode, PtyGeneration } from '../../src/shared/contracts';

interface TestRuntimeSession {
  active: boolean;
  claudeContextWindowMode?: 'auto' | 'extended' | 'standard';
  cwd: string;
  diagnosticBuffer: string;
  effortRestoreInProgress: boolean;
  expectedModel?: string;
  exitMarker?: string;
  liveOfficialNetworkProvider?: 'anthropic-claude' | 'openai-codex';
  launchGeneration?: number;
  markerRemainder: string;
  permissionModeCycle: ClaudePermissionMode[];
  ptyGeneration?: PtyGeneration;
  runtimeModel?: string;
  sessionId: string;
  thinkingEnabledForHighEffort: boolean;
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
  prepareRouteServices(...args: unknown[]): Promise<void>;
  sessions: Map<string, TestRuntimeSession>;
  stopUnusedRoute(...args: unknown[]): Promise<void>;
  submitClaudeCommand(runtime: TestRuntimeSession, commandLine: string): Promise<void>;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRuntime = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-route-model-'));
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
    () => true,
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
  return { internals, runtime, session };
};

const createRouteBoundaryRuntime = (
  ensureManagedChatGptGatewayReady: (cwd: string) => Promise<void>,
) => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-route-boundary-'));
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
    () => true,
    async () => undefined,
    ensureManagedChatGptGatewayReady,
    () => undefined,
  );
  const internals = runtime as unknown as ClaudeRuntimeInternals;
  const stopUnusedRoute = vi.fn(async (..._args: unknown[]) => undefined);
  internals.stopUnusedRoute = stopUnusedRoute;
  return { internals, runtime, stopUnusedRoute };
};

describe('Claude runtime managed route boundary', () => {
  it('passes the exact project to readiness without stopping the predecessor route', async () => {
    const calls: string[] = [];
    const readiness = vi.fn(async (cwd: string) => {
      calls.push(`ready:${cwd}`);
    });
    const { internals, runtime, stopUnusedRoute } = createRouteBoundaryRuntime(readiness);
    stopUnusedRoute.mockImplementation(async (...args: unknown[]) => {
      calls.push(`stop:${String(args[0])}`);
    });

    try {
      await internals.prepareRouteServices('managed-chatgpt', 'session-1', 'D:\\Project');

      expect(readiness).toHaveBeenCalledWith('D:\\Project');
      expect(stopUnusedRoute).not.toHaveBeenCalled();
      expect(calls).toEqual(['ready:D:\\Project']);
    } finally {
      runtime.shutdown();
    }
  });

  it('does not continue managed route preparation after readiness is blocked', async () => {
    const blocked = new Error('network blocked');
    const readiness = vi.fn(async (_cwd: string) => {
      throw blocked;
    });
    const { internals, runtime, stopUnusedRoute } = createRouteBoundaryRuntime(readiness);

    try {
      await expect(
        internals.prepareRouteServices('managed-chatgpt', 'session-1', 'D:\\Project'),
      ).rejects.toBe(blocked);
      expect(readiness).toHaveBeenCalledWith('D:\\Project');
      expect(stopUnusedRoute).not.toHaveBeenCalled();
    } finally {
      runtime.shutdown();
    }
  });
});

describe('Claude runtime live model context', () => {
  it('promotes and clears the official provider with the exact bound PTY generation', async () => {
    const { internals, runtime, session } = createRuntime();
    const activityEvents: string[] = [];
    runtime.setRuntimeActivityHandler('activity.ps1', (event) => {
      activityEvents.push(event.event);
    });
    session.launchGeneration = 1;
    session.ptyGeneration = 16;

    try {
      const prepared = await runtime.prepareLaunch(session.sessionId, session.cwd, 'new');
      expect(prepared.officialNetworkProvider).toBe('anthropic-claude');
      expect(session.liveOfficialNetworkProvider).toBeUndefined();
      expect(() => runtime.officialNetworkProviderForActivePty(session.sessionId, 17)).toThrow(
        'Claude Code 已绑定到其他终端，这次重新启动已取消。',
      );

      runtime.bindPty(session.sessionId, 17, prepared.token);
      const replacement = internals.sessions.get(session.sessionId);
      expect(runtime.officialNetworkProviderForActivePty(session.sessionId, 17)).toBe(
        'anthropic-claude',
      );
      expect(replacement).not.toBe(session);
      expect(activityEvents).toEqual(['SessionEnd', 'SessionStart']);

      runtime.bindPty(session.sessionId, 17, prepared.token);
      expect(activityEvents).toEqual(['SessionEnd', 'SessionStart']);
      expect(() => runtime.bindPty(session.sessionId, 18, prepared.token)).toThrow(
        'Claude Code 已绑定到其他终端',
      );
      expect(() => runtime.bindPty(session.sessionId, 17, {})).toThrow(
        'Claude Code 启动令牌已失效',
      );
      expect(runtime.officialNetworkProviderForActivePty(session.sessionId, 17)).toBe(
        'anthropic-claude',
      );
      expect(runtime.setInactive(session.sessionId, 17)).toBe(true);
      expect(runtime.officialNetworkProviderForActivePty(session.sessionId, 17)).toBeUndefined();
      expect(replacement?.liveOfficialNetworkProvider).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it('keeps a live extended session on the 1M runtime model after /model', async () => {
    const { internals, runtime, session } = createRuntime();
    session.claudeContextWindowMode = 'extended';
    session.expectedModel = 'claude-opus-5';
    session.runtimeModel = 'claude-opus-5[1m]';
    session.ptyGeneration = 17;
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
