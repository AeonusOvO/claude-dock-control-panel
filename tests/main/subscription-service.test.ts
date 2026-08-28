import { describe, expect, it, vi } from 'vitest';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import {
  SubscriptionService,
  type SubscriptionServiceDependencies,
} from '../../src/main/subscriptions/service';
import type { SubscriptionRelay } from '../../src/main/subscriptions/relay';
import type { SubscriptionCredential } from '../../src/main/subscriptions/catalog';
import type { SubscriptionState } from '../../src/shared/contracts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const credential = (): SubscriptionCredential => ({
  provider: 'kimi-subscription',
  accessToken: 'private-access',
  refreshToken: 'private-refresh',
  expiresAt: Date.now() + 900000,
});

const fixture = () => {
  const states: SubscriptionState[] = [];
  const release = vi.fn();
  const relay = {
    ensureRunning: vi.fn(async () => undefined),
    addCandidate: vi.fn((credential: SubscriptionCredential) => ({
      id: 'a'.repeat(32),
      clientKey: 'local-secret',
      credential,
    })),
    baseUrl: vi.fn(() => `http://127.0.0.1:18520/s/${'a'.repeat(32)}`),
    discoverModels: vi.fn(async () => ['kimi-for-coding']),
    persist: vi.fn(),
    discard: vi.fn(),
    shutdown: vi.fn(),
    shutdownForQuit: vi.fn(async () => undefined),
  };
  const runtime = {
    reserveNextConversationConnection: vi.fn(() => ({ token: Symbol(), release })),
    getSoftwareUpdates: vi.fn(async () => ({ claudeCode: { installed: true } })),
    installOrUpdateClaudeCode: vi.fn(),
    verifyAndSaveNextConversationConfig: vi.fn<
      ReturnType<SubscriptionServiceDependencies['runtime']>['verifyAndSaveNextConversationConfig']
    >(async (_input, _retry, options) => {
      options?.beforeCommit?.();
      return {
        connectionTest: { ok: true, message: '', stages: [], testedAt: 1, tone: 'success' },
        state: {},
      };
    }),
  };
  const authorize = vi.fn<NonNullable<SubscriptionServiceDependencies['authorize']>>(async () =>
    credential(),
  );
  const assertAllowed = vi.fn();
  const busy = new BusyRegistry(() => undefined);
  const service = new SubscriptionService({
    relay: relay as unknown as SubscriptionRelay,
    runtime: () => runtime as unknown as ReturnType<SubscriptionServiceDependencies['runtime']>,
    authNetwork: { fetch: vi.fn(), network: async (_url, operation) => operation() },
    busyRegistry: busy,
    open: vi.fn(),
    publish: (value) => states.push(value),
    authorize,
    assertAllowed,
  });
  return { service, runtime, relay, authorize, states, release, assertAllowed, busy };
};

describe('subscription connection transaction', () => {
  it('joins duplicate clicks, rejects another provider, and commits only after the exact test', async () => {
    const { service, authorize, relay, runtime, states, release } = fixture();
    const gate = deferred<SubscriptionCredential>();
    authorize.mockImplementation(() => gate.promise);
    const first = service.setup('kimi-subscription');
    expect(service.setup('kimi-subscription')).toBe(first);
    const competing = await service.setup('minimax-subscription-cn');
    expect(competing.ok).toBe(false);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    gate.resolve(credential());
    expect((await first).ok).toBe(true);
    expect(runtime.verifyAndSaveNextConversationConfig).toHaveBeenCalledOnce();
    expect(relay.persist).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(JSON.stringify(states)).not.toMatch(/private-access|private-refresh|local-secret|http:/);
    expect(states.every((value, i) => i === 0 || value.revision > states[i - 1]!.revision)).toBe(
      true,
    );
  });

  it('drains cancellation and discards a late authorization without changing the old configuration', async () => {
    const { service, authorize, relay, runtime, release } = fixture();
    const gate = deferred<SubscriptionCredential>();
    authorize.mockImplementationOnce(() => gate.promise);
    const first = service.setup('kimi-subscription');
    await vi.waitFor(() => expect(service.getState().cancellable).toBe(true));
    const attempt = service.getState().attempt!;
    const cancelling = service.cancel(attempt);
    expect((await service.setup('glm-subscription-cn')).ok).toBe(false);
    gate.resolve(credential());
    expect((await first).ok).toBe(false);
    expect((await cancelling).ok).toBe(true);
    expect(relay.addCandidate).not.toHaveBeenCalled();
    expect(runtime.verifyAndSaveNextConversationConfig).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    const next = service.setup('kimi-subscription');
    expect((await service.cancel(attempt)).ok).toBe(false);
    expect((await next).ok).toBe(true);
  });

  it('does not save candidate credentials or replace a profile after a failed real test', async () => {
    const { service, runtime, relay } = fixture();
    runtime.verifyAndSaveNextConversationConfig.mockResolvedValueOnce({
      connectionTest: { ok: false, message: 'failed', testedAt: 1, stages: [], tone: 'error' },
      state: {},
    });
    expect((await service.setup('kimi-subscription')).ok).toBe(false);
    expect(relay.persist).not.toHaveBeenCalled();
    expect(relay.discard).toHaveBeenCalledWith('a'.repeat(32));
  });

  it('does not start authorization when another next-conversation writer owns the config', async () => {
    const { service, runtime, authorize, relay } = fixture();
    runtime.reserveNextConversationConnection.mockImplementationOnce(() => {
      throw new Error('busy');
    });
    expect((await service.setup('kimi-subscription')).message).toContain('已有接入操作');
    expect(authorize).not.toHaveBeenCalled();
    expect(relay.ensureRunning).not.toHaveBeenCalled();
  });

  it('revokes admission and ignores a late provider result during application shutdown', async () => {
    const { service, authorize, relay } = fixture();
    const gate = deferred<SubscriptionCredential>();
    authorize.mockImplementation(() => gate.promise);
    const pending = service.setup('kimi-subscription');
    await vi.waitFor(() => expect(service.getState().cancellable).toBe(true));
    service.shutdown();
    gate.resolve(credential());
    expect((await pending).ok).toBe(false);
    await service.shutdownForQuit();
    expect(relay.persist).not.toHaveBeenCalled();
    expect((await service.setup('kimi-subscription')).ok).toBe(false);
  });
});
