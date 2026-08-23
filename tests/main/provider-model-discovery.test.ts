import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkPreflightResult } from '../../src/shared/contracts';
import { CHANNELS } from '../../src/shared/ipc/channels';
import { mainLogger } from '../../src/main/infra/logger';
import type { NetworkPreflightService } from '../../src/main/network/preflight-service';
import {
  ProviderAccessContextExpiredError,
  ProviderAccessGuard,
} from '../../src/main/network/provider-access-guard';
import {
  discoverOpenAiModels,
  ProviderModelDiscoveryError,
  parseOpenAiModelIds,
  resolveProviderModelDiscoveryTarget,
} from '../../src/main/network/provider-model-discovery';
import { createIpcHarness } from '../helpers/ipc-harness';

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

const allowedProviderAccessResult = {
  action: 'first-request',
  featureAccess: [{ action: 'first-request', allowed: true, reason: 'allowed' }],
  status: 'allowed',
} as unknown as NetworkPreflightResult;

const providerAccessRequest = {
  action: 'first-request' as const,
  cwd: 'D:\\Main-Owned\\Project',
  networkScope: 'application' as const,
  provider: 'anthropic-claude' as const,
  target: { process: 'application' as const, url: 'https://api.anthropic.com/v1/models' },
};

const createProviderAccessGuardHarness = () => {
  const leaseContext = Object.freeze({});
  let leaseActive = false;
  const runWithLease = vi.fn(async (_input, _target, operation) => {
    leaseActive = true;
    try {
      return await operation(allowedProviderAccessResult, leaseContext);
    } finally {
      leaseActive = false;
    }
  });
  const runWithExistingLease = vi.fn(async (_input, _target, context, operation) => {
    expect(context).toBe(leaseContext);
    expect(leaseActive).toBe(true);
    return await operation(allowedProviderAccessResult, leaseContext);
  });
  return {
    guard: new ProviderAccessGuard({
      runWithExistingLease,
      runWithLease,
    } as unknown as NetworkPreflightService),
    isLeaseActive: () => leaseActive,
    runWithExistingLease,
    runWithLease,
  };
};

type CapturedOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly reason: unknown; readonly status: 'rejected' };

