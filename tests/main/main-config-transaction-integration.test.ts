import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeProjectState,
  SaveClaudeConfigInput,
  SaveClaudeRouterProviderInput,
} from '../../src/shared/contracts';
import type {
  ClaudeProjectConfigTransactionOptions,
  RunClaudeProjectConfigTransaction,
} from '../../src/main/claude/config-transaction';
import type { SavedRouterProvider } from '../../src/main/claude/router-manager';
import type { PreparedClaudeConfigSave } from '../../src/main/claude/runtime';
import {
  OwnedConfigTransactionError,
  runOwnedConfigTransaction,
  SessionConfigTransactionCoordinator,
} from '../../src/main/coordination/main-process-operation';
import { LaunchPreflightDecisionCoordinator } from '../../src/main/coordination/launch-preflight-decision';
import {
  SessionOperationCoordinator,
  type WithSessionOperation,
} from '../../src/main/coordination/session-operation';
import type { RestartRuntimeTerminal } from '../../src/main/terminal/lifecycle';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { createIpcHarness } from '../helpers/ipc-harness';
import {
  createTestMainServiceRegistry,
  registerTestService,
} from '../helpers/main-service-registry';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const assertOrder = (calls: readonly string[], label: string, steps: readonly string[]): void => {
  let previous = -1;
  for (const step of steps) {
    const marker = `${label}:${step}`;
    const index = calls.indexOf(marker);
    expect(index, `missing call: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
};

const registerClaudeRelaunchHarness = async (input: {
  restartRuntimeTerminal: RestartRuntimeTerminal;
  runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction;
  runtime: object;
  withDevelopmentSessionOperation: WithSessionOperation;
  withOfficialProviderAccess: (
    request: { action: string; cwd: string; provider: string },
    operation: () => Promise<unknown> | unknown,
  ) => Promise<unknown>;
}) => {
  const ipc = createIpcHarness();
  vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
  const { registerClaudeLaunchIpc } = await import('../../src/main/ipc/claude-launch');
  const developmentSessionOperations = new SessionOperationCoordinator(() => true);
  const runtime = {
    assertConnectionHistoryBaselineCurrent: vi.fn(),
    assertLaunchConfigurationBaselineCurrent: vi.fn(),
    assertRuntimeLaunchBaselineCurrent: vi.fn(),
    captureConnectionHistoryBaseline: vi.fn(() => ({})),
    captureLaunchConfigurationBaseline: vi.fn(() => ({})),
    captureRuntimeLaunchBaseline: vi.fn(() => ({})),
    ...input.runtime,
  };
  registerClaudeLaunchIpc({
    agentRuntimeStore: { get: vi.fn(() => 'claude') } as never,
    claudeConversationLifecycle: {} as never,
    claudeFailure: vi.fn((_sessionId, error) => ({
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    })) as never,
    conversationOwnerRegistry: {} as never,
    developmentSessionOperations,
    failedRuntimeLaunchCleanupDependencies: {
      hasSession: vi.fn(() => false),
      stopIfGeneration: vi.fn(),
    },
    guards: {
      assertLaunchAdmissionAllowed: vi.fn(),
      requireClaudeRuntime: vi.fn(() => runtime),
      validateSender: vi.fn(),
      withOfficialProviderAccess: input.withOfficialProviderAccess,
    } as never,
    launchPreflightDecisions: new LaunchPreflightDecisionCoordinator(),
    releaseTerminalConversationOwner: vi.fn(),
    restartRuntimeTerminal: input.restartRuntimeTerminal,
    runClaudeProjectConfigTransaction: input.runClaudeProjectConfigTransaction,
    runClaudeResumeLaunch: vi.fn(),
    terminalConversationOwners: new Map(),
    withDevelopmentSessionOperation: input.withDevelopmentSessionOperation,
    withDevelopmentSessionOperationIfStampCurrent: (stamp, operation) =>
      developmentSessionOperations.runIfStampCurrent(stamp, operation),
    withLaunchDecisionSessionOperation: input.withDevelopmentSessionOperation,
    workspace: {
      getStatus: vi.fn(() => ({ cwd: 'D:\\Project', id: 'session-1', ptyGeneration: 7 })),
    } as never,
  });
  return ipc;
};

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('main project-config transaction integration', () => {
  it('reserves synchronously, prepares against the old profile, then commits before completion', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const preparation = deferred<{ route: string }>();
    const before = { credential: 'old-key', nested: { revision: 1 }, route: 'legacy' };
    let profile = structuredClone(before);
    const calls: string[] = [];

    const execution = runOwnedConfigTransaction({
      assertOperationOwnership: vi.fn(),
      commit: (prepared) => {
        calls.push('commit');
        profile = { credential: 'new-key', nested: { revision: 2 }, route: prepared.route };
      },
      complete: async () => {
        calls.push('complete');
        expect(profile).toEqual({
          credential: 'new-key',
          nested: { revision: 2 },
          route: 'managed',
        });
        return { route: profile.route };
      },
      coordinator,
      createSnapshot: () => structuredClone(profile),
      cwd: 'D:\\Project',
      prepare: async () => {
        calls.push('prepare');
        return preparation.promise;
      },
      readState: async () => ({ route: profile.route }),
      restoreSnapshot: (snapshot) => {
        profile = structuredClone(snapshot);
      },
      sessionId: 'session-1',
    });

    expect(() => coordinator.assertDevelopmentOperationAllowed('D:\\Project')).toThrow(
      '当前项目正在等待接入配置事务，请等待操作完成。',
    );
    await vi.waitFor(() => expect(calls).toEqual(['prepare']));
    expect(profile).toEqual(before);

    preparation.resolve({ route: 'managed' });

    await expect(execution).resolves.toEqual({ route: 'managed' });
    expect(calls).toEqual(['prepare', 'commit', 'complete']);
    expect(() => coordinator.assertDevelopmentOperationAllowed('D:\\Project')).not.toThrow();
  });

  it('restores and publishes the exact pre-save snapshot when post-commit completion fails', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const before = {
      credential: 'old-key',
      presentation: { label: 'Legacy relay' },
      route: 'legacy',
    };
    let profile = structuredClone(before);
    const calls: string[] = [];
    const published: Array<{ credential: string; route: string }> = [];
    const failure = new Error('new route failed validation');

    let captured: unknown;
    try {
      await runOwnedConfigTransaction({
        assertOperationOwnership: vi.fn(),
        commit: () => {
          calls.push('commit');
          profile = {
            credential: 'new-key',
            presentation: { label: 'Managed ChatGPT' },
            route: 'managed',
          };
        },
        complete: async () => {
          calls.push('complete');
          throw failure;
        },
        coordinator,
        createSnapshot: () => structuredClone(profile),
        cwd: 'D:\\Project',
        prepare: () => ({ route: 'managed' }),
        publishRestoredState: (state) => {
          calls.push('publish');
          published.push(state);
        },
        readState: async () => {
          calls.push('read');
          return { credential: profile.credential, route: profile.route };
        },
        restoreSnapshot: (snapshot) => {
          calls.push('restore');
          profile = structuredClone(snapshot);
        },
        sessionId: 'session-1',
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(OwnedConfigTransactionError);
    const transactionError = captured as OwnedConfigTransactionError<{
      credential: string;
      route: string;
    }>;
    expect(transactionError.originalError).toBe(failure);
    expect(transactionError.restored).toBe(true);
    expect(transactionError.recoveryError).toBeUndefined();
    expect(transactionError.state).toEqual({ credential: 'old-key', route: 'legacy' });
    expect(profile).toEqual(before);
    expect(published).toEqual([{ credential: 'old-key', route: 'legacy' }]);
    expect(calls).toEqual(['commit', 'complete', 'restore', 'read', 'publish']);
  });

  it('rolls back completion-owned history recency after later completion failure', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const before = { config: 'original', history: ['older', 'selected'] };
    let profile = structuredClone(before);
    let captured: unknown;

    try {
      await runOwnedConfigTransaction({
        assertOperationOwnership: vi.fn(),
        commit: () => {
          profile.config = 'selected';
        },
        complete: async () => {
          profile.history = ['selected', 'older'];
          throw new Error('launch failed after history completion');
        },
        coordinator,
        createSnapshot: () => structuredClone(profile),
        cwd: 'D:\\Project',
        mergeCompletionSnapshot: (committed, completed) => ({
          config: committed.config,
          history: completed.history,
        }),
        prepare: () => undefined,
        readState: async () => structuredClone(profile),
        restoreSnapshot: (snapshot) => {
          profile = structuredClone(snapshot);
        },
        sessionId: 'session-1',
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(OwnedConfigTransactionError);
    expect((captured as OwnedConfigTransactionError<typeof profile>).restored).toBe(true);
    expect(profile).toEqual(before);
  });

  it('serializes equivalent project directories in reservation order', async () => {
    const coordinator = new SessionConfigTransactionCoordinator();
    const releaseFirst = deferred<void>();
    const calls: string[] = [];

    const first = coordinator.run('session-1', 'D:\\Project', async (ownership) => {
      calls.push('first:start');
      await releaseFirst.promise;
      ownership.assertCurrent();
      calls.push('first:end');
      ownership.commit();
      return 'first';
    });
    const second = coordinator.run('session-2', 'd:\\project\\.', async (ownership) => {
      calls.push('second:start');
      ownership.commit();
      calls.push('second:end');
      return 'second';
    });

    expect(() => coordinator.assertDevelopmentOperationAllowed('D:\\PROJECT')).toThrow();
    await vi.waitFor(() => expect(calls).toEqual(['first:start']));
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(calls).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('routes every project-profile IPC writer through session and directory ownership', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({
      ipcMain: ipc.ipcMain,
      shell: { openExternal: vi.fn(async () => undefined) },
    }));
    const [{ registerClaudeConnectionIpc }, { registerClaudeLaunchIpc }, { registerRouterIpc }] =
      await Promise.all([
        import('../../src/main/ipc/claude-connection'),
        import('../../src/main/ipc/claude-launch'),
        import('../../src/main/ipc/router'),
      ]);

    const calls: string[] = [];
    let active = 'idle';
    const projectState = {
      config: { model: 'saved-model', preset: 'gateway' },
    } as unknown as ClaudeProjectState;
    const routerState = { gatewayState: 'running' } as SavedRouterProvider['state'];
    const savedProvider = {
      connection: {
        apiKey: 'router-key',
        baseUrl: 'http://127.0.0.1:3456',
        model: 'saved-model',
      },
      provider: { id: 'provider-1', name: 'Provider 1' },
      state: routerState,
    } as SavedRouterProvider;
    const prepared = { input: { model: 'saved-model' } } as unknown as PreparedClaudeConfigSave;
    const launchAuthorization = {
      cwdKey: 'd:\\project',
      launchSnapshot: {},
      officialNetworkProvider: undefined,
    };
    const historyAuthorization = {
      cwdKey: 'd:\\project',
      entryId: 'history-abc-123',
      officialNetworkProvider: undefined,
      replay: {},
    };
    const runtime = {
      assertConnectionHistoryAuthorizationCurrent: vi.fn(),
      assertConnectionHistoryBaselineCurrent: vi.fn(),
      assertLaunchAuthorizationCurrent: vi.fn(),
      assertLaunchConfigurationBaselineCurrent: vi.fn(),
      assertRuntimeLaunchBaselineCurrent: vi.fn(),
      captureConnectionHistoryAuthorization: vi.fn(() => historyAuthorization),
      captureConnectionHistoryBaseline: vi.fn(() => ({})),
      captureLaunchAuthorization: vi.fn(() => launchAuthorization),
      captureLaunchConfigurationBaseline: vi.fn(() => ({})),
      captureRuntimeLaunchBaseline: vi.fn(() => ({})),
      commitAllowBypassPermissions: vi.fn(() => {
        calls.push(`${active}:commit-bypass`);
      }),
      commitPreparedConfig: vi.fn(() => {
        calls.push(`${active}:commit-profile`);
      }),
      compactBeforeRelaunch: vi.fn(async () => calls.push(`${active}:compact`)),
      completePreparedConfigSave: vi.fn(async () => {
        calls.push(`${active}:complete-profile`);
        return projectState;
      }),
      connectionHistoryOfficialNetworkProvider: vi.fn(() => undefined),
      getConnectionHistory: vi.fn(() => []),
      getRouterManagementState: vi.fn(async () => routerState),
      getState: vi.fn(async () => {
        calls.push(`${active}:get-state`);
        return projectState;
      }),
      isActive: vi.fn(() => false),
      officialNetworkProvider: vi.fn(() => undefined),
      officialNetworkProviderForActivePty: vi.fn(() => undefined),
      prepareConnectionConfig: vi.fn(async () => {
        calls.push(`${active}:prepare-config`);
        return prepared;
      }),
      prepareConnectionHistory: vi.fn(async () => {
        calls.push(`${active}:prepare-history`);
        return prepared;
      }),
      prepareAuthorizedConnectionHistory: vi.fn(async () => {
        calls.push(`${active}:prepare-history`);
        return prepared;
      }),
      prepareLaunch: vi.fn(async () => {
        calls.push(`${active}:prepare-launch`);
        return {
          command: 'claude --continue',
          environment: { CLAUDE_ROUTE: 'saved' },
          predecessorPtyGeneration: 3,
          token: {},
        };
      }),
      prepareRouterProjectConfig: vi.fn(() => {
        calls.push(`${active}:prepare-router`);
        return prepared;
      }),
      publishProjectState: vi.fn(async () => {
        calls.push(`${active}:publish`);
        return projectState;
      }),
      repairRouterProviderFromProject: vi.fn(async () => {
        calls.push(`${active}:repair-provider`);
        return savedProvider;
      }),
      saveRouterProvider: vi.fn(async () => {
        calls.push(`${active}:save-provider`);
        return savedProvider;
      }),
    };
    let transactionCount = 0;
    const runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction = async <TPrepared>(
      options: ClaudeProjectConfigTransactionOptions<TPrepared>,
    ): Promise<ClaudeProjectState> => {
      transactionCount += 1;
      calls.push(`${active}:directory`);
      const preparedValue = await options.prepare();
      const commitResult = options.commit(preparedValue);
      expect(commitResult).toBeUndefined();
      return options.complete(preparedValue);
    };
    const withDevelopmentSessionOperation: WithSessionOperation = async <T>(
      _sessionId: string,
      operation: Parameters<WithSessionOperation>[1],
    ): Promise<T> => {
      calls.push(`${active}:session`);
      return operation(vi.fn(), new AbortController().signal) as Promise<T>;
    };
    const developmentSessionOperations = new SessionOperationCoordinator(() => true);
    const restartRuntimeTerminal: RestartRuntimeTerminal = (
      _runtime,
      _sessionId,
      environment,
      _command,
      _failureMessage,
      _assertCurrent,
      ownGeneration,
    ) => {
      calls.push(`${active}:restart`);
      expect(environment).toEqual({ CLAUDE_ROUTE: 'saved' });
      ownGeneration(4);
      return {} as ReturnType<RestartRuntimeTerminal>;
    };
    const workspace = {
      getStatus: vi.fn(() => ({ cwd: 'D:\\Project', id: 'session-1', ptyGeneration: 3 })),
    };
    const guards = {
      assertLaunchAdmissionAllowed: vi.fn(),
      withOfficialProviderAccess: vi.fn(async (_request, operation) => operation()),
      requireCcSwitchAdapter: vi.fn(() => ({})),
      requireClaudeRuntime: vi.fn(() => runtime),
      validateSender: vi.fn(),
    };
    const services = await createTestMainServiceRegistry();
    const { BUSY_REGISTRY } = await import('../../src/main/infra/service-tokens');
    registerTestService(services, BUSY_REGISTRY, {
      acquire: vi.fn(() => vi.fn()),
    } as never);

    registerClaudeConnectionIpc({
      claudeFailure: vi.fn((_sessionId, error) => ({
        error: error instanceof Error ? error.message : 'failure',
        ok: false,
      })) as never,
      configTransactionState: vi.fn(),
      guards: guards as never,
      runClaudeProjectConfigTransaction,
      withDevelopmentSessionOperation,
      workspace: workspace as never,
    });
    registerRouterIpc({
      configTransactionState: vi.fn(),
      guards: guards as never,
      runClaudeProjectConfigTransaction,
      services,
      withDevelopmentSessionOperation,
      workspace: workspace as never,
    });
    registerClaudeLaunchIpc({
      agentRuntimeStore: { get: vi.fn(() => 'claude') } as never,
      claudeConversationLifecycle: {} as never,
      claudeFailure: vi.fn((_sessionId, error) => ({
        error: error instanceof Error ? error.message : 'failure',
        ok: false,
      })) as never,
      conversationOwnerRegistry: {} as never,
      developmentSessionOperations,
      failedRuntimeLaunchCleanupDependencies: {} as never,
      guards: guards as never,
      launchPreflightDecisions: new LaunchPreflightDecisionCoordinator(),
      releaseTerminalConversationOwner: vi.fn(),
      restartRuntimeTerminal,
      runClaudeProjectConfigTransaction,
      runClaudeResumeLaunch: vi.fn(),
      terminalConversationOwners: new Map(),
      withDevelopmentSessionOperation,
      withDevelopmentSessionOperationIfStampCurrent: (stamp, operation) =>
        developmentSessionOperations.runIfStampCurrent(stamp, operation),
      withLaunchDecisionSessionOperation: withDevelopmentSessionOperation,
      workspace: workspace as never,
    });

    const configInput: SaveClaudeConfigInput = {
      authMode: 'authToken',
      baseUrl: 'https://relay.example.com',
      credential: 'token',
      credentialAction: 'replace',
      model: 'saved-model',
      preset: 'custom',
      provider: 'gateway',
    };
    const providerInput: SaveClaudeRouterProviderInput = {
      apiKey: 'upstream-key',
      baseUrl: 'https://relay.example.com/v1',
      credentialAction: 'replace',
      makePreferred: true,
      models: ['saved-model'],
      name: 'Provider 1',
      protocol: 'openai_chat_completions',
      useForCurrentProject: true,
    };

    active = 'router-repair';
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_ROUTER_REPAIR_FROM_PROJECT, 'session-1'),
    ).resolves.toMatchObject({ ok: true, projectState });
    assertOrder(calls, active, [
      'session',
      'directory',
      'repair-provider',
      'prepare-router',
      'commit-profile',
      'complete-profile',
    ]);

    active = 'router-save';
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_ROUTER_SAVE_PROVIDER, 'session-1', providerInput),
    ).resolves.toMatchObject({ ok: true, projectState });
    assertOrder(calls, active, [
      'session',
      'directory',
      'save-provider',
      'prepare-router',
      'commit-profile',
      'complete-profile',
    ]);

    active = 'config-save';
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_SAVE_CONFIG, 'session-1', configInput),
    ).resolves.toMatchObject({ ok: true, state: projectState });
    assertOrder(calls, active, [
      'session',
      'directory',
      'prepare-config',
      'commit-profile',
      'complete-profile',
    ]);

    active = 'history-apply';
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_CONNECTION_HISTORY_APPLY, 'session-1', 'history-abc-123'),
    ).resolves.toMatchObject({ ok: true, state: projectState });
    assertOrder(calls, active, [
      'session',
      'directory',
      'prepare-history',
      'commit-profile',
      'complete-profile',
    ]);

    active = 'history-relaunch';
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_RELAUNCH, 'session-1', {
        compactFirst: true,
        entryId: 'history-abc-123',
      }),
    ).resolves.toMatchObject({
      result: { ok: true, state: projectState },
      status: 'completed',
    });
    assertOrder(calls, active, [
      'session',
      'directory',
      'compact',
      'prepare-history',
      'commit-profile',
      'complete-profile',
      'prepare-launch',
      'restart',
      'get-state',
    ]);

    active = 'bypass-save';
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_SET_ALLOW_BYPASS_PERMISSIONS, 'session-1', true),
    ).resolves.toMatchObject({ ok: true, state: projectState });
    assertOrder(calls, active, ['session', 'directory', 'commit-bypass', 'publish']);

    const ownedTransactionCount = transactionCount;
    active = 'router-save-only';
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_ROUTER_SAVE_PROVIDER, 'session-1', {
        ...providerInput,
        useForCurrentProject: false,
      }),
    ).resolves.toMatchObject({ ok: true, projectState: undefined });
    expect(transactionCount).toBe(ownedTransactionCount);
    expect(calls).toContain('router-save-only:save-provider');
    expect(calls).not.toContain('router-save-only:session');
    expect(calls).not.toContain('router-save-only:directory');
  });

  it('rejects a cancelled history relaunch before reserving its config transaction', async () => {
    const operations = new SessionOperationCoordinator(() => true);
    const runClaudeProjectConfigTransaction =
      vi.fn() as unknown as RunClaudeProjectConfigTransaction;
    const historyAuthorization = {
      cwdKey: 'd:\\project',
      entryId: 'history-abc-123',
      officialNetworkProvider: 'anthropic-claude',
      replay: {},
    };
    const runtime = {
      captureConnectionHistoryAuthorization: vi.fn(() => historyAuthorization),
      compactBeforeRelaunch: vi.fn(async () => undefined),
      isActive: vi.fn(() => true),
      officialNetworkProviderForActivePty: vi.fn(() => 'openai-codex'),
    };
    const withOfficialProviderAccess = vi.fn(
      async (
        _request: { action: string; cwd: string; provider: string },
        operation: () => Promise<unknown> | unknown,
      ): Promise<unknown> => {
        operations.invalidate('session-1');
        return operation();
      },
    );
    const ipc = await registerClaudeRelaunchHarness({
      restartRuntimeTerminal: vi.fn() as unknown as RestartRuntimeTerminal,
      runClaudeProjectConfigTransaction,
      runtime,
      withDevelopmentSessionOperation: (sessionId, operation) =>
        operations.run(sessionId, operation),
      withOfficialProviderAccess,
    });

    await expect(
      ipc.invoke(CHANNELS.CLAUDE_RELAUNCH, 'session-1', {
        compactFirst: false,
        entryId: 'history-abc-123',
      }),
    ).resolves.toMatchObject({ result: { ok: false }, status: 'completed' });

    expect(withOfficialProviderAccess).toHaveBeenCalledOnce();
    expect(runClaudeProjectConfigTransaction).not.toHaveBeenCalled();
    expect(operations.isBusy('session-1')).toBe(false);
  });

  it('does not compact or reserve a transaction when target provider access is denied', async () => {
    const runClaudeProjectConfigTransaction =
      vi.fn() as unknown as RunClaudeProjectConfigTransaction;
    const denied = new Error('target access denied');
    const runtime = {
      captureConnectionHistoryAuthorization: vi.fn(() => ({
        cwdKey: 'd:\\project',
        entryId: 'history-abc-123',
        officialNetworkProvider: 'openai-codex',
        replay: {},
      })),
      compactBeforeRelaunch: vi.fn(async () => undefined),
      isActive: vi.fn(() => true),
      officialNetworkProviderForActivePty: vi.fn(() => 'anthropic-claude'),
    };
    const withOfficialProviderAccess = vi.fn(async () => {
      throw denied;
    });
    const ipc = await registerClaudeRelaunchHarness({
      restartRuntimeTerminal: vi.fn() as unknown as RestartRuntimeTerminal,
      runClaudeProjectConfigTransaction,
      runtime,
      withDevelopmentSessionOperation: async (_sessionId, operation) =>
        operation(vi.fn(), new AbortController().signal),
      withOfficialProviderAccess,
    });

    await expect(
      ipc.invoke(CHANNELS.CLAUDE_RELAUNCH, 'session-1', {
        compactFirst: true,
        entryId: 'history-abc-123',
      }),
    ).resolves.toMatchObject({
      result: { error: denied.message, ok: false },
      status: 'completed',
    });

    expect(runtime.compactBeforeRelaunch).not.toHaveBeenCalled();
    expect(runtime.officialNetworkProviderForActivePty).not.toHaveBeenCalled();
    expect(runClaudeProjectConfigTransaction).not.toHaveBeenCalled();
  });

  it('revalidates history only after the queued transaction predecessor completes', async () => {
    const transactionEntered = deferred<void>();
    const releaseTransaction = deferred<void>();
    let historyCurrent = true;
    const historyAuthorization = {
      cwdKey: 'd:\\project',
      entryId: 'history-abc-123',
      officialNetworkProvider: undefined,
      replay: {},
    };
    const runtime = {
      assertConnectionHistoryAuthorizationCurrent: vi.fn(() => {
        if (!historyCurrent) throw new Error('history changed while queued');
      }),
      captureConnectionHistoryAuthorization: vi.fn(() => historyAuthorization),
      compactBeforeRelaunch: vi.fn(async () => undefined),
      isActive: vi.fn(() => true),
      prepareAuthorizedConnectionHistory: vi.fn(async () => ({})),
    };
    const runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction = async (
      options,
    ) => {
      transactionEntered.resolve(undefined);
      await releaseTransaction.promise;
      await options.prepare();
      return {} as ClaudeProjectState;
    };
    const ipc = await registerClaudeRelaunchHarness({
      restartRuntimeTerminal: vi.fn() as unknown as RestartRuntimeTerminal,
      runClaudeProjectConfigTransaction,
      runtime,
      withDevelopmentSessionOperation: async (_sessionId, operation) =>
        operation(vi.fn(), new AbortController().signal),
      withOfficialProviderAccess: vi.fn(async (_request, operation) => operation()),
    });

    const relaunch = ipc.invoke(CHANNELS.CLAUDE_RELAUNCH, 'session-1', {
      compactFirst: true,
      entryId: 'history-abc-123',
    });
    await transactionEntered.promise;
    historyCurrent = false;
    releaseTransaction.resolve(undefined);

    await expect(relaunch).resolves.toMatchObject({
      result: {
        error: 'history changed while queued',
        ok: false,
      },
      status: 'completed',
    });
    expect(runtime.compactBeforeRelaunch).not.toHaveBeenCalled();
    expect(runtime.prepareAuthorizedConnectionHistory).not.toHaveBeenCalled();
  });

  it('enters the selected history provider before authorizing compaction with the live PTY provider', async () => {
    const state = {
      active: true,
      cwd: 'D:\\Project',
      sessionId: 'session-1',
    } as ClaudeProjectState;
    const events: string[] = [];
    let activeProvider: string | undefined;
    const selectedProvider = 'openai-codex';
    const prepared = { input: { model: 'selected-model' } } as unknown as PreparedClaudeConfigSave;
    const historyAuthorization = {
      cwdKey: 'd:\\project',
      entryId: 'history-abc-123',
      officialNetworkProvider: selectedProvider,
      replay: {},
    };
    const launchAuthorization = {
      cwdKey: 'd:\\project',
      launchSnapshot: {},
      officialNetworkProvider: selectedProvider,
    };
    const runtime = {
      assertConnectionHistoryAuthorizationCurrent: vi.fn(),
      assertLaunchAuthorizationCurrent: vi.fn(),
      captureConnectionHistoryAuthorization: vi.fn(() => {
        events.push(`history-provider:${selectedProvider}`);
        return historyAuthorization;
      }),
      captureLaunchAuthorization: vi.fn(() => launchAuthorization),
      commitPreparedConfig: vi.fn(() => events.push(`commit:${activeProvider}`)),
      compactBeforeRelaunch: vi.fn(async (_sessionId, _cwd, compactFirst) => {
        events.push(`compact:${String(compactFirst)}`);
        expect(activeProvider).toBe('anthropic-claude');
      }),
      completePreparedConfigSave: vi.fn(async () => {
        events.push(`complete:${activeProvider}`);
        return {} as ClaudeProjectState;
      }),
      getState: vi.fn(async () => {
        events.push(`get-state:${activeProvider}`);
        return state;
      }),
      isActive: vi.fn(() => true),
      officialNetworkProviderForActivePty: vi.fn((_sessionId, generation) => {
        events.push(`live-provider:${String(generation)}`);
        return 'anthropic-claude';
      }),
      prepareAuthorizedConnectionHistory: vi.fn(async () => {
        events.push(`prepare-history:${activeProvider}`);
        return prepared;
      }),
      prepareLaunch: vi.fn(async () => {
        events.push(`prepare-launch:${activeProvider}`);
        return {
          command: 'claude --continue',
          environment: { CLAUDE_ROUTE: 'selected' },
          predecessorPtyGeneration: 7,
          token: {},
        };
      }),
    };
    const withOfficialProviderAccess = vi.fn(
      async (
        request: { action: string; cwd: string; provider: string },
        operation: () => Promise<unknown> | unknown,
      ): Promise<unknown> => {
        events.push(`lease:${request.provider}:start`);
        const previousProvider = activeProvider;
        activeProvider = request.provider;
        try {
          return await operation();
        } finally {
          activeProvider = previousProvider;
          events.push(`lease:${request.provider}:end`);
        }
      },
    );
    const runClaudeProjectConfigTransaction: RunClaudeProjectConfigTransaction = async <TPrepared>(
      options: ClaudeProjectConfigTransactionOptions<TPrepared>,
    ): Promise<ClaudeProjectState> => {
      events.push('transaction');
      expect(activeProvider).toBe('openai-codex');
      const preparedValue = await options.prepare();
      options.commit(preparedValue);
      return options.complete(preparedValue);
    };
    const restartRuntimeTerminal: RestartRuntimeTerminal = (
      _runtime,
      _sessionId,
      _environment,
      _command,
      _failureMessage,
      _assertCurrent,
      ownGeneration,
    ) => {
      events.push(`restart:${activeProvider}`);
      ownGeneration(8);
      return {} as ReturnType<RestartRuntimeTerminal>;
    };
    const ipc = await registerClaudeRelaunchHarness({
      restartRuntimeTerminal,
      runClaudeProjectConfigTransaction,
      runtime,
      withDevelopmentSessionOperation: async (_sessionId, operation) =>
        operation(vi.fn(), new AbortController().signal),
      withOfficialProviderAccess,
    });

    await expect(
      ipc.invoke(CHANNELS.CLAUDE_RELAUNCH, 'session-1', {
        compactFirst: true,
        entryId: 'history-abc-123',
      }),
    ).resolves.toMatchObject({ result: { ok: true, state }, status: 'completed' });

    expect(runtime.officialNetworkProviderForActivePty).toHaveBeenCalledWith('session-1', 7);
    expect(events).toEqual([
      'history-provider:openai-codex',
      'lease:openai-codex:start',
      'transaction',
      'live-provider:7',
      'lease:anthropic-claude:start',
      'compact:true',
      'lease:anthropic-claude:end',
      'prepare-history:openai-codex',
      'commit:openai-codex',
      'complete:openai-codex',
      'prepare-launch:openai-codex',
      'restart:openai-codex',
      'get-state:openai-codex',
      'lease:openai-codex:end',
    ]);
  });

  it('does not acquire a live-provider lease when history compaction is disabled', async () => {
    const state = {
      active: true,
      cwd: 'D:\\Project',
      sessionId: 'session-1',
    } as ClaudeProjectState;
    const events: string[] = [];
    const liveProvider = vi.fn(() => 'openai-codex');
    const withOfficialProviderAccess = vi.fn(
      async (
        request: { action: string; cwd: string; provider: string },
        operation: () => Promise<unknown> | unknown,
      ): Promise<unknown> => {
        events.push(`lease:${request.provider}`);
        return operation();
      },
    );
    const runClaudeProjectConfigTransaction = vi.fn(async (options) => {
      events.push('transaction');
      await options.prepare();
      return state;
    }) as unknown as RunClaudeProjectConfigTransaction;
    const historyAuthorization = {
      cwdKey: 'd:\\project',
      entryId: 'history-abc-123',
      officialNetworkProvider: 'anthropic-claude',
      replay: {},
    };
    const runtime = {
      assertConnectionHistoryAuthorizationCurrent: vi.fn(),
      captureConnectionHistoryAuthorization: vi.fn(() => historyAuthorization),
      compactBeforeRelaunch: vi.fn(async (_sessionId, _cwd, compactFirst) => {
        events.push(`compact:${String(compactFirst)}`);
      }),
      isActive: vi.fn(() => true),
      officialNetworkProviderForActivePty: liveProvider,
      prepareAuthorizedConnectionHistory: vi.fn(async () => ({})),
    };
    const ipc = await registerClaudeRelaunchHarness({
      restartRuntimeTerminal: vi.fn() as unknown as RestartRuntimeTerminal,
      runClaudeProjectConfigTransaction,
      runtime,
      withDevelopmentSessionOperation: async (_sessionId, operation) =>
        operation(vi.fn(), new AbortController().signal),
      withOfficialProviderAccess,
    });

    await expect(
      ipc.invoke(CHANNELS.CLAUDE_RELAUNCH, 'session-1', {
        compactFirst: false,
        entryId: 'history-abc-123',
      }),
    ).resolves.toMatchObject({ result: { ok: true, state }, status: 'completed' });

    expect(liveProvider).not.toHaveBeenCalled();
    expect(withOfficialProviderAccess).toHaveBeenCalledOnce();
    expect(events).toEqual(['lease:anthropic-claude', 'transaction', 'compact:false']);
  });
});
