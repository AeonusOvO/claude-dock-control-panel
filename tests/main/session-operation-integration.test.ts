import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeProjectState, TerminalStatus } from '../../src/shared/contracts';
import { ClaudeConversationLifecycleCoordinator } from '../../src/main/claude/conversation-lifecycle';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import {
  ProjectRuntimeSwitchCoordinator,
  type RuntimeSwitchSessionSnapshot,
} from '../../src/main/coordination/main-process-operation';
import {
  ProjectDirectoryLifecycleCoordinator,
  runOwnedProjectDirectoryClosure,
} from '../../src/main/coordination/project-directory-lifecycle';
import { SessionOperationCoordinator } from '../../src/main/coordination/session-operation';
import { createDeleteClaudeConversation } from '../../src/main/conversation/deletion';
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

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
  vi.useRealTimers();
});

describe('main-process session operation ownership', () => {
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
      agentRuntimeStore: { get: vi.fn(() => 'codex') } as never,
      failedRuntimeLaunchCleanupDependencies: {
        hasSession: vi.fn(() => true),
        stopIfGeneration,
      },
      guards: {
        assertApplicationUpdatesAllowed: vi.fn(),
        assertOfficialProviderAllowed: vi.fn(async () => undefined),
        assertRealRuntimeAllowed: vi.fn(),
        requireCodexRuntime: vi.fn(() => runtime),
        validateSender: vi.fn(),
      } as never,
      restartRuntimeTerminal,
      withDevelopmentSessionOperation: (sessionId, operation) =>
        operations.run(sessionId, operation),
      workspace: {
        getStatus: vi.fn(() => ({ cwd: 'D:\\Project', ptyGeneration: 7 })),
      } as never,
    });

    const launch = ipc.invoke(CHANNELS.CODEX_LAUNCH, 'session-1', 'new');
    await vi.waitFor(() => expect(runtime.prepareLaunch).toHaveBeenCalledOnce());
    expect(operations.isBusy('session-1')).toBe(true);

    const invalidated = operations.invalidateAndWait('session-1');
    preparation.resolve({
      command: 'codex',
      environment: { CODEX_HOME: 'D:\\Codex' },
      predecessorPtyGeneration: 7,
    });

    await expect(launch).resolves.toMatchObject({ ok: false });
    await invalidated;
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
      prepareProvider: async () => {
        prepareCount += 1;
        calls.push(`prepare:${prepareCount}`);
        if (prepareCount === 1) await releaseFirstPreparation.promise;
      },
      sessionsForDirectory: () => [session],
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

  it('threads lease ownership into model commands and blocks a late submit after cancellation', async () => {
    const runtime = Object.create(ClaudeRuntime.prototype) as ClaudeRuntime;
    const runtimeSession = { sessionId: 'session-1' };
    const assertCurrent = vi.fn();
    const submitClaudeCommand = vi.fn(async () => undefined);
    const switchInternals = runtime as unknown as {
      assertRuntimePty: () => void;
      captureConversationPreferences: () => void;
      configStore: { getConfig: () => { model: string } };
      diagnoseInstallation: () => Promise<{ version: string }>;
      ensureSession: () => typeof runtimeSession;
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
    switchInternals.getModelOptions = vi.fn(async () => ({
      options: [{ id: 'current', model: 'target-model', requiresRelaunch: false }],
    }));
    switchInternals.assertRuntimePty = vi.fn();
    switchInternals.diagnoseInstallation = vi.fn(async () => ({ version: '2.1.221' }));
    switchInternals.configStore = { getConfig: () => ({ model: 'old-model' }) };
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
    expect(writes).toEqual(['/model target-model']);
  });
});