const captureOutcome = <T>(promise: Promise<T>): Promise<CapturedOutcome<T>> =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ reason, status: 'rejected' }),
  );

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('provider model discovery', () => {
  it('deduplicates and validates model identifiers', () => {
    expect(
      parseOpenAiModelIds({
        data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-5.4-mini' }],
      }),
    ).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini']);
    expect(() => parseOpenAiModelIds({ data: [{ id: 'bad model name' }] })).toThrow('没有可用模型');
  });

  it('classifies only the main-derived exact official request target', () => {
    expect(resolveProviderModelDiscoveryTarget('https://api.anthropic.com/v1')).toEqual({
      endpoint: 'https://api.anthropic.com/v1/models',
      officialProvider: 'anthropic-claude',
    });
    expect(resolveProviderModelDiscoveryTarget('https://api.anthropic.com./v1')).toEqual({
      endpoint: 'https://api.anthropic.com./v1/models',
      officialProvider: 'anthropic-claude',
    });
    expect(resolveProviderModelDiscoveryTarget('https://api.openai.com/v1')).toEqual({
      endpoint: 'https://api.openai.com/v1/models',
      officialProvider: 'openai-api',
    });
    expect(resolveProviderModelDiscoveryTarget('https://chatgpt.com/backend-api/codex')).toEqual({
      endpoint: 'https://chatgpt.com/backend-api/codex/v1/models',
      officialProvider: 'openai-codex',
    });
    const lookalike = resolveProviderModelDiscoveryTarget(
      'https://api.anthropic.com.example.test/v1',
    );
    expect(lookalike).toEqual({ endpoint: 'https://api.anthropic.com.example.test/v1/models' });
    expect(Object.isFrozen(lookalike)).toBe(true);
  });

  it('requests the derived models endpoint with the supplied bearer credential', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'model-a' }, { id: 'secret-value' }, { id: 'model-b' }] }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
    );
    await expect(
      discoverOpenAiModels(
        'https://relay.example.com/openai/v1/chat/completions',
        'secret-value',
        fetchImplementation as unknown as typeof fetch,
      ),
    ).resolves.toEqual(['model-a', 'model-b']);
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://relay.example.com/openai/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-value' },
        redirect: 'error',
      }),
    );
  });

  it('reports authentication failures without echoing the credential', async () => {
    const fetchImplementation = vi.fn(async () => new Response('', { status: 401 }));
    await expect(
      discoverOpenAiModels(
        'https://relay.example.com/v1',
        'do-not-echo',
        fetchImplementation as unknown as typeof fetch,
      ),
    ).rejects.toThrow('拒绝了当前密钥');
    await discoverOpenAiModels(
      'https://relay.example.com/v1',
      'do-not-echo',
      fetchImplementation as unknown as typeof fetch,
    ).catch((error: unknown) => {
      expect(String(error)).not.toContain('do-not-echo');
    });
  });

  it('converts unexpected transport failures to credential-safe typed errors', async () => {
    const credential = 'transport-secret-sentinel';
    const fetchImplementation = vi.fn(async () => {
      throw new Error(`socket failed after Authorization: Bearer ${credential}`);
    });

    const failure = await discoverOpenAiModels(
      'https://relay.example.com/v1',
      credential,
      fetchImplementation as unknown as typeof fetch,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderModelDiscoveryError);
    expect(String(failure)).not.toContain(credential);
    expect(String(failure)).toContain('无法读取当前接口的模型列表');
  });

  it('stops reading oversized model catalogs', async () => {
    const fetchImplementation = vi.fn(
      async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
    );
    await expect(
      discoverOpenAiModels(
        'https://relay.example.com/v1',
        undefined,
        fetchImplementation as unknown as typeof fetch,
      ),
    ).rejects.toThrow('安全大小上限');
  });

  it('guards official IPC discovery while leaving local discovery direct and safe', async () => {
    const ipc = createIpcHarness();
    vi.doMock('electron', () => ({ ipcMain: ipc.ipcMain }));
    const [{ registerClaudeStateIpc }, { ProviderAccessBlockedError }] = await Promise.all([
      import('../../src/main/ipc/claude-state'),
      import('../../src/main/network/provider-access-guard'),
    ]);
    const credential = 'renderer-credential-sentinel';
    const cwd = 'D:\\Main-Owned\\Project';
    let providerAccessActive = false;
    const discoverProviderModels = vi.fn();
    const withOfficialProviderAccess = vi.fn(async (_request, operation) => {
      providerAccessActive = true;
      try {
        return await operation();
      } finally {
        providerAccessActive = false;
      }
    });
    const getStatus = vi.fn((sessionId: string) => {
      if (sessionId === 'session-2') {
        throw new Error(`disposed session included ${credential}`);
      }
      return { cwd, ptyGeneration: 1 };
    });

    registerClaudeStateIpc({
      guards: {
        requireClaudeRuntime: vi.fn(() => ({ discoverProviderModels }) as never),
        requireManagedChatGptGateway: vi.fn(() => ({}) as never),
        validateSender: vi.fn(),
        withOfficialProviderAccess: withOfficialProviderAccess as never,
      },
      workspace: { getStatus } as never,
    });

    let completeOfficialDiscovery: (() => void) | undefined;
    const modelsThenable = {
      then: (resolve: (models: string[]) => void) => {
        completeOfficialDiscovery = () => resolve(['claude-model-a']);
      },
    };
    discoverProviderModels.mockImplementationOnce(() => {
      expect(providerAccessActive).toBe(true);
      return modelsThenable;
    });
    const officialRequest = ipc.invoke(CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER, 'session-1', {
      baseUrl: 'https://api.anthropic.com/v1',
      credential,
    });
    await vi.waitFor(() => expect(completeOfficialDiscovery).toBeTypeOf('function'));
    expect(providerAccessActive).toBe(true);
    completeOfficialDiscovery?.();
    await expect(officialRequest).resolves.toEqual({
      message: '已从当前接口读取 1 个可用模型。',
      models: ['claude-model-a'],
      ok: true,
    });
    expect(providerAccessActive).toBe(false);
    expect(withOfficialProviderAccess).toHaveBeenNthCalledWith(
      1,
      {
        action: 'first-request',
        cwd,
        networkScope: 'application',
        provider: 'anthropic-claude',
        target: { process: 'application', url: 'https://api.anthropic.com/v1/models' },
      },
      expect.any(Function),
    );
    expect(discoverProviderModels).toHaveBeenNthCalledWith(
      1,
      {
        endpoint: 'https://api.anthropic.com/v1/models',
        officialProvider: 'anthropic-claude',
      },
      credential,
    );
    expect(JSON.stringify(withOfficialProviderAccess.mock.calls[0]?.[0])).not.toContain(credential);

    discoverProviderModels.mockImplementationOnce(async () => {
      expect(providerAccessActive).toBe(false);
      return ['local-model'];
    });
    await expect(
      ipc.invoke(CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER, 'session-1', {
        baseUrl: 'http://127.0.0.1:11434',
      }),
    ).resolves.toEqual({
      message: '已从当前接口读取 1 个可用模型。',
      models: ['local-model'],
      ok: true,
    });
    expect(withOfficialProviderAccess).toHaveBeenCalledOnce();
    expect(discoverProviderModels).toHaveBeenNthCalledWith(
      2,
      { endpoint: 'http://127.0.0.1:11434/v1/models' },
      undefined,
    );

    const blocked = new ProviderAccessBlockedError(
      {
        action: 'first-request',
        canonicalCwd: cwd,
        configurationRevision: 'main-owned-revision',
        featureAccess: [{ action: 'first-request', allowed: false, reason: 'blocked' }],
        generation: 3,
        mainRunId: 7,
        networkScope: 'application',
        provider: 'anthropic-claude',
        reasons: ['blocked'],
        status: 'blocked',
        summary: 'blocked',
      } as unknown as NetworkPreflightResult,
      { process: 'application', url: 'https://api.anthropic.com/v1/models' },
    );
    const callsBeforeBlock = discoverProviderModels.mock.calls.length;
    withOfficialProviderAccess.mockRejectedValueOnce(blocked);
    const blockedResult = await ipc.invoke(CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER, 'session-1', {
      baseUrl: 'https://api.anthropic.com/v1',
      credential,
    });
    expect(blockedResult).toMatchObject({
      error: expect.stringContaining('网络预检阻止'),
      kind: 'environment',
      models: [],
      ok: false,
    });
    expect(JSON.stringify(blockedResult)).not.toContain(credential);
    expect(discoverProviderModels).toHaveBeenCalledTimes(callsBeforeBlock);

    const callsBeforeForgery = discoverProviderModels.mock.calls.length;
    const guardsBeforeForgery = withOfficialProviderAccess.mock.calls.length;
    const statusReadsBeforeForgery = getStatus.mock.calls.length;
    const forgedResult = await ipc.invoke(CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER, 'session-1', {
      action: 'background',
      baseUrl: 'https://api.anthropic.com/v1',
      configurationRevision: 'renderer-controlled',
      credential,
      cwd: 'D:\\Forged',
      endpoint: 'https://example.test/v1/models',
      mainRunId: 999,
      provider: 'openai-api',
      target: { process: 'application', url: 'https://example.test/v1/models' },
      transport: 'renderer-fetch',
    } as never);
    expect(forgedResult).toMatchObject({ models: [], ok: false });
    expect(JSON.stringify(forgedResult)).not.toContain(credential);
    expect(discoverProviderModels).toHaveBeenCalledTimes(callsBeforeForgery);
    expect(withOfficialProviderAccess).toHaveBeenCalledTimes(guardsBeforeForgery);
    expect(getStatus).toHaveBeenCalledTimes(statusReadsBeforeForgery);

    const callsBeforeDisposed = discoverProviderModels.mock.calls.length;
    const guardsBeforeDisposed = withOfficialProviderAccess.mock.calls.length;
    const disposedResult = await ipc.invoke(CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER, 'session-2', {
      baseUrl: 'https://api.anthropic.com/v1',
      credential,
    });
    expect(disposedResult).toMatchObject({
      error: '无法读取当前接口的模型列表。',
      models: [],
      ok: false,
    });
    expect(JSON.stringify(disposedResult)).not.toContain(credential);
    expect(discoverProviderModels).toHaveBeenCalledTimes(callsBeforeDisposed);
    expect(withOfficialProviderAccess).toHaveBeenCalledTimes(guardsBeforeDisposed);

    discoverProviderModels.mockRejectedValueOnce(new Error(`request exposed ${credential}`));
    const unexpectedFailure = await ipc.invoke(
      CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER,
      'session-1',
      { baseUrl: 'https://api.anthropic.com/v1', credential },
    );
    expect(unexpectedFailure).toMatchObject({
      error: '无法读取当前接口的模型列表。',
      models: [],
      ok: false,
    });
    expect(JSON.stringify(unexpectedFailure)).not.toContain(credential);
    expect(
      JSON.stringify(mainLogger.query({ domain: 'claude-connection', limit: 100 })),
    ).not.toContain(credential);
  });

  it('rejects a pre-aborted provider operation before an access attempt', async () => {
    const { guard, runWithExistingLease, runWithLease } = createProviderAccessGuardHarness();
    const controller = new AbortController();
    const cancellation = new Error('session operation cancelled');
    const operation = vi.fn(() => 'not-started');
    controller.abort(cancellation);

    await expect(
      guard.withAllowed(providerAccessRequest, operation, controller.signal),
    ).rejects.toBe(cancellation);
    expect(operation).not.toHaveBeenCalled();
    expect(runWithLease).not.toHaveBeenCalled();
    expect(runWithExistingLease).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after access waiting and before operation entry', async () => {
    const leaseContext = Object.freeze({});
    const accessEntered = deferred();
    const releaseAccess = deferred();
    const runWithLease = vi.fn(async (_input, _target, operation) => {
      accessEntered.resolve();
      await releaseAccess.promise;
      return operation(allowedProviderAccessResult, leaseContext);
    });
    const guard = new ProviderAccessGuard({
      runWithLease,
    } as unknown as NetworkPreflightService);
    const controller = new AbortController();
    const cancellation = new Error('cancelled while waiting for access');
    const operation = vi.fn(() => 'not-started');

    const guarded = guard.withAllowed(providerAccessRequest, operation, controller.signal);
    await accessEntered.promise;
    controller.abort(cancellation);
    releaseAccess.resolve();

    await expect(guarded).rejects.toBe(cancellation);
    expect(operation).not.toHaveBeenCalled();
    expect(runWithLease).toHaveBeenCalledOnce();
  });

  it('revokes inherited authority on abort but holds the lease until pending work unwinds', async () => {
    const { guard, isLeaseActive, runWithExistingLease, runWithLease } =
      createProviderAccessGuardHarness();
    const controller = new AbortController();
    const cancellation = new Error('cancelled while provider work was pending');
    const continueAfterAbort = deferred();
    const finishOperation = deferred<string>();
    const nestedAttempted = deferred();
    let nestedOutcome!: Promise<CapturedOutcome<string>>;
    const operation = vi.fn(async () => {
      await continueAfterAbort.promise;
      nestedOutcome = captureOutcome(
        guard.withAllowed(providerAccessRequest, () => 'inherited-after-abort'),
      );
      nestedAttempted.resolve();
      return finishOperation.promise;
    });

    const guarded = guard.withAllowed(providerAccessRequest, operation, controller.signal);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    expect(isLeaseActive()).toBe(true);
    let guardedSettled = false;
    void guarded.then(
      () => {
        guardedSettled = true;
      },
      () => {
        guardedSettled = true;
      },
    );

    controller.abort(cancellation);
    continueAfterAbort.resolve();
    await nestedAttempted.promise;
    const nested = await nestedOutcome;
    expect(nested.status).toBe('rejected');
    if (nested.status === 'rejected') {
      expect(nested.reason).toBeInstanceOf(ProviderAccessContextExpiredError);
    }
    await Promise.resolve();
    expect(guardedSettled).toBe(false);
    expect(isLeaseActive()).toBe(true);

    finishOperation.resolve('ignored-after-abort');
    await expect(guarded).rejects.toBe(cancellation);
    expect(isLeaseActive()).toBe(false);
    expect(runWithLease).toHaveBeenCalledOnce();
    expect(runWithExistingLease).not.toHaveBeenCalled();
  });

  it('does not retroactively cancel a custom thenable after logical settlement', async () => {
    const { guard, isLeaseActive } = createProviderAccessGuardHarness();
    const controller = new AbortController();
    const lateCancellation = new Error('too late to cancel');
    const thenable = {
      then: (resolve: (value: string) => void): void => {
        resolve('settled-first');
        controller.abort(lateCancellation);
      },
    };

    const guarded = guard.withAllowed(
      providerAccessRequest,
      () => thenable as PromiseLike<string>,
      controller.signal,
    );
    await expect(guarded).resolves.toBe('settled-first');
    expect(controller.signal.aborted).toBe(true);
    await expect(guarded).resolves.toBe('settled-first');
    expect(isLeaseActive()).toBe(false);
  });

  it('rejects a self-resolving thenable cycle without rereading its getter', async () => {
    const { guard } = createProviderAccessGuardHarness();
    let thenReads = 0;
    const thenable: PromiseLike<string> = Object.defineProperty({}, 'then', {
      get: () => {
        thenReads += 1;
        return (resolve: (value: unknown) => void): void => resolve(thenable);
      },
    }) as unknown as PromiseLike<string>;

    await expect(guard.withAllowed(providerAccessRequest, () => thenable)).rejects.toThrow(
      'PromiseLike 解析链包含循环',
    );
    expect(thenReads).toBe(1);
  });

  it('assimilates PromiseLike operations once and expires inherited authority after settlement', async () => {
    const allowedResult = {
      action: 'first-request',
      featureAccess: [{ action: 'first-request', allowed: true, reason: 'allowed' }],
      status: 'allowed',
    } as unknown as NetworkPreflightResult;
    const leaseContext = Object.freeze({});
    let leaseActive = false;
    const runWithLease = vi.fn(async (_input, _target, operation) => {
      leaseActive = true;
      try {
        return await operation(allowedResult, leaseContext);
      } finally {
        leaseActive = false;
      }
    });
    const runWithExistingLease = vi.fn(async (_input, _target, context, operation) => {
      expect(context).toBe(leaseContext);
      expect(leaseActive).toBe(true);
      return await operation(allowedResult, leaseContext);
    });
    const guard = new ProviderAccessGuard({
      runWithExistingLease,
      runWithLease,
    } as unknown as NetworkPreflightService);
    const request = {
      action: 'first-request' as const,
      cwd: 'D:\\Main-Owned\\Project',
      networkScope: 'application' as const,
      provider: 'anthropic-claude' as const,
      target: { process: 'application' as const, url: 'https://api.anthropic.com/v1/models' },
    };
    let thenReads = 0;
    let resolveLate!: (value: unknown) => void;
    let rejectLate!: (reason?: unknown) => void;
    const lateUse = new Promise((resolve, reject) => {
      resolveLate = resolve;
      rejectLate = reject;
    });
    const thenable = Object.defineProperty({}, 'then', {
      get: () => {
        thenReads += 1;
        if (thenReads > 1) {
          throw new Error('then getter read twice');
        }
        return (resolve: (value: string) => void, reject: (reason?: unknown) => void) => {
          setTimeout(() => {
            void guard.withAllowed(request, () => 'late').then(resolveLate, rejectLate);
          }, 0);
          void guard.withAllowed(request, () => 'nested').then(resolve, reject);
        };
      },
    });

    await expect(guard.withAllowed(request, () => thenable as PromiseLike<string>)).resolves.toBe(
      'nested',
    );
    expect(thenReads).toBe(1);
    expect(runWithLease).toHaveBeenCalledOnce();
    expect(runWithExistingLease).toHaveBeenCalledOnce();
    expect(leaseActive).toBe(false);
    await expect(lateUse).rejects.toBeInstanceOf(ProviderAccessContextExpiredError);
    expect(runWithLease).toHaveBeenCalledOnce();
    expect(runWithExistingLease).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)(
    'revokes inherited authority before forwarding a custom thenable %s',
    async (settlement) => {
      const { guard, runWithExistingLease, runWithLease } = createProviderAccessGuardHarness();
      const rootError = new Error('root rejected');
      let nestedOutcome!: Promise<CapturedOutcome<string>>;
      const thenable = {
        then: (resolve: (value: string) => void, reject: (reason: unknown) => void) => {
          if (settlement === 'resolve') resolve('done');
          else reject(rootError);
          nestedOutcome = captureOutcome(
            guard.withAllowed(providerAccessRequest, () => 'inherited-after-settlement'),
          );
        },
      };

      const rootOutcome = await captureOutcome(
        guard.withAllowed(providerAccessRequest, () => thenable as PromiseLike<string>),
      );
      if (settlement === 'resolve') {
        expect(rootOutcome).toEqual({ status: 'fulfilled', value: 'done' });
      } else {
        expect(rootOutcome).toEqual({ reason: rootError, status: 'rejected' });
      }
      const nested = await nestedOutcome;
      expect(nested.status).toBe('rejected');
      if (nested.status === 'rejected') {
        expect(nested.reason).toBeInstanceOf(ProviderAccessContextExpiredError);
      }
      expect(runWithLease).toHaveBeenCalledOnce();
      expect(runWithExistingLease).not.toHaveBeenCalled();
    },
  );

  it('accepts only the first thenable settlement and ignores later signals and throws', async () => {
    const { guard, runWithExistingLease } = createProviderAccessGuardHarness();
    const ignoredError = new Error('ignored after resolve');
    let nestedOutcome!: Promise<CapturedOutcome<string>>;
    const thenable = {
      then: (resolve: (value: string) => void, reject: (reason: unknown) => void): void => {
        resolve('first');
        resolve('second');
        reject(ignoredError);
        nestedOutcome = captureOutcome(
          guard.withAllowed(providerAccessRequest, () => 'inherited-after-second-resolve'),
        );
        throw ignoredError;
      },
    };

    await expect(
      guard.withAllowed(providerAccessRequest, () => thenable as PromiseLike<string>),
    ).resolves.toBe('first');
    const nested = await nestedOutcome;
    expect(nested.status).toBe('rejected');
    if (nested.status === 'rejected') {
      expect(nested.reason).toBeInstanceOf(ProviderAccessContextExpiredError);
    }
    expect(runWithExistingLease).not.toHaveBeenCalled();
  });

  it.each(['getter', 'body'] as const)(
    'revokes authority when a thenable %s throws before settlement',
    async (failurePoint) => {
      const { guard, runWithExistingLease, runWithLease } = createProviderAccessGuardHarness();
      const thenableError = new Error(`then ${failurePoint} failed`);
      let getterReads = 0;
      let bodyCalls = 0;
      const thenable = Object.defineProperty({}, 'then', {
        get: () => {
          getterReads += 1;
          if (failurePoint === 'getter') throw thenableError;
          return (): void => {
            bodyCalls += 1;
            throw thenableError;
          };
        },
      });

      const outcome = await captureOutcome(
        guard.withAllowed(providerAccessRequest, () => thenable as PromiseLike<string>),
      );
      expect(outcome).toEqual({ reason: thenableError, status: 'rejected' });
      expect(getterReads).toBe(1);
      expect(bodyCalls).toBe(failurePoint === 'body' ? 1 : 0);
      expect(runWithLease).toHaveBeenCalledOnce();
      expect(runWithExistingLease).not.toHaveBeenCalled();
    },
  );

  it('assimilates a cross-realm thenable with one getter read and the correct receiver', async () => {
    const { guard, runWithExistingLease } = createProviderAccessGuardHarness();
    const state: { reads: number; receiver?: unknown } = { reads: 0 };
    let nestedOutcome!: Promise<CapturedOutcome<string>>;
    const thenable = runInNewContext(
      `
        const thenable = {
          get then() {
            state.reads += 1;
            return function (resolve) {
              state.receiver = this;
              resolve('cross-realm');
              nested();
            };
          },
        };
        thenable;
      `,
      {
        nested: () => {
          nestedOutcome = captureOutcome(
            guard.withAllowed(providerAccessRequest, () => 'cross-realm-late'),
          );
        },
        state,
      },
    ) as PromiseLike<string>;

    await expect(guard.withAllowed(providerAccessRequest, () => thenable)).resolves.toBe(
      'cross-realm',
    );
    expect(state.reads).toBe(1);
    expect(state.receiver).toBe(thenable);
    const nested = await nestedOutcome;
    expect(nested.status).toBe('rejected');
    if (nested.status === 'rejected') {
      expect(nested.reason).toBeInstanceOf(ProviderAccessContextExpiredError);
    }
    expect(runWithExistingLease).not.toHaveBeenCalled();
  });

  it.each(['executor', 'timer'] as const)(
    'rejects native Promise %s reentry immediately after resolve',
    async (source) => {
      const { guard, runWithExistingLease } = createProviderAccessGuardHarness();
      let nestedOutcome!: Promise<CapturedOutcome<string>>;
      const root = guard.withAllowed(
        providerAccessRequest,
        () =>
          new Promise<string>((resolve) => {
            const settle = (): void => {
              resolve('done');
              nestedOutcome = captureOutcome(
                guard.withAllowed(providerAccessRequest, () => `${source}-late`),
              );
            };
            if (source === 'timer') setTimeout(settle, 0);
            else settle();
          }),
      );

      await expect(root).resolves.toBe('done');
      const nested = await nestedOutcome;
      expect(nested.status).toBe('rejected');
      if (nested.status === 'rejected') {
        expect(nested.reason).toBeInstanceOf(ProviderAccessContextExpiredError);
      }
      expect(runWithExistingLease).not.toHaveBeenCalled();
    },
  );

  it('rejects an inherited microtask queued before native Promise assimilation', async () => {
    const { guard, runWithExistingLease } = createProviderAccessGuardHarness();
    let nestedOutcome!: Promise<CapturedOutcome<string>>;
    const root = guard.withAllowed(providerAccessRequest, () => {
      queueMicrotask(() => {
        nestedOutcome = captureOutcome(
          guard.withAllowed(providerAccessRequest, () => 'queued-microtask-late'),
        );
      });
      return Promise.resolve('done');
    });

    await expect(root).resolves.toBe('done');
    const nested = await nestedOutcome;
    expect(nested.status).toBe('rejected');
    if (nested.status === 'rejected') {
      expect(nested.reason).toBeInstanceOf(ProviderAccessContextExpiredError);
    }
    expect(runWithExistingLease).not.toHaveBeenCalled();
  });

  it('keeps authority through a pending adopted PromiseLike until its logical settlement', async () => {
    const { guard, runWithExistingLease, runWithLease } = createProviderAccessGuardHarness();
    let resolveAdopted!: (value: string) => void;
    let adoptedThenReads = 0;
    const adopted = Object.defineProperty({}, 'then', {
      get: () => {
        adoptedThenReads += 1;
        return (resolve: (value: string) => void): void => {
          resolveAdopted = resolve;
        };
      },
    }) as unknown as PromiseLike<string>;
    let nestedOutcome!: Promise<CapturedOutcome<string>>;
    const thenable = {
      then: (resolve: (value: PromiseLike<string>) => void) => {
        resolve(adopted);
        nestedOutcome = captureOutcome(
          guard.withAllowed(providerAccessRequest, () => {
            resolveAdopted('adopted-result');
            return 'nested-before-adopted-settlement';
          }),
        );
      },
    };

    await expect(
      guard.withAllowed(providerAccessRequest, () => thenable as unknown as PromiseLike<string>),
    ).resolves.toBe('adopted-result');
    await expect(nestedOutcome).resolves.toEqual({
      status: 'fulfilled',
      value: 'nested-before-adopted-settlement',
    });
    expect(adoptedThenReads).toBe(1);
    expect(runWithLease).toHaveBeenCalledOnce();
    expect(runWithExistingLease).toHaveBeenCalledOnce();
  });
});
